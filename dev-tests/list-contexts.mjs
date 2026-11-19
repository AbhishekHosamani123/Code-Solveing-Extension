// List all execution contexts of the first page target so we can find the
// content-script isolated world.
const PORT = process.env.CDP_PORT || 9333;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
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
await new Promise(r => setTimeout(r, 1200));
for (const c of contexts) {
  console.log(JSON.stringify({ id: c.id, origin: (c.origin || '').slice(0, 60), name: c.name || '', aux: c.auxData || {} }));
}
ws.close();
