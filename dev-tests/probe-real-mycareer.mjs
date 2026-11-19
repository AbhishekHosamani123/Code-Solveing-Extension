// Navigate the CDP test browser (with CodeSolve extension loaded) to the real
// MyCareerNet practice-assessments page and report what the extension sees:
// widget state, page structure, editor detection, console errors.
// usage: node dev-tests/probe-real-mycareer.mjs [url] [waitMs] [shot.png]
const PORT = process.env.CDP_PORT || 9333;
const URL_TO_OPEN = process.argv[2] ||
  'https://mycareernet.co/mycareernet/practice-assessments?utm_source=chatgpt.com';
const WAIT_MS = Number(process.argv[3] || 30000);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) throw new Error('no page target');

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
await send('Page.navigate', { url: URL_TO_OPEN });
await sleep(WAIT_MS);

const probe = `(() => {
  const out = {};
  out.finalUrl = location.href;
  out.title = document.title;
  out.ready = document.readyState;
  out.inner = innerWidth + 'x' + innerHeight;

  const host = document.getElementById('codesolve-chat-host');
  out.hostExists = !!host;
  if (host) {
    const cs = getComputedStyle(host);
    out.hostDisplay = cs.display;
    out.hostZ = cs.zIndex;
    out.hostParent = host.parentNode && host.parentNode.tagName;
    const sr = host.shadowRoot;
    out.shadowRoot = !!sr;
    if (sr) {
      const card = sr.querySelector('.chatcard');
      const bubble = sr.querySelector('.bubble');
      out.card = !!card;
      out.bubble = !!bubble;
      if (card) {
        const r = card.getBoundingClientRect();
        out.cardRect = Math.round(r.width) + 'x' + Math.round(r.height) + ' @ ' + Math.round(r.left) + ',' + Math.round(r.top);
        out.cardHidden = card.classList.contains('hidden');
      }
      if (bubble) {
        const r = bubble.getBoundingClientRect();
        out.bubbleRect = Math.round(r.width) + 'x' + Math.round(r.height);
        out.bubbleHidden = bubble.classList.contains('hidden');
      }
    }
  }

  // What does the page itself look like around the problem/editor area?
  out.frameCount = window.frames.length;
  const editors = [];
  document.querySelectorAll('textarea').forEach(t => editors.push('textarea'));
  document.querySelectorAll('.monaco-editor').forEach(() => editors.push('monaco'));
  document.querySelectorAll('.cm-editor').forEach(() => editors.push('cm6'));
  document.querySelectorAll('[contenteditable="true"]').forEach(() => editors.push('contenteditable'));
  out.editors = editors;
  out.bodyTextLen = (document.body.innerText || '').length;
  out.bodySample = (document.body.innerText || '').slice(0, 300).replace(/\\s+/g, ' ');
  out.iframes = Array.from(document.querySelectorAll('iframe')).map(f => f.src || '(srcdoc)').slice(0, 8);
  out.hasPortalLayer = !!document.querySelector('#portal-layer');
  out.maxZ = (() => {
    let m = 0, el = null;
    document.querySelectorAll('*').forEach(e => {
      const z = parseInt(getComputedStyle(e).zIndex, 10);
      if (!isNaN(z) && z > m) { m = z; el = e.tagName + '.' + (e.className || '').toString().slice(0, 40); }
    });
    return m + ' on ' + el;
  })();
  return out;
})()`;

const res = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
console.log('PROBE:', JSON.stringify(res.result && res.result.value, null, 1));

const errors = events.filter(e =>
  (e.method === 'Runtime.exceptionThrown') ||
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
);
const rel = errors.filter(e => {
  const s = JSON.stringify(e).toLowerCase();
  return s.includes('codesolve') || s.includes('content.js') || s.includes('typer') || s.includes('monaco') || s.includes('capture');
});
console.log('errors total:', errors.length, '| extension-related:', rel.length);
for (const e of rel.slice(0, 5)) {
  const p = e.params || {};
  const d = p.exceptionDetails || p.entry || {};
  console.log('  *', JSON.stringify(d).slice(0, 400));
}

const shotPath = process.argv[4];
if (shotPath) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('screenshot: ' + shotPath);
}
ws.close();
