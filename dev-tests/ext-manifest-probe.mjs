// Attach to each service-worker target and print its manifest name + content scripts
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
for (const t of list.filter(x => x.type === 'service_worker')) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const res = await new Promise(resolve => {
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) resolve(m.result);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: 'JSON.stringify({ name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version, cs: (chrome.runtime.getManifest().content_scripts || []).map(c => ({matches: c.matches, js: c.js})) })',
      returnByValue: true
    }}));
  });
  console.log(t.url.slice(0, 60), '→', res.result && res.result.value || JSON.stringify(res.exceptionDetails).slice(0, 200));
  ws.close();
}
