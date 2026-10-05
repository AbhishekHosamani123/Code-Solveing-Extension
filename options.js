const CFG = globalThis.CODESOLVE_CONFIG;
const $ = id => document.getElementById(id);

function storageGet() {
  return new Promise(resolve => chrome.storage.local.get(null, s => resolve(s || {})));
}

function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await storageGet();

  const modelSelect = $('model');
  const modelCustom = $('modelCustom');
  for (const m of CFG.MODEL_CHOICES) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    modelSelect.appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = 'Custom…';
  modelSelect.appendChild(customOpt);

  function syncModelUI(value) {
    if (CFG.MODEL_CHOICES.includes(value)) {
      modelSelect.value = value;
      modelCustom.style.display = 'none';
    } else {
      modelSelect.value = '__custom__';
      modelCustom.style.display = '';
      modelCustom.value = value;
    }
  }
  const currentModel = settings.model || CFG.DEFAULT_MODEL;
  syncModelUI(currentModel);
  modelSelect.addEventListener('change', () => {
    modelCustom.style.display = modelSelect.value === '__custom__' ? '' : 'none';
  });

  const langSelect = $('language');
  for (const lang of CFG.LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = lang;
    langSelect.appendChild(opt);
  }

  $('apiKey').value = settings.apiKey || CFG.DEFAULT_API_KEY;
  langSelect.value = settings.language || CFG.DEFAULT_LANGUAGE;
  $('verify').checked = settings.verify !== false;
  $('typos').checked = settings.humanTypos !== false;
  $('speed').value = settings.typingSpeed || CFG.DEFAULT_TYPING_SPEED;
  $('enabled').checked = settings.enabled !== false;

  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? 'Hide' : 'Show';
  });

  $('testKey').addEventListener('click', async () => {
    const status = $('keyStatus');
    status.className = 'status';
    status.textContent = 'Testing…';
    await storageSet({ apiKey: $('apiKey').value.trim() });
    const resp = await send({ type: 'TEST_KEY' });
    if (resp && resp.ok) {
      status.className = 'status ok';
      status.textContent = `✓ Key works — ${resp.count} usable models on this account.`;
    } else {
      status.className = 'status err';
      status.textContent = `✗ ${resp && resp.error ? resp.error : 'Could not reach Groq.'}`;
    }
  });

  $('save').addEventListener('click', async () => {
    const model = modelSelect.value === '__custom__'
      ? (modelCustom.value.trim() || CFG.DEFAULT_MODEL)
      : modelSelect.value;
    await storageSet({
      apiKey: $('apiKey').value.trim(),
      model,
      language: langSelect.value,
      typingSpeed: $('speed').value,
      verify: $('verify').checked,
      humanTypos: $('typos').checked,
      enabled: $('enabled').checked
    });
    const saved = $('saved');
    saved.classList.add('show');
    setTimeout(() => saved.classList.remove('show'), 1600);
  });
});
