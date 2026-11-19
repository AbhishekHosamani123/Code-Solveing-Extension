// Evaluate the CodeSolve content-script debug API (isolated world) on the
// current assessment tab by driving the extension's own service worker via
// chrome.scripting.executeScript. Usage:
//   node dev-tests/probe-extension-api.mjs [urlSubstr]
const PORT = process.env.CDP_PORT || 9333;
const URL_SUBSTR = process.argv[2] || '/assessment/#/assess/test/';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let sw = list.find(t => t.type === 'service_worker' && t.url.includes('background.js') && t.url.includes('lnnndjjfjfikciokpnaooodgmgloeaab'));
if (!sw) {
  // Workers may list with an empty URL; identify CodeSolve by its manifest.
  for (const w of list.filter(t => t.type === 'worker' || (t.type === 'service_worker' && !t.url))) {
    const wws = new WebSocket(w.webSocketDebuggerUrl);
    await new Promise(r => wws.addEventListener('open', r, { once: true }));
    const nm = await new Promise(resolve => {
      wws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) resolve(m.result);
      });
      wws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression: 'chrome.runtime.getManifest().name',
        returnByValue: true
      }}));
    });
    wws.close();
    if (nm.result && nm.result.value === 'CodeSolve AI — Page Chat') { sw = w; break; }
  }
}
if (!sw) throw new Error('codesolve service worker not found');
const ws = new WebSocket(sw.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });

const expr = `(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url && t.url.includes(${JSON.stringify(URL_SUBSTR)}));
    if (!tab) return { error: 'no matching tab', tabs: tabs.map(t => t.url).slice(0, 10) };
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const dbg = window.__codesolveDebug;
        const out = { hasDebug: !!dbg };
        if (!dbg) return out;
        try { out.extractProblem = String(dbg.extractProblem ? dbg.extractProblem() || '' : '').slice(0, 300); } catch (e) { out.extractProblem = 'ERR ' + e.message; }
        try { out.title = String(dbg.extractTitle ? dbg.extractTitle() || '' : '').slice(0, 120); } catch (e) { out.title = 'ERR ' + e.message; }
        try { out.lang = dbg.detectLanguage ? dbg.detectLanguage() : 'no fn'; } catch (e) { out.lang = 'ERR ' + e.message; }
        try { out.editorText = String(dbg.readEditorText ? dbg.readEditorText() || '' : '').slice(0, 200); } catch (e) { out.editorText = 'ERR ' + e.message; }
        try { const ed = dbg.findEditor ? dbg.findEditor() : null; out.editor = ed ? { tag: ed.tagName, id: ed.id || '', cls: (ed.className || '').toString().slice(0, 60) } : null; } catch (e) { out.editor = 'ERR ' + e.message; }
        out.hasHost = !!document.getElementById('codesolve-chat-host');
        return out;
      }
    });
    return res[0] && res[0].result;
  } catch (e) {
    return { error: e.message };
  }
})()`;

const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result && r.result.value, null, 1));
ws.close();
