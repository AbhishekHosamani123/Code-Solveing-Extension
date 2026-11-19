// Load an unpacked extension into the CDP test browser by driving the
// chrome://extensions "Load unpacked" flow (recent stable Chrome ignores
// --load-extension / --disable-extensions-except entirely).
// usage: node dev-tests/cdp-load-extension.mjs <abs-extension-dir>
const PORT = process.env.CDP_PORT || 9333;
const EXT_DIR = process.argv[2] || 'D:/Code-Solve-Extension';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const waiters = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Page.fileChooserOpened') {
    for (const w of waiters.splice(0)) w(m.params);
  }
});
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nextChooser = () => new Promise(r => waiters.push(r));

await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('Page.setInterceptFileChooserDialog', { enabled: true });

// Ensure we are on the extensions manager, chrome WebUI reloads on navigate.
await send('Page.navigate', { url: 'chrome://extensions/' });
await sleep(4500);

// Enable developer mode, then click "Load unpacked" through the shadow DOM.
const clickProbe = `(() => {
  const mgr = document.querySelector('extensions-manager');
  if (!mgr) return { err: 'no manager' };
  const sr = mgr.shadowRoot;
  if (!sr) return { err: 'no manager shadowRoot' };
  const toggle = sr.querySelector('#devMode');
  let devMode = false;
  if (toggle && !toggle.checked) { toggle.click(); devMode = true; }
  // The load-unpacked button moves into the manager toolbar once dev mode is on.
  const btn = (sr.querySelector('extensions-toolbar') || {}).shadowRoot
    ? sr.querySelector('extensions-toolbar').shadowRoot.querySelector('#loadUnpacked')
    : sr.querySelector('#loadUnpacked');
  if (!btn) return { err: 'no load-unpacked button', devModeToggled: devMode, html: sr.innerHTML.slice(0, 300) };
  btn.click();
  return { ok: true, devModeToggled: devMode };
})()`;

const r = await send('Runtime.evaluate', { expression: clickProbe, returnByValue: true });
const clickRes = r.result && r.result.value;
console.log('click result:', JSON.stringify(clickRes));

if (clickRes && clickRes.ok) {
  const chooser = await Promise.race([nextChooser(), sleep(4000).then(() => null)]);
  if (!chooser) {
    console.log('no file chooser event (dialog may be native and not intercepted?)');
  } else {
    console.log('chooser mode:', chooser.mode, 'backendNodeId:', chooser.backendNodeId);
    const setRes = await send('DOM.setFileInputFiles', {
      files: [EXT_DIR],
      backendNodeId: chooser.backendNodeId,
    }).catch(e => ({ error: e.message }));
    console.log('setFileInputFiles:', JSON.stringify(setRes));
    await sleep(3000);
  }
} else {
  console.log('failed to drive UI:', JSON.stringify(clickRes));
}

// Report what is loaded now.
const internals = await send('Runtime.evaluate', {
  expression: `(() => {
    const pre = document.querySelector('pre');
    if (!pre) return { noPre: true };
    try {
      const data = JSON.parse(pre.innerText);
      return data.map(d => ({ id: d.id, name: d.name, path: d.path || '' }));
    } catch (e) { return { parseError: e.message }; }
  })()`,
  returnByValue: true,
});
console.log('extensions now:', JSON.stringify(internals.result && internals.result.value, null, 1));
ws.close();
