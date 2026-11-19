// Minimal, fast repro: resume -> entry -> cross to coding -> snapshot DOM +
// extension diagnostics within seconds. Uses real clicks; prints flushed.
const PORT = process.env.CDP_PORT || 9333;
const DETAIL_URL = 'https://mycareernet.co/mycareernet/practice-assessments/Programming-Fundamentals-20';
const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browserWs = new WebSocket(version.webSocketDebuggerUrl);
let bid = 0; const bpend = new Map();
browserWs.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && bpend.has(m.id)) { const p = bpend.get(m.id); bpend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
await new Promise(r => browserWs.addEventListener('open', r, { once: true }));
const bsend = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++bid; bpend.set(mid, { resolve, reject }); browserWs.send(JSON.stringify({ id: mid, method, params })); });
await bsend('Target.setDiscoverTargets', { discover: true });

const pageTargets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).then(l => l.filter(t => t.type === 'page'));
async function waitFor(pred, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await pred();
    if (v) return v;
    await sleep(600);
  }
  throw new Error('timeout: ' + label);
}
function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const contexts = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === 'Runtime.executionContextCreated') contexts.push(m.params.context);
  });
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('attach timeout')), 8000);
    ws.addEventListener('open', () => { clearTimeout(to); resolve({
      ws, contexts,
      isoCtx: contexts.find(c => c.auxData && c.auxData.type === 'isolated' && (c.origin || '').includes('chrome-extension://')),
      send: (method, params = {}) => new Promise((resolve2, reject2) => { const mid = ++id; pending.set(mid, { resolve: resolve2, reject: reject2 }); ws.send(JSON.stringify({ id: mid, method, params })); }),
    }); }, { once: true });
  });
}
async function clickBtn(sesh, re, tries = 10, gap = 1300) {
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

// 1. resume from a detail tab
const detailPage = (await pageTargets()).find(t => t.url.includes('practice-assessments/Programming-Fundamentals-20'));
if (!detailPage) throw new Error('no detail tab');
const dSesh = await attach(detailPage.webSocketDebuggerUrl);
await dSesh.send('Runtime.enable');
const resume = await clickBtn(dSesh, '/resume/i', 5, 1200);
log('resume:', JSON.stringify(resume));

const infoTarget = await waitFor(async () => (await pageTargets()).find(t => t.url.includes('/assessment/#/assess/')) || null, 20000, 'assessment tab');
log('assessmentTab:', infoTarget.url.slice(0, 80));

const aSesh = await attach(infoTarget.webSocketDebuggerUrl);
await aSesh.send('Runtime.enable');
await aSesh.send('Page.enable');
const fs = await clickBtn(aSesh, '/full screen/i', 12, 1500);
log('fs:', JSON.stringify(fs));
await sleep(3000);
await aSesh.send('Runtime.evaluate', { expression: `(() => { const c = document.querySelector('input[type=checkbox]'); if (c && !c.checked) c.click(); return true; })()` });
await sleep(600);
const st = await clickBtn(aSesh, '/start test|resume/i', 5, 1500);
log('start:', JSON.stringify(st));
await sleep(9000);
for (let i = 0; i < 3; i++) {
  const c = await clickBtn(aSesh, '/^continue$/i', 3, 1100);
  if (c) log('dismissed:', JSON.stringify(c));
  await sleep(1100);
}
await waitFor(async () => (await pageTargets()).some(t => t.url.includes('/assessment/#/assess/test/')), 20000, 'test route');
log('in test');

const testPage = (await pageTargets()).find(t => t.url.includes('/assessment/#/assess/test/'));
const tSesh = await attach(testPage.webSocketDebuggerUrl);
await tSesh.send('Runtime.enable');
await tSesh.send('Page.enable');
log('test tab attached');

let coding = false;
for (let i = 0; i < 40 && !coding; i++) {
  let q = 0;
  let modal = false;
  let editors = 0;
  try {
    const r = await tSesh.send('Runtime.evaluate', { expression: `(() => {
      const txt = document.body.innerText || '';
      const qm = txt.match(/QUESTION:\s*(\d+)/);
      return {
        modal: /Take me to the next group/.test(txt),
        q: qm ? +qm[1] : 0,
        editors: document.querySelectorAll('textarea,.monaco-editor,.cm-editor,[contenteditable="true"]').length
      };
    })()`, returnByValue: true });
    const s = r.result && r.result.value || {};
    q = s.q; modal = s.modal; editors = s.editors;
  } catch (e) { log('adv eval err', e.message); }
  if (modal) {
    const go = await clickBtn(tSesh, '/take me to the next group/i', 4, 1000);
    log('cross-group:', JSON.stringify(go));
    await sleep(5000);
    coding = true;
    break;
  }
  if (editors > 0 && q >= 26) { coding = true; break; }
  const nx = await clickBtn(tSesh, '/next question/i', 3, 900);
  if (!nx) { log('no next; abort'); break; }
  await sleep(700);
}
log('coding:', coding);

await sleep(2500);

// DOM snapshot
try {
  const r = await tSesh.send('Runtime.evaluate', { expression: `(() => {
    const out = {};
    out.url = location.href;
    out.body = (document.body.innerText || '').slice(0, 200).replace(/\\s+/g, ' ');
    out.areas = Array.from(document.querySelectorAll('textarea')).map(t => {
      const r = t.getBoundingClientRect();
      const cs = getComputedStyle(t);
      let chain = '';
      let node = t.parentElement;
      for (let k = 0; k < 4 && node; k++) { chain += node.tagName + '.' + String((node.className || '').toString()).slice(0, 40) + ' > '; node = node.parentElement; }
      return {
        id: t.id || '', cls: (t.className || '').toString().slice(0, 60),
        rect: Math.round(r.width) + 'x' + Math.round(r.height) + ' @ ' + Math.round(r.left) + ',' + Math.round(r.top),
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity, z: cs.zIndex,
        readOnly: t.readOnly, disabled: t.disabled, valueLen: (t.value || '').length,
        chain
      };
    });
    out.cm = document.querySelectorAll('.cm-editor').length;
    out.monaco = document.querySelectorAll('.monaco-editor').length;
    out.ace = document.querySelectorAll('.ace_editor').length;
    return out;
  })()`, returnByValue: true });
  log('DOM:', JSON.stringify(r.result && r.result.value, null, 1));
} catch (e) { log('dom err', e.message); }

// Isolated-world extension diagnosis
if (tSesh.isoCtx) {
  try {
    const rr = await tSesh.send('Runtime.evaluate', { expression: `(() => {
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
    })()`, contextId: tSesh.isoCtx.id, returnByValue: true });
    log('ISO:', JSON.stringify(rr.result && rr.result.value, null, 1));
  } catch (e) { log('iso err', e.message); }
} else {
  log('no iso ctx');
}
tSesh.ws.close();
browserWs.close();
process.exit(0);
