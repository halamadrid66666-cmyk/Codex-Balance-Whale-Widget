import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WINDOW_LABELS = new Map([[300, '5 小时'], [10080, '周']]);

export function quotaFromAppServer(response, observedAt = Date.now()) {
  const limits = response?.rateLimitsByLimitId?.codex || response?.rateLimits;
  const windows = [];
  for (const slot of ['primary', 'secondary']) {
    const item = limits?.[slot];
    const minutes = item?.windowDurationMins;
    if (!WINDOW_LABELS.has(minutes) || typeof item.usedPercent !== 'number' ||
        !Number.isFinite(item.usedPercent) || item.usedPercent < 0 || item.usedPercent > 100) continue;
    const reset = typeof item.resetsAt === 'number' && Number.isFinite(item.resetsAt)
      ? (item.resetsAt < 1e12 ? item.resetsAt * 1000 : item.resetsAt) : null;
    windows.push({ label: WINDOW_LABELS.get(minutes), windowDurationMins: minutes,
      usedPercent: item.usedPercent, remainingPercent: 100 - item.usedPercent,
      resetsAt: reset, observedAt, stale: reset === null || reset <= observedAt });
  }
  return windows;
}

export function findCodexExecutable(env = process.env) {
  if (env.CODEX_CLI_PATH && fs.existsSync(env.CODEX_CLI_PATH)) return env.CODEX_CLI_PATH;
  if (process.platform !== 'win32') return 'codex';
  const bin = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  try {
    const dirs = fs.readdirSync(bin, { withFileTypes: true }).filter(entry => entry.isDirectory());
    dirs.sort((a, b) => fs.statSync(path.join(bin, b.name)).mtimeMs - fs.statSync(path.join(bin, a.name)).mtimeMs);
    for (const entry of dirs) {
      const candidate = path.join(bin, entry.name, 'codex.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return 'codex';
}

// codex-cli 0.120.0 起 `app-server --stdio` 被移除，换成了 `--listen stdio://`
// （stdio 本身就是默认值）。旧写法会让 CLI 直接报 unexpected argument 并以
// 退出码 2 结束，表现为额度永远读不出来。这里按顺序尝试各写法，命中就记住，
// 避免每次刷新都先白起一次进程。
const APP_SERVER_ARG_FORMS = [
  ['app-server', '--listen', 'stdio://'],
  ['app-server', '--stdio'],
];
// executable -> 已验证可用的写法下标。codex 升级后自然失效并重新探测。
const workingArgs = new Map();

// 只有「CLI 拒绝了参数」才值得换写法重试。没登录、网络不通这类真实失败
// 重试只会白等一个完整超时，所以按 stderr 特征精确区分。
function looksLikeArgsRejected(stderr) {
  return /unexpected argument|unrecognized (?:option|argument)|unknown option|invalid value .* for/i.test(String(stderr || ''));
}

function readRateLimitsOnce({ codexHome, executable, timeoutMs, spawnImpl, signal }, argsIndex) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Codex 额度查询已取消'));
    let stderr = '';
    const child = spawnImpl(executable, APP_SERVER_ARG_FORMS[argsIndex], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
    });
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.setEncoding?.('utf8');
      child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
    }
    let settled = false, buffer = '';
    const finish = (error, value, meta) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      child.stdin.destroy();
      child.kill();
      if (error) { if (meta) error.argsRejected = meta.argsRejected; reject(error); } else resolve(value);
    };
    const send = message => { if (!settled && child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); };
    const onAbort = () => finish(new Error('Codex 额度查询已取消'));
    const timeout = setTimeout(() => finish(new Error('Codex 额度查询超时')), timeoutMs);
    timeout.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.once('close', () => {
      const rejected = looksLikeArgsRejected(stderr);
      // finish 的签名是 (error, value, meta)，meta 必须在第三位。
      finish(new Error(rejected ? 'Codex 额度查询参数不被当前版本支持' : 'Codex 额度查询已结束'), undefined, { argsRejected: rejected });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) return finish(new Error('Codex 额度响应过大'));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error('Codex 初始化失败'));
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (message.id === 2) {
          if (message.error || !message.result) return finish(new Error('Codex 额度不可用'));
          return finish(null, { windows: quotaFromAppServer(message.result), observedAt: Date.now(),
            planType: message.result.rateLimitsByLimitId?.codex?.planType || message.result.rateLimits?.planType || null });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: {
      name: 'codex_whale_widget', title: 'Codex Whale Widget', version: '0.3.0',
    } } });
  });
}

export async function readCodexRateLimits(options = {}) {
  // 旧签名里的默认值随解构一起去掉了，这里补回来。
  const executable = options.executable ?? findCodexExecutable();
  const resolved = {
    codexHome: options.codexHome,
    executable,
    timeoutMs: options.timeoutMs ?? 6000,
    spawnImpl: options.spawnImpl ?? spawn,
    signal: options.signal,
  };
  const known = workingArgs.get(executable);
  const order = known == null
    ? APP_SERVER_ARG_FORMS.map((_, index) => index)
    : [known, ...APP_SERVER_ARG_FORMS.map((_, index) => index).filter(index => index !== known)];
  let lastError;
  for (const index of order) {
    try {
      const value = await readRateLimitsOnce(resolved, index);
      workingArgs.set(executable, index);
      return value;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // 参数被拒才换下一种写法；其它失败原样抛出，避免白等一个完整超时。
      if (!error?.argsRejected) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error('Codex 额度不可用');
}

// 仅供测试：清掉「哪种写法可用」的缓存。
export function resetCodexRateLimitsArgsCache() { workingArgs.clear(); }
