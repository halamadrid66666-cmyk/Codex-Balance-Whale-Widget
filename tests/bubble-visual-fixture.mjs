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

export async function renderBubbleVisual({ window, dataDir, screen }) {
  try { window.setBounds({ x: 40, y: 40, width: 1280, height: 820 }); } catch {}
  const out = process.env.WHALE_DESKTOP_VERIFY_DIR || path.join(dataDir, 'shots');
  fs.mkdirSync(out, { recursive: true });
  const ev = code => window.webContents.executeJavaScript(code, true);
  const rows = [];
  const wait = async (c, l) => { const d = Date.now() + 8000; for (;;) { const v = await ev(c); if (v) return v; if (Date.now() > d) throw new Error('timeout ' + l); await new Promise(r => setTimeout(r, 60)); } };
  await wait('!!window.__whaleRenderTest', 'hook');
  try {
    for (const shape of ['ellipse', 'round']) {
      for (const item of CASES) {
        await ev(`(() => {
          localStorage.setItem('dshw-bubble-shape', ${JSON.stringify(shape)});
          document.documentElement.classList.toggle('dshw-shape-round', ${shape === 'round'});
        })()`);
        if (item.real) {
          // 走真实路径：whaleClick 会按当前显示模式弹出默认序列（订阅=两个额度卡）。
          await ev('window.__whaleRenderTest && window.__whaleRenderTest.open()');
        } else {
          await ev(`window.__whaleRenderTest.scene(${JSON.stringify(item.modules)}, 0)`);
        }
        await new Promise(r => setTimeout(r, 1000));
        const m = await ev(`(() => {
          const pop = document.querySelector('.dshwv-pop.dshwv-pop-open');
          if (!pop) return null;
          const shape = pop.querySelector('.dshwv-bshape');
          const frame = pop.querySelector('.dshwv-frame');
          if (!shape || !frame) return null;
          const sr = shape.getBoundingClientRect();
          const fr = frame.getBoundingClientRect();
          const fs = getComputedStyle(frame).getPropertyValue('--dshw-fit').trim() || '1';
          const pad = 18;
          return {
            fit: fs,
            bubbleW: Math.round(sr.width), bubbleH: Math.round(sr.height),
            clip: { x: Math.max(0, Math.round(sr.left - pad)), y: Math.max(0, Math.round(sr.top - pad)),
                    width: Math.round(sr.width + pad * 2), height: Math.round(sr.height + pad * 2) },
            contentW: Math.round(fr.width), contentH: Math.round(fr.height),
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
  return { rows };
}
