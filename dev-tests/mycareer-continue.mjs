// Continue on the mycareernet info tab: fullscreen -> agree -> start (or
// resume) -> dismiss modal -> advance questions until coding UI shows.
const PORT = process.env.CDP_PORT || 9333;
const MAX_STEPS = Number(process.argv[2] || 35);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('/assessment/#/assess/info/'));
if (!page) throw new Error('no info tab found: ' + list.filter(t => t.type === 'page').map(t => t.url).join(' | '));
console.log('using tab:', page.id, page.url.slice(0, 90));

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function evaljs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text };
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
  if (btn && !btn.__err) await clickAt(btn);
  return btn;
}

await send('Page.enable');
await send('Runtime.enable');

let fs = null;
for (let i = 0; i < 8 && !fs; i++) { fs = await findAndClick('/full screen/i'); if (!fs) await sleep(1500); }
console.log('fullscreen:', JSON.stringify(fs));
await sleep(3000);

await evaljs(`(() => { const c = document.querySelector('input[type=checkbox]'); if (c && !c.checked) c.click(); return !!c; })()`);
await sleep(700);

let start = await findAndClick('/start test|resume/i');
console.log('start:', JSON.stringify(start));
await sleep(8000);

for (let i = 0; i < 4; i++) {
  const cont = await findAndClick('/^continue$/i');
  if (cont) console.log('dismissed:', JSON.stringify(cont));
  await sleep(1500);
}

let questionNo = 0;
for (let i = 0; i < MAX_STEPS; i++) {
  const state = await evaljs(`(() => {
    const m = (document.body.innerText || '').match(/QUESTION:\s*(\d+)/);
    const q = m ? +m[1] : 0;
    const editors = document.querySelectorAll('textarea,.monaco-editor,.cm-editor,[contenteditable="true"]').length;
    const frames = document.querySelectorAll('iframe').length;
    return { q, editors, frames, url: location.href };
  })()`);
  console.log(`step ${i}: q=${state.q} editors=${state.editors} frames=${state.frames} ${state.url.slice(0, 70)}`);
  if (state.q && state.q !== questionNo) questionNo = state.q;
  if (state.editors > 0 || state.frames > 0) { console.log('CODING UI REACHED'); break; }
  const next = await findAndClick('/next question/i');
  if (!next) { console.log('no Next button — stopping'); break; }
  await sleep(900);
}

const final = await evaljs(`(() => ({
  url: location.href,
  body: (document.body.innerText || '').slice(0, 350).replace(/\\s+/g, ' '),
  editors: document.querySelectorAll('textarea,.monaco-editor,.cm-editor,[contenteditable="true"]').length,
  frames: document.querySelectorAll('iframe').length
}))()`);
console.log('FINAL:', JSON.stringify(final, null, 1));
ws.close();
