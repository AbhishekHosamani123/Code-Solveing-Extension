// Reproduce the coding-question state: resume -> fullscreen -> start ->
// advance through MCQs -> cross into the Generic Coding group -> then deep-
// inspect the editor geometry and CodeSolve editor detection. Reports key
// diagnostics as JSON lines.
const PORT = process.env.CDP_PORT || 9333;
const DETAIL_URL = 'https://mycareernet.co/mycareernet/practice-assessments/Programming-Fundamentals-20';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- browser-level helpers (for popup capture) ----
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browserWs = new WebSocket(version.webSocketDebuggerUrl);
let bid = 0; const bpend = new Map(); const newTargets = [];
browserWs.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && bpend.has(m.id)) { const p = bpend.get(m.id); bpend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  else if (m.method === 'Target.targetCreated') newTargets.push(m.params.targetInfo);
});
await new Promise(r => browserWs.addEventListener('open', r, { once: true }));
const bsend = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++bid; bpend.set(mid, { resolve, reject }); browserWs.send(JSON.stringify({ id: mid, method, params })); });
await bsend('Target.setDiscoverTargets', { discover: true });

function pageTargets() { return fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).then(l => l.filter(t => t.type === 'page')); }
async function waitFor(pred, timeoutMs = 25000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await pred();
    if (v) return v;
    await sleep(700);
  }
  throw new Error('timeout waiting for ' + label);
}

function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const contexts = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
  });
  return new Promise(r => ws.addEventListener('open', () => r({
    ws,
    contexts,
    isoCtx: contexts.find(c => c.auxData && c.auxData.type === 'isolated' && (c.origin || '').includes('chrome-extension://')),
    send: (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); }),
  }), { once: true }));
}
async function clickBtn(sesh, re, tries = 14, gap = 1500) {
  for (let i = 0; i < tries; i++) {
    const r = await sesh.send('Runtime.evaluate', { expression: `(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => ${re}.test((x.innerText||'').trim()));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: (b.innerText||'').trim().slice(0,40) };
    })()`, returnByValue: true });
    const btn = r.result && r.result.value;
    if (btn) {
      await sesh.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
      await sesh.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
      await sesh.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
      return btn;
    }
    await sleep(gap);
  }
  return null;
}

// ---- 1. click Resume on a detail tab ----
const detailPage = (await pageTargets()).find(t => t.url.includes('practice-assessments/Programming-Fundamentals-20'));
if (!detailPage) throw new Error('no detail tab');
const detailSesh = await attach(detailPage.webSocketDebuggerUrl);
await detailSesh.send('Runtime.enable');
const resume = await clickBtn(detailSesh, '/resume/i', 6, 1200);
console.log('resume:', JSON.stringify(resume));

// ---- 2. watch for the auth popup tab ----
const infoTarget = await waitFor(async () => {
  const pages = await pageTargets();
  return pages.find(t => t.url.includes('/assessment/#/assess/')) || null;
}, 20000, 'assessment tab');
console.log('assessmentTab:', infoTarget.url.slice(0, 80));

// ---- 3. info page -> fullscreen -> agree -> start ----
const aSesh = await attach(infoTarget.webSocketDebuggerUrl);
await aSesh.send('Runtime.enable');
await aSesh.send('Page.enable');
const fs = await clickBtn(aSesh, '/full screen/i', 12, 1500);
console.log('fs:', JSON.stringify(fs));
await sleep(3500);
await aSesh.send('Runtime.evaluate', { expression: `(() => { const c = document.querySelector('input[type=checkbox]'); if (c && !c.checked) c.click(); return true; })()` });
await sleep(700);
const st = await clickBtn(aSesh, '/start test|resume/i', 6, 1500);
console.log('start:', JSON.stringify(st));
await sleep(9000);
for (let i = 0; i < 4; i++) {
  const c = await clickBtn(aSesh, '/^continue$/i', 3, 1200);
  if (c) { console.log('dismissed:', JSON.stringify(c)); }
  await sleep(1200);
}

await waitFor(async () => (await pageTargets()).some(t => t.url.includes('/assessment/#/assess/test/')), 20000, 'test route');
console.log('in test');

