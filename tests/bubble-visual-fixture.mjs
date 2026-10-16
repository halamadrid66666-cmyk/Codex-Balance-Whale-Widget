// 气泡内容展示，在 Electron 主进程内运行。
// 把截图裁切到气泡本身，避开鲸鱼周围的大片空白，方便直接看效果。
import fs from 'node:fs';
import path from 'node:path';

const CASES = [
  { name: '0-订阅额度', modules: [
      { type: 'plan', quotaStyle: 'header', size: 4, bold: true, color: '#53669a', tpl: '{plan_name}' },
      { type: 'quota', quotaStyle: 'meter', windowDurationMins: 300, row: 1 },
      { type: 'quota', quotaStyle: 'meter', windowDurationMins: 10080, row: 1 } ] },
  { name: '1-本轮用量', modules: [
      { type: 'text', text: '本轮任务完成', size: 6, bold: true },
      { type: 'text', text: '12,480 tokens', size: 16, bold: true, color: '#4059b3' },
      { type: 'text', text: '约 ¥0.83 · 32 秒', size: 2, color: '#63719a' } ] },
  { name: '2-余额预警', modules: [
      { type: 'text', text: '老大～你的 API 余额', size: 5, bold: true },
      { type: 'text', text: '已经不足 5.00 啦', size: 6, bold: true, rgb: 'rouge' },
      { type: 'link', text: '打开当前 API 账单', url: '/provider-dashboard', size: 2, color: '#ffffff', bgRgb: 'indigo' } ] },
  { name: '3-长文本', modules: [
      { type: 'text', text: '今天是 2026 年 10 月 3 日星期五，完成了重构与测试', size: 5, bold: true },
      { type: 'text', text: '这一行故意写得很长很长，用来观察内容被压缩的比例', size: 4, color: '#53669a' },
      { type: 'text', text: '短', size: 2, color: '#63719a' } ] },
  { name: '4-每日预算', modules: [
      { type: 'text', text: '今天已观测用量超过', size: 6, bold: true },
      { type: 'text', text: '¥10.00', size: 7, bold: true, rgb: 'rouge' } ] },
];

export async function renderBubbleVisual({ window, app, dataDir, screen, errors = [] }) {
  try { window.setBounds({ x: 40, y: 40, width: 1280, height: 820 }); } catch {}
  const out = process.env.WHALE_DESKTOP_VERIFY_DIR || path.join(dataDir, 'shots');
  fs.mkdirSync(out, { recursive: true });
  const ev = code => window.webContents.executeJavaScript(code, true);
  const rows = [];
  const wait = async (c, l) => { const d = Date.now() + 8000; for (;;) { const v = await ev(c); if (v) return v; if (Date.now() > d) throw new Error('timeout ' + l + '; renderer errors: ' + JSON.stringify(errors.slice(-6))); await new Promise(r => setTimeout(r, 60)); } };
  await wait('!!window.__whaleRenderTest', 'hook');
  try {
    for (const shape of ['ellipse', 'round']) {
      for (const item of CASES) {
        // 先关掉上一场景：切换期间 bubbleRenderModules 会跳过写入，残留旧内容。
        try { await ev('window.__whaleRenderTest && window.__whaleRenderTest.close()'); } catch {}
        await new Promise(r => setTimeout(r, 350));
        // 走真实路径切换：apply 会替换 SVG path 并触发 refit，比只切 class 可靠。
        await ev(`(() => {
          if (!window.WhaleBubbleShape) throw new Error('missing WhaleBubbleShape');
          const applied = window.WhaleBubbleShape.apply(${JSON.stringify(shape)});
          localStorage.setItem('dshw-bubble-shape', applied);
          return applied;
        })()`);
        if (item.real) {
          // 走真实路径：whaleClick 会按当前显示模式弹出默认序列（订阅=两个额度卡）。
          await ev('window.__whaleRenderTest && window.__whaleRenderTest.open()');
        } else {
          await ev(`window.__whaleRenderTest.scene(${JSON.stringify(item.modules)}, 0)`);
        }
        // 等气泡真的打开再量，避免开场动画期间量到旧场景或空场景。
        await wait("!!document.querySelector('.dshwv-pop.dshwv-pop-open')", 'pop open');
        await new Promise(r => setTimeout(r, 500));
        const m = await ev(`(() => {
          const pop = document.querySelector('.dshwv-pop.dshwv-pop-open');
          if (!pop) return null;
          const shape = pop.querySelector('.dshwv-bshape');
          const frame = pop.querySelector('.dshwv-frame');
          if (!shape || !frame) return null;
          const sr = shape.getBoundingClientRect();
          const fr = frame.getBoundingClientRect();
          const fs = getComputedStyle(frame).getPropertyValue('--dshw-fit').trim() || '1';
          // 与 tests/audit-ui-regression.mjs 相同的白色区域包含断言：
          // 每个文本行的四角都必须落在气泡 path 内，不允许裁切或溢出。
          const inverse = shape.getScreenCTM().inverse();
          const inWhite = (x, y) => shape.isPointInFill(new DOMPoint(x, y).matrixTransform(inverse));
          const ranges = [...pop.querySelectorAll('.dshwv-trow')].flatMap(el => {
            const range = document.createRange(); range.selectNodeContents(el);
            return [...range.getClientRects()].filter(r => r.width && r.height).map(r => ({
              text: el.textContent.trim().slice(0, 12),
              insideWhite: [[r.left + .5, r.top + .5], [r.right - .5, r.top + .5], [r.left + .5, r.bottom - .5], [r.right - .5, r.bottom - .5]]
                .every(([x, y]) => inWhite(x, y))
            }));
          });
          const pad = 18;
          return {
            fit: fs,
            bubbleW: Math.round(sr.width), bubbleH: Math.round(sr.height),
            clip: { x: Math.max(0, Math.round(sr.left - pad)), y: Math.max(0, Math.round(sr.top - pad)),
                    width: Math.round(sr.width + pad * 2), height: Math.round(sr.height + pad * 2) },
            contentW: Math.round(fr.width), contentH: Math.round(fr.height),
            ranges,
            contained: ranges.length > 0 && ranges.every(r => r.insideWhite),
            texts: [...pop.querySelectorAll('.dshwv-text *')]
              .filter(n => n.children.length === 0 && n.textContent.trim())
              .slice(0, 8)
              .map(n => ({ t: n.textContent.trim().slice(0, 8), fs: Math.round(parseFloat(getComputedStyle(n).fontSize) * 10) / 10 })),
          };
        })()`);
        if (!m) { rows.push({ name: `${shape} / ${item.name}`, missing: true }); continue; }
        const file = path.join(out, `${shape}-${item.name}.png`);
        fs.writeFileSync(file, (await window.webContents.capturePage(m.clip)).toPNG());
        rows.push({ name: `${shape} / ${item.name}`, ...m, file: path.basename(file) });
      }
    }
  } catch (error) {
    rows.push({ name: 'ERROR', error: String(error && error.message || error) });
  }
  const report = { rows };
  fs.writeFileSync(path.join(out, 'bubble-visual.json'), JSON.stringify(report, null, 2));
  // 几何验收：每个场景的文字都必须整体落在气泡白色区域内。
  const broken = rows.filter(row => row.missing || row.error || row.contained === false);
  report.ok = broken.length === 0;
  try { app.quit(); } catch {}
  return report;
}
