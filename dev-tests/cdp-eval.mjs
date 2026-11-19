// Temporary: navigate, evaluate an expression, optionally screenshot.
// usage: node dev-tests/cdp-eval.mjs <url> <waitMs> '<expr>' [shot.png]
import fs from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;
const [url, waitMs, expr, shotPath] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method) events.push(m);
});
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
if (url && url !== '-') {
  await send('Page.navigate', { url });
  await sleep(Number(waitMs || 6000));
}
if (expr && expr !== '-') {
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(res.result.value ?? res.result ?? res.exceptionDetails, null, 2));
}
const errs = events.filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
if (errs.length) {
  console.log('--- errors ---');
  for (const e of errs.slice(0, 15)) console.log(JSON.stringify(e.params).slice(0, 300));
}
if (shotPath && shotPath !== '-') {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('screenshot: ' + shotPath);
}
ws.close();
