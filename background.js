// secrets.js (git-ignored) can hold a personal API key so the extension works
// out of the box locally without committing any secret to the repository.
try { importScripts('secrets.js'); } catch { /* no local override */ }

importScripts('config.js');

const CFG = globalThis.CODESOLVE_CONFIG;

const DEFAULTS = {
  enabled: CFG.DEFAULT_ENABLED,
  apiKey: globalThis.CS_LOCAL_API_KEY || CFG.DEFAULT_API_KEY,
  model: CFG.DEFAULT_MODEL,
  language: CFG.DEFAULT_LANGUAGE,
  typingSpeed: CFG.DEFAULT_TYPING_SPEED,
  verify: CFG.DEFAULT_VERIFY
};

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(null, stored => {
      const s = { ...DEFAULTS, ...(stored || {}) };
      if (!s.apiKey) s.apiKey = DEFAULTS.apiKey; // an empty saved key falls back
      resolve(s);
    });
  });
}

// Let content scripts read chrome.storage.session (used for the
// screen-capture state that hides the chatbot in every tab).
try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch { /* older Chrome — ignore */ }

// ------------------------------------------------- screen-capture coordination

// tabId -> true for every tab whose page currently has a live screen capture
// (browser-based share/recording detected by capture-hook.js).
const captureTabs = new Set();

async function broadcastCaptureState() {
  const active = captureTabs.size > 0;
  try { await chrome.storage.session.set({ csCaptureActive: active }); } catch { /* ignore */ }
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id == null) continue;
      try { await chrome.tabs.sendMessage(t.id, { type: 'CAPTURE_STATE', active }); } catch { /* not injectable */ }
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- Groq client

function isReasoningModel(model) {
  return /gpt-oss/.test(model);
}

