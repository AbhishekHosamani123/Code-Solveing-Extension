// Temporary probe: attaches to the running Chrome (port 9333), navigates to a
// URL and reports whether the CodeSolve widget exists and where it renders.
import fs from 'node:fs';

const URL_TO_OPEN = process.argv[2] || 'https://mycareernet.co/mycareernet/practice-assessments';
const WAIT_MS = Number(process.argv[3] || 9000);

const PORT = process.env.CDP_PORT || 9333;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
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
await send('Log.enable');
await send('Page.navigate', { url: URL_TO_OPEN });
await sleep(WAIT_MS);

const probe = `(() => {
  const out = { url: location.href, title: document.title };
  const host = document.getElementById('codesolve-chat-host');
  out.hostPresent = !!host;
  out.hostParent = host ? host.parentElement?.tagName : null;
  out.hostStyle = host ? host.getAttribute('style') : null;
  const sr = host && host.shadowRoot;
  out.shadowOpen = !!sr;
  const card = sr && sr.querySelector('.chatcard');
  const bubble = sr && sr.querySelector('.bubble');
  out.cardFound = !!card;
  out.bubbleFound = !!bubble;
  if (card) {
    const cs = getComputedStyle(card);
    const r = card.getBoundingClientRect();
    out.card = {
      hiddenClass: card.classList.contains('hidden'),
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      position: cs.position, zIndex: cs.zIndex,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    };
    const at = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, r.x + 20)), Math.max(0, Math.min(innerHeight - 1, r.y + 20)));
    out.elementAtCardCorner = at ? (at.id || at.tagName) : null;
  }
  if (bubble) {
    const cs = getComputedStyle(bubble);
    const r = bubble.getBoundingClientRect();
    out.bubble = { hiddenClass: bubble.classList.contains('hidden'), display: cs.display, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  }
  const hs = getComputedStyle(document.documentElement);
  out.htmlStyle = { transform: hs.transform, filter: hs.filter, perspective: hs.perspective, willChange: hs.willChange, contain: hs.contain, overflow: hs.overflow };
  const bs = getComputedStyle(document.body);
  out.bodyStyle = { transform: bs.transform, filter: bs.filter, overflow: bs.overflow, zoom: bs.zoom };
  out.viewport = { w: innerWidth, h: innerHeight };
  out.frames = [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 90));
  out.topZIndexes = [...document.querySelectorAll('body *')].slice(0, 4000)
    .map(el => ({ el, z: getComputedStyle(el).zIndex }))
    .filter(o => o.z && o.z !== 'auto' && Number(o.z) > 1000)
    .slice(0, 10)
    .map(o => ({ tag: o.el.tagName + (o.el.id ? '#' + o.el.id : ''), z: o.z, pos: getComputedStyle(o.el).position }));
  out.bodyTextHead = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400);
  out.extensionIds = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id || null : 'no chrome api in isolated world view';
  return out;
})()`;

const res = await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(res.result.value ?? res.result, null, 2));

// dump extension-related console errors
const errs = events.filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
console.log('\n--- errors ---');
for (const e of errs.slice(0, 20)) {
  console.log(e.method, JSON.stringify(e.params).slice(0, 400));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('dev-tests/probe-shot.png', Buffer.from(shot.data, 'base64'));
console.log('\nscreenshot: dev-tests/probe-shot.png');
ws.close();
