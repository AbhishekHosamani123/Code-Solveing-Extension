const CFG = globalThis.CODESOLVE_CONFIG;
const $ = id => document.getElementById(id);

function storageGet() {
  return new Promise(resolve => chrome.storage.local.get(null, s => resolve(s || {})));
}

function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await storageGet();
  $('enabled').checked = settings.enabled !== false;

  $('enabled').addEventListener('change', async e => storageSet({ enabled: e.target.checked }));

  $('show').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_CHATBOT' });
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['config.js', 'typer.js', 'content.js'] });
        chrome.tabs.sendMessage(tab.id, { type: 'SHOW_CHATBOT' });
      } catch { /* unsupported page */ }
    }
    window.close();
  });

  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
});