async function callGroq(apiKey, { model, messages, temperature, maxTokens, reasoningEffort, timeoutMs = 150000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = { model, messages, temperature, max_completion_tokens: maxTokens };
    if (reasoningEffort && isReasoningModel(model)) body.reasoning_effort = reasoningEffort;

    const res = await fetch(`${CFG.GROQ_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      let detail = '';
      try {
        const err = await res.json();
        detail = err && err.error && err.error.message ? err.error.message : JSON.stringify(err).slice(0, 300);
      } catch {
        detail = await res.text().catch(() => '');
      }
      const e = new Error(`HTTP ${res.status}: ${detail}`);
      e.status = res.status;
      throw e;
    }

    const data = await res.json();
    const choice = data.choices && data.choices[0];
    if (!choice || !choice.message) throw new Error('Groq returned an empty response.');
    return {
      content: choice.message.content || '',
      finishReason: choice.finish_reason || ''
    };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- parsing

function fencedBlocks(text) {
  const out = [];
  const re = /```[^\n`]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    let code = m[1].replace(/^\n+|\n+$/g, '');
    if (code) out.push(code);
  }
  return out;
}

function splitSections(content) {
  const sections = {};
  const parts = content.split(/^##\s+/m);
  for (const part of parts) {
    const idx = part.indexOf('\n');
    if (idx === -1) continue;
    const header = part.slice(0, idx).trim().toUpperCase();
    sections[header] = part.slice(idx + 1).trim();
  }
  return sections;
}

function parseSolution(content) {
  const sections = splitSections(content);
  const codeSection = sections.CODE || sections.SOLUTION || '';
  let code = fencedBlocks(codeSection)[0] || fencedBlocks(content)[0] || '';
  let approach = sections.APPROACH || '';
  let complexity = sections.COMPLEXITY || '';

  if (!code) {
    // Model ignored the format; degrade gracefully so the user still sees something.
    const bare = content.trim();
    if (!bare) throw new Error('The model returned an empty response. Try again.');
    approach = approach || bare.slice(0, 1200);
  }
  return { code, approach, complexity };
}

function parseVerdict(content) {
  const sections = splitSections(content);
  const verdictText = sections.VERDICT || '';
  const code = fencedBlocks(sections.CODE || '')[0] || fencedBlocks(content)[0] || '';
  const fixed = /^FIXED/i.test(verdictText.trim());
  return { passed: !fixed, note: verdictText.replace(/^PASS[^\n]*/i, 'Passed all sample traces').trim(), code };
}

// --------------------------------------------------------------- solve flows

const PLATFORM_NOTES = {
  leetcode: 'PLATFORM: LeetCode — the submission must be the exact template shown in the starter code (typically `class Solution` implementing the named method). Do NOT read stdin or print; implement the required method and return the answer.',
  hackerrank: 'PLATFORM: HackerRank — follow the starter code exactly. If it reads stdin and prints, keep that I/O format; if it is a class/function template, implement it.',
  gfg: 'PLATFORM: GeeksforGeeks — follow the starter code exactly (usually `class Solution` with the named method, or a stdin/stdout driver). Implement what the template implies.'
};

function platformNote(platform) {
  return PLATFORM_NOTES[platform] || 'PLATFORM: unspecified — follow the starter code if provided, otherwise use the most conventional format for the language on coding platforms.';
}

function buildSolveMessages(problem, language, starterCode, platform) {
  let user = `PROBLEM STATEMENT:\n${problem}\n\nTARGET LANGUAGE: ${language}\n\n${platformNote(platform)}`;
  if (starterCode) {
    user += `\n\nSTARTER CODE (match its signatures / I/O exactly):\n${starterCode}`;
  }
  return [
    { role: 'system', content: CFG.SOLVE_SYSTEM_PROMPT },
    { role: 'user', content: user }
  ];
}

function buildVerifyMessages(problem, code, language, platform) {
  return [
    { role: 'system', content: CFG.VERIFY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `PROBLEM (includes sample input/output examples):\n${problem}\n\nLANGUAGE: ${language}\n\n${platformNote(platform)}\n\nCANDIDATE SOLUTION:\n\`\`\`\n${code}\n\`\`\`\n\nTrace every sample example and check the constraints. Return the required format.`
    }
  ];
}

function isRetryableModel(e) {
  if (e && (e.status === 429 || e.status === 500 || e.status === 502 || e.status === 503 || e.status === 504)) return true;
  const msg = e && e.message ? e.message : '';
  return /decommissioned|model_not_found|does not exist|no longer available/i.test(msg);
}

function friendlyError(e) {
  if (e && e.friendly) return e.friendly;
  if (e && e.name === 'AbortError') return 'Groq took too long to respond. Try again, or pick a faster model in Options.';
  const status = e && e.status;
  const msg = (e && e.message) || '';
  if (status === 401 || status === 403) return 'Groq rejected the API key (invalid or no access). Update it in Options.';
  if (status === 429) return 'Groq rate limit reached. Wait a minute and retry, or switch models in Options.';
  if (status === 413 || /context length|too large|too long/i.test(msg)) return 'The problem is too long for this model. Try selecting just the statement instead.';
  if (/failed to fetch|networkerror/i.test(msg)) return 'Network error reaching Groq. Check your connection.';
  return `Groq error: ${msg.slice(0, 300) || 'unknown'}`;
}

async function solve(payload) {
  const settings = await getSettings();
  const apiKey = (settings.apiKey || '').trim();
  if (!apiKey || !apiKey.startsWith('gsk_')) {
    const e = new Error('missing key');
    e.friendly = 'No Groq API key set. Open the extension options and add one.';
    throw e;
  }

  const language = payload.language || settings.language || CFG.DEFAULT_LANGUAGE;
  const models = [settings.model, ...CFG.FALLBACK_MODELS.filter(m => m !== settings.model)];

  let lastError = null;
  for (const model of models) {
    try {
      const solveRes = await callGroq(apiKey, {
        model,
        messages: buildSolveMessages(payload.problem, language, payload.starterCode, payload.platform),
        temperature: 0.2,
        maxTokens: 12000,
        reasoningEffort: 'medium'
      });
      const result = parseSolution(solveRes.content);

      if (settings.verify && result.code) {
        try {
          const verifyRes = await callGroq(apiKey, {
            model,
            messages: buildVerifyMessages(payload.problem, result.code, language, payload.platform),
            temperature: 0,
            maxTokens: 12000,
            reasoningEffort: 'high'
          });
          const verdict = parseVerdict(verifyRes.content);
          if (verdict.code) result.code = verdict.code;
          result.verdict = verdict;
        } catch (e) {
          // Verification is best-effort; the base solution is still usable.
          result.verdict = { passed: true, note: 'Self-check could not run (' + friendlyError(e).slice(0, 120) + ')' };
        }
      }

      result.model = model;
      result.language = language;
      return result;
    } catch (e) {
      lastError = e;
      if (!isRetryableModel(e)) break;
    }
  }
  throw lastError || new Error('Solve failed.');
}

function buildChatMessages(payload) {
  const messages = [{ role: 'system', content: CFG.CHAT_SYSTEM_PROMPT }];

  const ctx = payload.context || {};
  let ctxText = `PAGE CONTEXT\nTitle: ${String(ctx.title || '').slice(0, 200)}\nURL: ${String(ctx.url || '').slice(0, 300)}`;
  if (ctx.selection) {
    ctxText += `\n\nUSER'S CURRENT SELECTION (highest priority — the user probably selected this on purpose):\n${String(ctx.selection).slice(0, 4000)}`;
  }
  if (ctx.pageText) {
    ctxText += `\n\nPAGE TEXT (labeled regions extracted from the page — question description, README/doc preview, repo file tree, etc.):\n${String(ctx.pageText).slice(0, 24000)}`;
  }
  if (ctx.editorCode && String(ctx.editorCode).trim()) {
    ctxText += `\n\nCURRENT CODE EDITOR CONTENT — the file the user has open (language: ${ctx.language || 'unknown — detect it from this code'}):\n${String(ctx.editorCode).slice(0, 12000)}`;
  }
  messages.push({ role: 'system', content: ctxText });

  const history = Array.isArray(payload.history) ? payload.history.slice(-12) : [];
  for (const m of history) {
    if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()) {
      messages.push({ role: m.role, content: m.content.slice(0, 4000) });
    }
  }
  messages.push({ role: 'user', content: String(payload.question || '').slice(0, 4000) });
  return messages;
}

