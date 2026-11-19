// Diagnose why the mycareernet assessment SPA renders only the header:
// reloads the page target and reports network failures, exceptions, and the
// final DOM state after up to N seconds.
const PORT = process.env.CDP_PORT || 9333;
const WAIT_MS = Number(process.argv[2] || 15000);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const events = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  else if (m.method) events.push(m);
});
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(WAIT_MS);

const res = await send('Runtime.evaluate', { expression: `(() => {
  const out = {};
  out.url = location.href;
  out.body = (document.body.innerText || '').slice(0, 300).replace(/\\s+/g, ' ');
  out.buttons = Array.from(document.querySelectorAll('button')).map(b => (b.innerText||'').trim().slice(0,40)).filter(Boolean);
  out.angScope = typeof angular !== 'undefined' ? (angular.element(document.body).scope() ? 'yes' : 'no-scope') : 'no-angular';
  return out;
})()`, returnByValue: true });
console.log('STATE:', JSON.stringify(res.result && res.result.value, null, 1));

const netFail = events.filter(e => e.method === 'Network.loadingFailed' || (e.method === 'Network.responseReceived' && e.params.response.status >= 400));
console.log('network failures:', netFail.length);
for (const e of netFail.slice(0, 15)) {
  const p = e.params;
  if (e.method === 'Network.loadingFailed') console.log('  FAIL', p.type, p.errorText, (p.requestId || ''));
  else console.log('  HTTP', p.response.status, p.response.url.slice(0, 110));
}
const exc = events.filter(e => e.method === 'Runtime.exceptionThrown');
console.log('exceptions:', exc.length);
for (const e of exc.slice(0, 8)) {
  const d = e.params.exceptionDetails;
  console.log('  *', d.text, '|', (d.exception && d.exception.description || '').slice(0, 220));
}
ws.close();
