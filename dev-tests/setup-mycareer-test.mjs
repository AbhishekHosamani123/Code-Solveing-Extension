// Start a fresh mycareernet practice assessment in a NEW tab (the previous tab
// was poisoned by a bad hash route). Drives: info → fullscreen → agree →
// Start Test → dismiss fullscreen alert. Real CDP input clicks throughout.
const PORT = process.env.CDP_PORT || 9333;
const INFO_URL = 'https://mycareernet.co/assessment/#/assess/info/mycareernet';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const oldPage = list.find(t => t.type === 'page');
const browserWs = new WebSocket((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
let id = 0; const pending = new Map();
browserWs.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
await new Promise(r => browserWs.addEventListener('open', r, { once: true }));
const bsend = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); browserWs.send(JSON.stringify({ id: mid, method, params })); });

if (oldPage) { await bsend('Target.closeTarget', { targetId: oldPage.id }); }
const { targetId } = await bsend('Target.createTarget', { url: INFO_URL });
console.log('new target:', targetId);
browserWs.close();

const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(4000);

// Attach to the new page.
const list2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list2.find(t => t.type === 'page' && t.id === targetId);
if (!page) throw new Error('new page target not found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let pid = 0; const ppending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && ppending.has(m.id)) { const p = ppending.get(m.id); ppending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++pid; ppending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
async function evaljs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r.result && r.result.value;
}
async function clickAt(btn) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
}
async function findAndClick(re) {
  const btn = await evaljs(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => ${re}.test((x.innerText||'').trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: (b.innerText||'').trim().slice(0,40) };
  })()`);
  if (btn) { await clickAt(btn); }
  return btn;
}

await send('Page.enable');
await send('Runtime.enable');

// 1. Fullscreen button on info page (poll until SPA has rendered).
let fsBtn = null;
for (let i = 0; i < 10 && !fsBtn; i++) {
  fsBtn = await findAndClick('/full screen/i');
  if (!fsBtn) await sleep(1500);
}
console.log('fullscreen button:', JSON.stringify(fsBtn));
await sleep(2500);

// 2. Agree to terms.
const agreed = await evaljs(`(() => {
  const c = document.querySelector('input[type=checkbox]');
  if (c && !c.checked) { c.click(); return true; }
  return false;
})()`);
console.log('agreed:', agreed);
await sleep(500);

// 3. Start Test.
const startBtn = await findAndClick('/start test/i');
console.log('start button:', JSON.stringify(startBtn));
await sleep(6000);

// 4. Dismiss the "could not switch to full screen" alert if present.
let dismissed = false;
for (let i = 0; i < 3 && !dismissed; i++) {
  const cont = await findAndClick('/^continue$/i');
  if (cont) { dismissed = true; console.log('dismissed alert:', JSON.stringify(cont)); }
  await sleep(1500);
}

// 5. Report state.
const state = await evaljs(`(() => {
  const out = {};
  out.url = location.href;
  out.fs = !!document.fullscreenElement;
  out.body = (document.body.innerText || '').slice(0, 300).replace(/\\s+/g, ' ');
  return out;
})()`);
console.log('state:', JSON.stringify(state, null, 1));
ws.close();
