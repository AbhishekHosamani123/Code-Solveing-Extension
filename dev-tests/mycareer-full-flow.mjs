// Full mycareernet flow: navigate the existing page target to a practice-
// assessment detail page, click Start Test (real click), go fullscreen, agree,
// start, dismiss any alert, then advance through questions until a coding
// editor appears (or max steps).
const PORT = process.env.CDP_PORT || 9333;
const DETAIL_URL = 'https://mycareernet.co/mycareernet/practice-assessments/Programming-Fundamentals-20';
const MAX_STEPS = Number(process.argv[2] || 30);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) throw new Error('no page target');
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
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text + ': ' + ((r.exceptionDetails.exception || {}).description || '') };
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
await send('Page.navigate', { url: DETAIL_URL });
await sleep(9000);

let start = await findAndClick('/start test/i');
console.log('start@detail:', JSON.stringify(start));
await sleep(6000);

// We may now be on the info page (same tab) -> fullscreen -> agree -> start
let fs = null;
for (let i = 0; i < 8 && !fs; i++) { fs = await findAndClick('/full screen/i'); if (!fs) await sleep(1500); }
console.log('fullscreen:', JSON.stringify(fs));
await sleep(3000);

await evaljs(`(() => { const c = document.querySelector('input[type=checkbox]'); if (c && !c.checked) c.click(); return !!c; })()`);
await sleep(700);

let start2 = await findAndClick('/start test/i');
console.log('start@info:', JSON.stringify(start2));
await sleep(7000);

for (let i = 0; i < 4; i++) {
  const cont = await findAndClick('/^continue$/i');
  if (cont) console.log('dismissed:', JSON.stringify(cont));
  await sleep(1500);
}

// Advance.
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

const final = await evaljs(`(() => {
  const out = {};
  out.url = location.href;
  out.body = (document.body.innerText || '').slice(0, 400).replace(/\\s+/g, ' ');
  out.editors = document.querySelectorAll('textarea,.monaco-editor,.cm-editor,[contenteditable="true"]').length;
  out.frames = document.querySelectorAll('iframe').length;
  return out;
})()`);
console.log('FINAL:', JSON.stringify(final, null, 1));
ws.close();
