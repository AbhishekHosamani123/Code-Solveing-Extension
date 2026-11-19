// Verify the CodeSolve widget against the hostile-layout mock
// (dev-tests/mock-mycareer.html): portal/overlay layers with max z-index
// injected after mount, plus a stacking-context app wrapper.
// usage: node dev-tests/verify-mycareer.mjs [url] [waitMs]
const PORT = process.env.CDP_PORT || 9333;
const URL_TO_OPEN = process.argv[2] || 'http://127.0.0.1:8899/mock-mycareer.html';
const WAIT_MS = Number(process.argv[3] || 11000);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const exceptions = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails);
  }
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
await send('Page.navigate', { url: URL_TO_OPEN });
await sleep(WAIT_MS);

const probe = `(() => {
  const out = { pass: [], fail: [] };
  const check = (name, ok, detail) => {
    (ok ? out.pass : out.fail).push(name + (detail ? ' — ' + detail : ''));
  };

  const host = document.getElementById('codesolve-chat-host');
  check('host exists', !!host);
  if (!host) return out;
  const sr = host.shadowRoot;
  check('shadowRoot open', !!sr);
  const card = sr && sr.querySelector('.chatcard');
  const bubble = sr && sr.querySelector('.bubble');
  check('card exists', !!card);
  check('bubble exists', !!bubble);
  check('host display != none', getComputedStyle(host).display !== 'none', getComputedStyle(host).display);
  check('host z-index is max', host.style.zIndex === '2147483647', host.style.zIndex);
  check('host parent is <html>', host.parentNode === document.documentElement, host.parentNode && host.parentNode.tagName);
  check('host is last <html> child', host === document.documentElement.lastElementChild);

  const r = card && card.getBoundingClientRect();
  if (r) {
    check('card has size', r.width > 100 && r.height > 200, Math.round(r.width) + 'x' + Math.round(r.height));
    check('card inside viewport', r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      Math.round(r.left) + ',' + Math.round(r.top) + ' → ' + Math.round(r.right) + ',' + Math.round(r.bottom));
    // Temporarily give the hostile layers pointer-events so hit-testing tells
    // the truth about paint order: the topmost hit at the card's corner must
    // live inside our shadow root.
    for (const el of document.querySelectorAll('#hostile-layer,#body-portal,#portal-layer')) {
      el.style.pointerEvents = 'auto';
    }
    const at = document.elementFromPoint(Math.min(innerWidth - 1, r.left + 30), Math.min(innerHeight - 1, r.top + 30));
    const inShadow = !!at && !!at.getRootNode && at.getRootNode() === sr;
    check('widget paints above hostile layers', inShadow, at ? (at.id || at.tagName) : 'no element');
  }

  const dbg = window.__codesolveDebug;
  check('debug API present', !!dbg);
  if (dbg) {
    try {
      const p = dbg.extractProblem() || '';
      check('extracts the question', p.includes('Reverse Words'), p.slice(0, 70).replace(/\\n/g, ' '));
    } catch (e) { check('extracts the question', false, e.message); }
    try {
      const lang = dbg.detectLanguage();
      check('detects editor language', lang === 'JavaScript' || lang === 'Python 3', lang);
    } catch (e) { check('detects editor language', false, e.message); }
    try {
      const code = dbg.readEditorText();
      check('reads editor content', code.includes('reverseWords'), (code || '').slice(0, 40).replace(/\\n/g, ' '));
    } catch (e) { check('reads editor content', false, e.message); }
  }
  return out;
})()`;

const res = await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true });
const out = res.result.value || {};
console.log('PASS:', out.pass ? out.pass.length : 0, out.pass || []);
console.log('FAIL:', out.fail ? out.fail.length : 0, out.fail || []);

const extExceptions = exceptions.filter(e => {
  const st = JSON.stringify(e).toLowerCase();
  return st.includes('codesolve') || st.includes('content.js') || st.includes('typer') || st.includes('monaco');
});
console.log('extension exceptions:', extExceptions.length, extExceptions.slice(0, 3).map(e => JSON.stringify(e).slice(0, 300)));
ws.close();