async function streamGroq(apiKey, { model, messages, temperature, maxTokens, reasoningEffort }, onChunk) {
  const body = { model, messages, temperature, max_completion_tokens: maxTokens, stream: true };
  if (reasoningEffort && isReasoningModel(model)) body.reasoning_effort = reasoningEffort;

  const res = await fetch(`${CFG.GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err && err.error && err.error.message ? err.error.message : JSON.stringify(err).slice(0, 300);
    } catch {
      detail = await res.text().catch(() => '');
    }
    const e = new Error(`HTTP ${res.status}: ${detail}`);
    e.status = res.status;
    throw e;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
        if (delta) onChunk(delta);
      } catch { /* partial JSON line — ignore */ }
    }
  }
}

async function streamChatToPort(port, payload) {
  const settings = await getSettings();
  const apiKey = (settings.apiKey || '').trim();
  if (!apiKey || !apiKey.startsWith('gsk_')) {
    port.postMessage({ error: 'No Groq API key set. Open the extension options and add one.' });
    return;
  }
  const messages = buildChatMessages(payload);
  const models = [settings.model, ...CFG.FALLBACK_MODELS.filter(m => m !== settings.model)];

  for (const model of models) {
    try {
      let received = false;
      await streamGroq(apiKey, {
        model,
        messages,
        temperature: 0.4,
        maxTokens: 6000,
        reasoningEffort: 'low'
      }, chunk => { received = true; port.postMessage({ chunk }); });
      port.postMessage({ done: true, model });
      return;
    } catch (e) {
      if (!isRetryableModel(e)) {
        port.postMessage({ error: friendlyError(e) });
        return;
      }
    }
  }
  port.postMessage({ error: 'Groq is rate-limiting every available model right now. Wait a minute and retry.' });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'chat-stream') return;
  port.onMessage.addListener(msg => {
    if (msg && msg.type === 'CHAT_STREAM') {
      streamChatToPort(port, msg).catch(e => {
        try { port.postMessage({ error: friendlyError(e) }); } catch { /* port closed */ }
      });
    }
  });
});

async function testKey() {
  const settings = await getSettings();
  const apiKey = (settings.apiKey || '').trim();
  if (!apiKey) return { ok: false, error: 'No API key set.' };
  const res = await fetch(`${CFG.GROQ_BASE}/models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const data = await res.json();
  const usable = (data.data || []).filter(m => (m.output_modalities || []).includes('text')).map(m => m.id);
  return { ok: true, count: usable.length, models: usable };
}

// ------------------------------------------------------------------ plumbing

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'SOLVE') {
        sendResponse({ ok: true, ...(await solve(msg)) });
      } else if (msg.type === 'TEST_KEY') {
        sendResponse(await testKey());
      } else if (msg.type === 'GET_SETTINGS') {
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (msg.type === 'CAPTURE_REPORT') {
        // A tab reports a browser-based screen capture. hideAll=true means
        // the widget cannot be cut out of that share (window/monitor capture
        // or exclusion unsupported) — every tab must hide. hideAll=false
        // means the widget's region is excluded from a tab capture, so
        // nobody needs to hide.
        const tabId = sender.tab && sender.tab.id;
        if (tabId != null) {
          if (msg.active && msg.hideAll !== false) captureTabs.add(tabId);
          else captureTabs.delete(tabId);
          // Prune tabs that no longer exist (closed while sharing).
          for (const id of [...captureTabs]) {
            try { await chrome.tabs.get(id); } catch { captureTabs.delete(id); }
          }
          await broadcastCaptureState();
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'GET_DISPLAYS') {
        // Monitor geometry so the floated chat window can jump between screens.
        try {
          const displays = await chrome.system.display.getInfo();
          sendResponse({
            ok: true,
            displays: displays.map(d => ({
              isPrimary: !!d.isPrimary,
              bounds: { left: d.bounds.left, top: d.bounds.top, width: d.bounds.width, height: d.bounds.height },
              workArea: { left: d.workArea.left, top: d.workArea.top, width: d.workArea.width, height: d.workArea.height }
            }))
          });
        } catch (e) {
          sendResponse({ ok: false, error: friendlyError(e) });
        }
      } else if (msg.type === 'INJECT_MAIN') {
        // Inject a helper into the page's MAIN world (e.g. the Monaco bridge).
        if (!sender.tab || !sender.tab.id) {
          sendResponse({ ok: false, error: 'No tab context.' });
        } else {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: sender.tab.id },
              world: 'MAIN',
              files: [String(msg.file || '').replace(/[^\w.-]/g, '')]
            });
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: friendlyError(e) });
          }
        }
      }
    } catch (e) {
      sendResponse({ ok: false, error: friendlyError(e) });
    }
  })();
  return true; // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'cs-open-chat',
      title: '⚡ Open CodeSolve chat',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: 'cs-ask-selection',
      title: '⚡ Ask CodeSolve about this selection',
      contexts: ['selection']
    });
  });
});

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['config.js', 'typer.js', 'content.js'] });
    } catch {
      // Page not injectable (chrome://, store, etc.) — nothing to do.
    }
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  await ensureContentScript(tab.id);
  if (info.menuItemId === 'cs-ask-selection') {
    chrome.tabs.sendMessage(tab.id, {
      type: 'ASK_SELECTION',
      selection: info.selectionText || ''
    });
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_CHATBOT' });
  }
});
