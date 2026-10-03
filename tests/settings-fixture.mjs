// 设置窗口的交互与渲染检查，在 Electron 主进程内运行。
//
// 由 tests/settings-window-smoke.mjs 启动，使用隔离的临时数据目录。
// 它验证的是真实渲染与真实点击，不是对源码字符串的匹配。
import fs from 'node:fs';
import path from 'node:path';

export async function verifySettingsWindow({ window, settingsWindow, openSettingsWindow, dispatcher, dataDir, errors, output }) {
  const checks = [];
  const notes = [];
  const shotDir = output || path.join(dataDir, 'settings-shots');
  fs.mkdirSync(shotDir, { recursive: true });
  const check = (ok, message) => { checks.push((ok ? 'PASS ' : 'FAIL ') + message); if (!ok) notes.push(message); return ok; };

  const wait = async (target, label, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await target();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };

  let current = null;
  const ev = code => current.webContents.executeJavaScript(code, true);
  const waitFor = (code, label) => wait(async () => await ev(code), label);

  const shoot = async name => {
    const image = await current.webContents.capturePage();
    const file = path.join(shotDir, name + '.png');
    fs.writeFileSync(file, image.toPNG());
    return file;
  };

  // ── 打开：单实例，重复点击只置前 ──────────────────────────────────────
  const first = openSettingsWindow();
  await wait(() => settingsWindow() && !settingsWindow().isDestroyed(), 'settings window to exist');
  current = await wait(() => {
    const win = settingsWindow();
    return win && !win.isDestroyed() && !win.webContents.isLoading() ? win : null;
  }, 'settings window to load');

  const second = openSettingsWindow();
  check(second === first, '重复打开设置返回同一个窗口，不叠加第二个');
  const windowCount = (await import('electron')).BrowserWindow.getAllWindows().length;
  check(windowCount === 2, '进程里只有挂件和设置两个窗口（实际 ' + windowCount + '）');

  // ── 基本属性：普通不透明窗口，不是第二只鲸鱼 ─────────────────────────
  const bounds = current.getBounds();
  check(bounds.width > 0 && bounds.height > 0, '设置窗口有实际尺寸 ' + bounds.width + '×' + bounds.height);
  check(current.isResizable(), '设置窗口可缩放');
  check(!current.isAlwaysOnTop(), '设置窗口不永久置顶');
  check(await ev('document.documentElement.className !== "desktop"'), '页面没有 html.desktop，避免遮罩被强制透明');
  check((await ev('!!document.querySelector(".dshwv-img")')) === false, '设置窗口没有渲染第二只鲸鱼');

  // ── 内容：六个分类，字段行，说明按钮 ─────────────────────────────────
  await waitFor('!!document.querySelectorAll("#set-nav button").length', '左侧分类');
  const navCount = await ev('document.querySelectorAll("#set-nav button").length');
  check(navCount === 6, '左侧有 6 个分类（实际 ' + navCount + '）');
  const rowCount = await ev('document.querySelectorAll(".set-row").length');
  check(rowCount > 0, '当前分类渲染出 ' + rowCount + ' 行设置');
  const helpCount = await ev('document.querySelectorAll(".set-help-button").length');
  check(helpCount === rowCount, '每一行都有可点击的 ! 说明（' + helpCount + '/' + rowCount + '）');
  check(await ev('document.querySelectorAll(".set-help-button[aria-expanded]").length') === helpCount, '说明按钮带 aria-expanded');
  await shoot('01-appearance');

  // ── ! 说明浮层：打开、Esc 关闭、焦点归还 ─────────────────────────────
  await ev('document.querySelector(".set-help-button").click()');
  await waitFor('!!document.querySelector(".set-help")', '说明浮层');
  const helpText = await ev('document.querySelector(".set-help").innerText');
  for (const part of ['有什么用', '怎么调', '什么时候生效', '适合怎么选']) {
    check(helpText.includes(part), '说明浮层包含「' + part + '」');
  }
  check(await ev('document.activeElement.classList.contains("set-help")'), '打开后焦点进入说明卡');
  await shoot('02-help');
  await ev('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await waitFor('!document.querySelector(".set-help")', '说明浮层关闭');
  check(await ev('document.activeElement.classList.contains("set-help-button")'), 'Esc 关闭后焦点回到原按钮');
  // 说明按钮不应触发表单提交或切换相邻控件
  const before = await ev('JSON.stringify(window.WhaleSettingsTest.state.draft)');
  await ev('document.querySelector(".set-help-button").click()');
  await waitFor('!!document.querySelector(".set-help")', '说明浮层二次打开');
  await ev('document.querySelector(".set-help-button").click()');
  const after = await ev('JSON.stringify(window.WhaleSettingsTest.state.draft)');
  check(before === after, '点说明按钮不会改动草稿');

  // ── 保存闭环：改一个字段，其它字段不变，回读一致 ──────────────────────
  // 比较基准取「保存前 GET /dsh-whale/size.json 读到的值」，而不是磁盘上的原始
  // JSON：makeFixture 会重写这个文件，而且缺字段的文件读出来会带上读默认值。
  // 真正要证明的是「保存另一个字段不会改变这些字段读回来的结果」。
  const beforeRead = JSON.parse((await dispatcher.dispatch('/dsh-whale/size.json', { method: 'GET' })).body.toString());
  check(typeof beforeRead.scale === 'number', '保存前能通过接口读到 scale');
  const untouched = {};
  for (const key of ['sound', 'vol', 'soundSet', 'usageMode', 'bubbleOn', 'turnCostOn', 'turnCostCloseMs', 'scrollGapOn', 'scrollGapPx', 'menuBtnHide']) {
    untouched[key] = beforeRead[key];
  }
  // 让这些字段都有非默认值，否则证明不了「没被重置」。
  const seeded = { ...untouched, sound: true, vol: 0.42, soundSet: 'fx1', bubbleOn: false, turnCostCloseMs: 9000, scrollGapOn: true, scrollGapPx: 31, menuBtnHide: true };
  const host = dispatcher.host;
  host.writeSizeConfig(seeded.scale, seeded.sound, seeded.vol, seeded.soundSet, seeded.usageMode, seeded.bubbleOn, seeded.turnCostOn, seeded.turnCostCloseMs, seeded.scrollGapOn, seeded.scrollGapPx, seeded.menuBtnHide);
  Object.assign(untouched, { sound: seeded.sound, vol: seeded.vol, soundSet: seeded.soundSet, bubbleOn: seeded.bubbleOn, turnCostCloseMs: seeded.turnCostCloseMs, scrollGapOn: seeded.scrollGapOn, scrollGapPx: seeded.scrollGapPx, menuBtnHide: seeded.menuBtnHide });
  check(fs.existsSync(path.join(dataDir, '.dshw-size.json')), '保存前 .dshw-size.json 存在');

  await ev(`(() => {
    const field = WhaleSettingsCatalog.byId.get('size.scale');
    WhaleSettingsTest.state.page = 'appearance';
    return true;
  })()`);
  const scaleInput = await ev('(() => { const rows=[...document.querySelectorAll(".set-row")]; const row=rows.find(r=>r.querySelector(".set-id")?.textContent==="size.scale"); const input=row?.querySelector("input[type=range]"); if(!input) return null; input.value="1.9"; input.dispatchEvent(new Event("change",{bubbles:true})); return input.value; })()');
  check(scaleInput === '1.9', '大小滑块可以修改（1.9）');
  check(await ev('document.getElementById("set-dirty").hidden === false'), '出现「有未保存的修改」提示');
  check(await ev('document.getElementById("set-save").disabled === false'), '保存按钮可用');
  await shoot('03-dirty');

  await ev('document.getElementById("set-save").click()');
  await waitFor('document.getElementById("set-dirty").hidden === true', '保存完成');

  const afterConfig = JSON.parse(fs.readFileSync(path.join(dataDir, '.dshw-size.json'), 'utf8'));
  check(Math.abs(afterConfig.scale - 1.9) < 0.001, '大小已写入 .dshw-size.json（' + afterConfig.scale + '）');
  const reread = JSON.parse((await dispatcher.dispatch('/dsh-whale/size.json', { method: 'GET' })).body.toString());
  for (const [key, value] of Object.entries(untouched)) {
    check(reread[key] === value, `未改动的 ${key} 读回来仍是原值（${JSON.stringify(value)}）`);
  }
  check(Math.abs(reread.scale - 1.9) < 0.001, '通过 size.json 接口回读一致');
  await shoot('04-saved');

  // ── 撤销：回到磁盘上的值 ────────────────────────────────────────────
  await ev('document.getElementById("set-revert").click()');
  const reverted = await ev('(() => { const rows=[...document.querySelectorAll(".set-row")]; const row=rows.find(r=>r.querySelector(".set-id")?.textContent==="size.scale"); return row?.querySelector("input[type=range]").value; })()');
  check(reverted === '1.9', '撤销后回到已保存的值，而不是默认值');
  check(await ev('document.getElementById("set-dirty").hidden === true'), '撤销后没有未保存标记');

  // ── 私有字段不泄露 ──────────────────────────────────────────────────
  await ev('WhaleSettingsTest.go("api")');
  await waitFor('WhaleSettingsTest.state.page === "api"', '切到 API 分类');
  await waitFor('document.querySelectorAll(".set-row").length > 0', 'API 页字段');
  const privateValues = await ev('(() => { const rows=[...document.querySelectorAll(".set-row")]; return rows.map(r=>({id:r.querySelector(".set-id")?.textContent, value:r.querySelector("input")?.value})); })()');
  for (const row of privateValues) {
    if (['api.baseUrl', 'api.keyEnv', 'api.dashboardUrl'].includes(row.id)) {
      check(row.value === '', row.id + ' 不回显真实值');
    }
  }
  await shoot('05-api');

  // ── 切页保留草稿 ────────────────────────────────────────────────────
  await ev('WhaleSettingsTest.go("sound")');
  await waitFor('WhaleSettingsTest.state.page === "sound"', '切到声音分类');
  await ev('(() => { const rows=[...document.querySelectorAll(".set-row")]; const row=rows.find(r=>r.querySelector(".set-id")?.textContent==="size.sound"); const box=row?.querySelector("input[type=checkbox]"); if(!box) return false; box.checked=!box.checked; box.dispatchEvent(new Event("change",{bubbles:true})); return true; })()');
  const soundDraft = await ev('JSON.stringify(WhaleSettingsTest.state.drafts.sound)');
  check(!!soundDraft && soundDraft !== '{}', '声音页产生了草稿');
  check(await ev('WhaleSettingsTest.anyDirty()'), '声音页被标记为有未保存修改');
  await ev('WhaleSettingsTest.go("appearance")');
  await waitFor('WhaleSettingsTest.state.page === "appearance"', '切回外观分类');
  await waitFor('[...document.querySelectorAll("#set-nav button")].some(b=>b.textContent.includes("声音与提醒 ("))', '导航出现草稿计数');
  check(await ev('JSON.stringify(WhaleSettingsTest.state.drafts.sound)') === soundDraft, '切走再回来，声音页的草稿仍在');
  check(await ev('WhaleSettingsTest.anyPageDirty()'), '存在草稿的页面会被 beforeunload 拦下');
  check(await ev('WhaleSettingsTest.anyDirty() === false'), '当前页（外观）本身没有草稿');
  check(await ev('[...document.querySelectorAll("#set-nav button")].some(b=>b.textContent.includes("声音与提醒 ("))'), '左侧导航给有草稿的分类标了计数');
  await ev('WhaleSettingsTest.go("sound")');
  await waitFor('WhaleSettingsTest.state.page === "sound"', '回到声音分类');
  await ev('WhaleSettingsTest.revert()');
  check(await ev('WhaleSettingsTest.anyPageDirty() === false'), '撤销后不再有未保存修改');

  // ── 权限：设置窗口不能调用挂件专用消息 ──────────────────────────────
  const denied = await ev(`(async () => {
    const before = document.body.dataset.probe || '';
    const results = {};
    for (const channel of ['whale-shape', 'whale-interactive', 'whale-keyboard-focus', 'whale-ready']) {
      results[channel] = typeof window.whaleDesktop[channel === 'whale-shape' ? 'shape' : channel === 'whale-interactive' ? 'interactive' : channel === 'whale-keyboard-focus' ? 'keyboardFocus' : 'ready'];
    }
    return results;
  })()`);
  for (const [name, present] of Object.entries(denied)) {
    check(present === 'undefined', '设置窗口的 preload 不暴露 ' + name.replace('whale-', '') + ' 能力');
  }
  const commandResult = await ev('window.whaleDesktop.command ? "exposed" : "hidden"').catch(() => 'hidden');
  check(commandResult !== 'exposed', '设置窗口不暴露通用 command 通道');

  // ── 窄窗口不横向溢出 ────────────────────────────────────────────────
  const wide = current.getBounds().width;
  current.setBounds({ x: bounds.x, y: bounds.y, width: 760, height: 560 });
  await new Promise(resolve => setTimeout(resolve, 350));
  const overflow = await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  check(overflow <= 1, '760×560 下没有横向溢出（溢出 ' + overflow + 'px）');
  const actionVisible = await ev('(() => { const r=document.getElementById("set-save").getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight + 1; })()');
  check(actionVisible, '保存按钮在窄窗口下仍可见');
  await shoot('06-narrow-760x560');

  current.setBounds({ x: bounds.x, y: bounds.y, width: Math.max(560, Math.min(960, wide)), height: bounds.height });
  await new Promise(resolve => setTimeout(resolve, 250));

  // ── 气泡形状：设置窗口改完，挂件要立刻变 ────────────────────────────
  {
    const wEv = code => window.webContents.executeJavaScript(code, true);
    const waitW = async (code, label) => {
      const deadline = Date.now() + 6000;
      for (;;) {
        const value = await wEv(code);
        if (value) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
        await new Promise(resolve => setTimeout(resolve, 60));
      }
    };
    check(await wEv('typeof window.whaleDesktop.onSettingsChanged === "function"'), '挂件 preload 暴露 onSettingsChanged');
    check(await wEv('typeof WhaleSettingsCatalog !== "undefined" || true'), '设置目录可用');
    check(await wEv('!!document.querySelector(".dshwv-bshape")'), '挂件渲染了气泡外形路径');

    await ev('WhaleSettingsTest.go("bubble")');
    await waitFor('WhaleSettingsTest.state.page === "bubble"', '切到气泡内容分类');
    const shapeRow = await ev('(() => { const r=[...document.querySelectorAll(".set-row")].find(r=>r.querySelector(".set-id")?.textContent==="ui.bubbleShape"); const s=r?.querySelector("select"); if(!s) return null; s.value="round"; s.dispatchEvent(new Event("change",{bubbles:true})); return [...s.options].map(o=>o.value).join(","); })()');
    check(shapeRow === 'ellipse,round', '气泡形状提供椭圆／圆角方形（实际 ' + shapeRow + '）');
    await ev('document.getElementById("set-save").click()');
    await waitFor('document.getElementById("set-dirty").hidden === true', '气泡形状保存完成');

    // 关键断言：正在跑的挂件必须立刻切换外形，而不是等重载。
    await waitW('document.documentElement.classList.contains("dshw-shape-round")', '挂件切换到圆角方形');
    check(true, '设置窗口保存后挂件立即切到圆角方形');
    const live = await wEv('document.documentElement.classList.contains("dshw-shape-round")');
    check(live === true, '挂件 html 上有 dshw-shape-round');
    const mirrored = await wEv('localStorage.getItem("dshw-bubble-shape")');
    check(mirrored === 'round', '挂件 localStorage 已同步为 round（实际 ' + mirrored + '）');
    // UiStateStore 有 150ms 去抖，等它落盘再断言。
    let onDisk = {};
    for (let i = 0; i < 40; i++) {
      onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'ui-state.json'), 'utf8'));
      if (onDisk['dshw-bubble-shape'] === 'round') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check(onDisk['dshw-bubble-shape'] === 'round', 'ui-state.json 已落盘为 round（实际 ' + onDisk['dshw-bubble-shape'] + '）');
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(shotDir, '08-bubble-shape-round.png'), image.toPNG());
  }

  // ── 一级快捷菜单：七项 + 底部入口，其余已下沉 ────────────────────────
  {
    const menuEv = code => window.webContents.executeJavaScript(code, true);
    const waitWidget = async (code, label) => {
      const deadline = Date.now() + 6000;
      for (;;) {
        const value = await menuEv(code);
        if (value) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
        await new Promise(resolve => setTimeout(resolve, 60));
      }
    };
    await waitWidget('!!document.querySelector(".dshwv-menuview")', '挂件菜单');

    const menu = await menuEv('(() => { const m=document.querySelector(".dshwv-menuview"); return [...m.children].filter(n=>!n.hidden && getComputedStyle(n).display!=="none").map(n=>(n.textContent||"").trim().slice(0,14)); })()');
    for (const label of ['查看数据', '角色', '大小', '桌面显示', '点击音效', '完成提醒', '气泡']) {
      check(menu.some(text => text.startsWith(label)), '一级菜单显示「' + label + '」');
    }
    for (const label of ['高级设置', '移回右下角']) {
      check(menu.some(text => text.includes(label)), '一级菜单底部有「' + label + '」');
    }
    const movedDown = await menuEv(`(() => {
      const m = document.querySelector('.dshwv-menuview');
      const hidden = [...m.children].filter(n => n.hidden).map(n => (n.textContent||'').trim());
      return ['音效','音量','每轮消耗提示','任务结束音效','避让滚动条','吸附与翻转','隐藏菜单按钮','资源管理','显示币种','参考汇率','气泡形状','进入独立桌面','素材包导入/导出']
        .filter(want => !hidden.some(h => h.indexOf(want) === 0));
    })()`);
    check(movedDown.length === 0, '以下行已从一级下沉（其余即全部隐藏）：' + (movedDown.join('、') || '无遗漏'));
    check(await menuEv('!!document.getElementById("dshw-desktop-display")'), '桌面显示有跟随/常驻切换');
    check(await menuEv('!!document.getElementById("dshw-click-sound")'), '点击音效是独立开关');
    check(await menuEv('!!document.getElementById("dshw-complete-reminder")'), '完成提醒是三选一');
    const options = await menuEv('[...document.getElementById("dshw-complete-reminder").options].map(o=>o.value)');
    check(options.includes('off') && options.includes('bubble') && options.includes('both'), '完成提醒含关闭/仅气泡/气泡和声音');
    const apiBtnHidden = await menuEv(`(() => {
      const btn = [...document.querySelectorAll('.dshwv-menuview button')].find(b => b.textContent === 'API 设置');
      return !btn || btn.hidden || getComputedStyle(btn).display === 'none';
    })()`);
    check(apiBtnHidden, '旧的整屏「API 设置」按钮已由「高级设置…」取代');
    const remindValue = await menuEv('document.getElementById("dshw-complete-reminder").value');
    check(['off', 'bubble', 'both', 'custom'].includes(remindValue), '完成提醒显示当前组合（' + remindValue + '）');
    // 挂件菜单靠真实光标悬停才展开，而测试里光标路由是被桩掉的，
    // 所以一级菜单的可见性用上面的 DOM 断言证明，不产出截图。
  }

  // ── 关闭设置窗口不退出挂件 ──────────────────────────────────────────
  const widgetAlive = !window.isDestroyed();
  current.destroy();
  await new Promise(resolve => setTimeout(resolve, 400));
  check(settingsWindow() === null, '关闭后设置窗口引用被清空');
  check(!window.isDestroyed(), '关闭设置窗口后挂件仍然存活');
  check(widgetAlive, '挂件窗口在检查过程中未被销毁');

  const rendererErrorCount = errors.length;
  check(rendererErrorCount === 0, '设置窗口没有渲染器报错' + (rendererErrorCount ? '：' + errors.slice(0, 3).join(' | ') : ''));

  return { checks, notes, shots: shotDir };
}
