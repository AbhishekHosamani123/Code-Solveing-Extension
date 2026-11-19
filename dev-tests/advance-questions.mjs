// Advance through mycareernet MCQ questions until the coding section is
// reached (or a fail condition). Uses real CDP input clicks so site scripts see
// genuine user activation.
const PORT = process.env.CDP_PORT || 9333;
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
  return r.result && r.result.value;
}
async function clickButton(match) {
  const btn = await evaljs(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => ${match}.test((x.innerText||'').trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: (b.innerText||'').trim().slice(0,40) };
  })()`);
  if (!btn) return null;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  return btn;
}

let questionNo = 0;
for (let i = 0; i < MAX_STEPS; i++) {
  const state = await evaljs(`(() => {
    const m = (document.body.innerText || '').match(/QUESTION:\s*(\d+)/);
    const q = m ? +m[1] : 0;
    const editors = document.querySelectorAll('textarea,.monaco-editor,.cm-editor,[contenteditable="true"]').length;
    const frames = document.querySelectorAll('iframe').length;
    const text = (document.body.innerText || '').slice(0, 300).replace(/\\s+/g, ' ');
    return { q, editors, frames, text };
  })()`);
  console.log(`step ${i}: q=${state.q} editors=${state.editors} frames=${state.frames} | ${state.text.slice(0, 90)}`);
  if (state.q && state.q !== questionNo) { questionNo = state.q; }
  if (state.editors > 0 || state.frames > 0) { console.log('CODING UI REACHED'); break; }
  const next = await clickButton('/next question/i');
  if (!next) { console.log('no Next button — stopping'); break; }
  await sleep(900);
}
ws.close();