// ---- 4. advance to coding group ----
const testPage = (await pageTargets()).find(t => t.url.includes('/assessment/#/assess/test/'));
const tSesh = await attach(testPage.webSocketDebuggerUrl);
await tSesh.send('Runtime.enable');
await tSesh.send('Page.enable');

let movedToCoding = false;
for (let i = 0; i < 40 && !movedToCoding; i++) {
  const r = await tSesh.send('Runtime.evaluate', { expression: `(() => {
    const txt = document.body.innerText || '';
    const modal = /Take me to the next group/.test(txt);
    const qm = txt.match(/QUESTION:\s*(\d+)/);
    const editors = document.querySelectorAll('textarea,.monaco-editor,.cm-editor,[contenteditable="true"]').length;
    return { modal, q: qm ? +qm[1] : 0, editors };
  })()`, returnByValue: true });
  const s = r.result && r.result.value;
  if (s.modal) {
    const go = await clickBtn(tSesh, '/take me to the next group/i', 4, 1000);
    console.log('next-group click:', JSON.stringify(go));
    await sleep(6000);
    movedToCoding = true;
    break;
  }
  if (s.editors > 0 && s.q >= 26) { movedToCoding = true; break; }
  const nx = await clickBtn(tSesh, '/next question/i', 4, 1000);
  if (!nx) { console.log('no next; stopping'); break; }
  await sleep(800);
}
console.log('movedToCoding:', movedToCoding);

// ---- 5. deep editor + extension diagnostics ----
await sleep(3000);
const diag = await tSesh.send('Runtime.evaluate', { expression: `(() => {
  const out = {};
  out.url = location.href;
  out.body = (document.body.innerText || '').slice(0, 240).replace(/\\s+/g, ' ');
  const areas = Array.from(document.querySelectorAll('textarea')).map(t => {
    const r = t.getBoundingClientRect();
    const cs = getComputedStyle(t);
    let up = '';
    let node = t.parentElement;
    for (let k = 0; k < 4 && node; k++) { up += node.tagName + '.' + String((node.className || '').toString()).slice(0, 40) + ' > '; node = node.parentElement; }
    return {
      id: t.id || '', cls: (t.className || '').toString().slice(0, 60),
      rect: Math.round(r.width) + 'x' + Math.round(r.height) + ' @ ' + Math.round(r.left) + ',' + Math.round(r.top),
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity, z: cs.zIndex,
      readOnly: t.readOnly, disabled: t.disabled, valueLen: (t.value || '').length,
      chain: up
    };
  });
  out.areas = areas;
  out.cm = document.querySelectorAll('.cm-editor').length;
  out.monaco = document.querySelectorAll('.monaco-editor').length;
  out.ace = document.querySelectorAll('.ace_editor').length;
  return out;
})()`, returnByValue: true });
console.log('DIAG:', JSON.stringify(diag.result && diag.result.value, null, 1));

// Isolated-world extension diagnosis.
const isoCtx = tSesh.isoCtx;
if (isoCtx) {
  const iso = await tSesh.send('Runtime.evaluate', { expression: `(() => {
    const dbg = window.__codesolveDebug;
    const ty = window.__codesolveTyper;
    const out = { hasDebug: !!dbg, hasTyper: !!ty };
    if (ty) {
      try { const ed = ty.findEditor(); out.findEditor = ed ? ed.tagName + '#' + (ed.id||'') : null; } catch (e) { out.findEditor = 'ERR ' + e.message; }
    }
    if (dbg) {
      const safe = (fn) => { try { return String(fn() == null ? '' : fn()); } catch (e) { return 'ERR ' + e.message; } };
      out.detectLanguage = safe(() => dbg.detectLanguage());
      out.readEditorText = safe(() => dbg.readEditorText());
      out.extractProblemLen = safe(() => (dbg.extractProblem() || '').length);
    }
    return out;
  })()`, contextId: isoCtx.id, returnByValue: true });
  console.log('ISO:', JSON.stringify(iso.result && iso.result.value, null, 1));
} else {
  console.log('no isolated ctx captured');
}
tSesh.ws.close();
browserWs.close();
