// Evaluate the CodeSolve content-script debug API by targeting the isolated
// world execution context on the assessment tab.
const PORT = process.env.CDP_PORT || 9333;
const URL_SUBSTR = process.argv[2] || '/assessment/#/assess/test/';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes(URL_SUBSTR));
if (!page) throw new Error('no matching page: ' + list.filter(t => t.type === 'page').map(t => t.url).join(' | '));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const contexts = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  else if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
});
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
await send('Runtime.enable');
await new Promise(r => setTimeout(r, 800));

const iso = contexts.find(c => (c.auxData && c.auxData.type === 'isolated') && (c.origin || '').includes('chrome-extension://'));
if (!iso) { console.log('no isolated context: ' + JSON.stringify(contexts)); process.exit(1); }
console.log('isolated context id:', iso.id);

const expr = `(() => {
  const dbg = window.__codesolveDebug;
  const out = { hasDebug: !!dbg, hasHost: !!document.getElementById('codesolve-chat-host') };
  if (!dbg) return out;
  const safe = (fn, name) => { try { const v = fn(); return String(v == null ? '' : v); } catch (e) { return 'ERR ' + e.message; } };
  out.extractProblem = safe(() => (dbg.extractProblem() || '').slice(0, 400));
  out.extractTitle = safe(() => dbg.extractTitle() || '');
  out.detectLanguage = safe(() => dbg.detectLanguage());
  out.readEditorText = safe(() => (dbg.readEditorText() || '').slice(0, 250));
  out.findEditor = safe(() => { const ed = dbg.findEditor(); return ed ? ed.tagName + '#' + (ed.id || '') + '.' + String((ed.className || '').toString()).slice(0, 50) : 'null'; });
  out.collectRegions = safe(() => JSON.stringify(dbg.collectPageRegions ? dbg.collectPageRegions() : []).slice(0, 300));
  return out;
})()`;

const r = await send('Runtime.evaluate', { expression: expr, contextId: iso.id, returnByValue: true });
if (r.exceptionDetails) console.log('EXC:', JSON.stringify(r.exceptionDetails).slice(0, 600));
else console.log(JSON.stringify(r.result && r.result.value, null, 1));
ws.close();
