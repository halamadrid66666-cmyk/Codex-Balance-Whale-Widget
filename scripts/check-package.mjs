import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
for(const name of ['../vendor/smol-toml/dist/index.js','../desktop/main.cjs','../desktop/ui/widget.html','../desktop/ui/gesture.js','../desktop/ui/audio-engine.js','../desktop/ui/insights.js','../desktop/ui/workshop.js','../assets/DSniang1.png']) {
  if(!fs.existsSync(fileURLToPath(new URL(name,import.meta.url))))throw new Error('Package dependency missing: '+name);
}
if(!fs.existsSync(fileURLToPath(new URL('../desktop/ui/account-view.js',import.meta.url))))throw new Error('Account view module is missing');
if(!fs.existsSync(fileURLToPath(new URL('../desktop/ui/shape.js',import.meta.url))))throw new Error('Window region module is missing');
if(!fs.existsSync(fileURLToPath(new URL('../desktop/ui/dashboard.js',import.meta.url))))throw new Error('Dashboard module is missing');

// The settings window is a second page served over the same whale:// scheme, so
// each of its files has to be in the dispatcher's static allowlist as well as on
// disk. A page that exists but is not routed fails silently in the renderer.
const settingsFiles = ['settings.html','settings.css','settings.js','settings-catalog.js','settings-help.js','settings-pages.js'];
const dispatcherSource = fs.readFileSync(fileURLToPath(new URL('../runtime/dispatcher.mjs',import.meta.url)),'utf8');
for(const name of settingsFiles) {
  if(!fs.existsSync(fileURLToPath(new URL('../desktop/ui/'+name,import.meta.url))))throw new Error('Settings window file is missing: '+name);
  if(!dispatcherSource.includes("'"+name+"'"))throw new Error('Settings window file is not routed by the dispatcher: '+name);
}
// The catalog is the single source of truth; if it is stale the settings window
// and docs/CONFIGURATION.md disagree with the running app.
await import('../runtime/dispatcher.mjs');
await import('../runtime/process.mjs');
const {createRequire}=await import('node:module');
createRequire(import.meta.url)('../desktop/settings-store.cjs');
// package.json declares "type": "module", so require() would treat this plain
// browser script as ESM and skip its module.exports branch. Run it in a sandbox
// with an explicit module object, the way tests/settings-catalog.test.mjs does.
const vm=await import('node:vm');
const catalogModule={exports:{}};
vm.runInNewContext(fs.readFileSync(fileURLToPath(new URL('../desktop/ui/settings-catalog.js',import.meta.url)),'utf8'),{module:catalogModule,globalThis:{},console});
const catalog=catalogModule.exports;
const problems=catalog.validate();
if(problems.length)throw new Error('Settings catalog is incomplete:\n'+problems.map(p=>'  '+p.id+' — '+p.problem).join('\n'));
process.stdout.write('Package dependency graph is complete. Settings window: '+settingsFiles.length+' files routed, '+catalog.fields.length+' catalog fields.\n');
