#!/usr/bin/env node
// 气泡内容可读性的人工目视工具。
//
//   node tests/bubble-visual.mjs [输出目录]
//
// 用隔离数据启动真实 Electron，通过 __whaleRenderTest.scene() 渲染几种真实内容，
// 逐个截图，并打印每个气泡的实际缩放比与内容盒尺寸。用来看「字太小」到底
// 是内容被 fit 压缩了，还是内容盒本身设计得太小。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bubble-visual-')));
fs.mkdirSync(output, { recursive: true });

const electron = process.platform === 'darwin'
  ? path.join(process.env.HOME, '.codex/whale-widget/desktop-runtime/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(process.env.HOME, '.codex/whale-widget/desktop-runtime/node_modules/electron/dist/electron.exe');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bubble-visual-data-'));
fs.writeFileSync(path.join(dataDir, '.dshw-size.json'), JSON.stringify({ scale: 1.5, sound: false, vol: 0, bubbleOn: true, turnCostOn: true }));

const env = { ...process.env, WHALE_DESKTOP_TEST: '1', WHALE_BUBBLE_VISUAL: '1', WHALE_DESKTOP_VERIFY_DIR: output, WHALE_INITIAL_HOST: JSON.stringify({ hostAlive: false, serial: 0, mode: 'standalone' }) };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(ROOT, 'desktop', 'main.cjs'), '--whale-data=' + dataDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', c => { stderr += c; });
child.stdout.on('data', () => {});
const code = await new Promise(r => child.on('exit', r));

const reportFile = path.join(output, 'bubble-visual.json');
if (!fs.existsSync(reportFile)) {
  process.stderr.write('没有产出报告，退出码 ' + code + '\n' + stderr.split('\n').slice(-15).join('\n') + '\n');
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
for (const row of report.rows) {
  console.log(`\n${row.name}`);
  console.log(`  缩放 fit=${row.fit}  内容盒=${row.boxW}x${row.boxH}  路径尺寸=${row.pathW}x${row.pathH}  占用=${row.usedPct}`);
}
console.log('\n截图目录：' + output);
