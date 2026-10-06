// content.js — CodeSolve floating chatbot.
// Always present on every page: draggable, resizable, minimized to a bubble.
// Every question automatically carries the page as context (title, URL, page
// text, the user's selection, and the current code-editor content + language).
// Answers stream token-by-token from Groq through a background Port.
(() => {
  if (window.__codesolveLoaded) return;
  window.__codesolveLoaded = true;

  const CFG = globalThis.CODESOLVE_CONFIG;
  const TYPER = window.__codesolveTyper || null;
  const IS_TOP = window === window.top;

  const SITE = (() => {
    const h = location.hostname;
    if (h.includes('leetcode.')) return 'leetcode';
    if (h.includes('hackerrank.')) return 'hackerrank';
    if (h.includes('geeksforgeeks.')) return 'gfg';
    return 'other';
  })();

  // ------------------------------------------------------------ extraction

  function hasLayout(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  // Return the first VISIBLE match for any of the selectors. Sites that switch
  // questions in place keep the old (hidden) question in the DOM, and
  // querySelector returns the first match in DOM order — often the stale one.
  function pick(...selectors) {
    let fallback = null;
    for (const s of selectors) {
      let matches;
      try {
        matches = document.querySelectorAll(s);
      } catch { /* invalid selector on this site */ continue; }
      for (const el of matches) {
        if (!fallback) fallback = el;
        if (hasLayout(el)) return el;
      }
    }
    return fallback;
  }

  function textOf(el, limit = 14000) {
    if (!el) return '';
    const t = (el.innerText || el.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    return t.slice(0, limit);
  }

  function cap(s, n) {
    s = String(s || '').trim();
    return s.length > n ? s.slice(0, n) : s;
  }

  const LANG_ALIASES = {
    python3: 'Python 3', python: 'Python 3', py: 'Python 3', python2: 'Python 2',
    cpp: 'C++', cplusplus: 'C++', 'c++': 'C++',
    java: 'Java', javascript: 'JavaScript', js: 'JavaScript', node: 'JavaScript', typescript: 'JavaScript',
    csharp: 'C#', 'c#': 'C#', cs: 'C#', c: 'C', golang: 'Go', go: 'Go', ruby: 'Ruby', rust: 'Rust', kotlin: 'Kotlin', swift: 'Swift'
  };

  function normalizeLang(raw) {
    if (!raw) return '';
    const key = String(raw).trim().toLowerCase();
    return LANG_ALIASES[key] || '';
  }

  function isVisibleEl(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function detectLangFromUI() {
    const els = document.querySelectorAll(
      'button, select, [role="listbox"], [role="combobox"], [aria-haspopup="listbox"]'
    );
    for (const el of els) {
      if (!isVisibleEl(el)) continue;
      const raw = el.getAttribute('data-mode-id') || el.value || el.textContent || '';
      const t = String(raw).trim();
      if (t && t.length <= 12 && normalizeLang(t)) return t;
    }
    return '';
  }

  function sniffLanguage(code) {
    const c = String(code || '');
    if (!c.trim()) return '';
    if (/using namespace std|std::|#include\s*<(iostream|vector|string|algorithm|map|set|queue|bits)/m.test(c)) return 'C++';
    if (/#include\s*<stdio\.h>|scanf\s*\(|printf\s*\(/m.test(c)) return 'C';
    if (/public\s+(static\s+)?class|System\.out\.print|import\s+java\./m.test(c)) return 'Java';
    if (/using\s+System|namespace\s+\w+\s*[;{]|Console\.Write/m.test(c)) return 'C#';
    if (/package\s+main\b|fmt\.(Print|Sprint|Fprint)/m.test(c)) return 'Go';
    if (/\bfn\s+\w+\s*\(|println!/m.test(c)) return 'Rust';
    if (/(^|\n)\s*def\s+\w+\s*\(|(^|\n)\s*from\s+\w+\s+import|^import\s+\w+\s*$/m.test(c)) return 'Python 3';
    if (/(^|\n)\s*function\s+\w*\s*\(|=>\s*[{(]|console\.log|(^|\n)\s*(const|let|var)\s+\w+\s*=/m.test(c)) return 'JavaScript';
    if (/(^|\n)\s*class\s+\w+[(:]|print\s*\(/m.test(c)) return 'Python 3';
    return '';
  }

  function readEditorText() {
    try {
      if (TYPER) {
        const ed = TYPER.findEditor();
        if (ed) {
          const t = ed.readAll();
          if (t && t.trim().length > 5) return t;
        }
      }
    } catch { /* ignore */ }
    return extractStarterCode();
  }

  function detectLanguage() {
    try {
      if (SITE === 'leetcode') {
        const el = pick('[data-mode-id]');
        if (el) return normalizeLang(el.getAttribute('data-mode-id'));
      }
      if (SITE === 'hackerrank') {
        const sel = pick('select[id*="language" i]', 'select[class*="language" i]');
        if (sel) return normalizeLang(sel.value);
      }
      if (SITE === 'gfg') {
        const sel = pick('#languageSelector', 'select[id*="language" i]');
        if (sel) return normalizeLang(sel.value);
      }
      const ui = detectLangFromUI();
      if (ui) return normalizeLang(ui);
      return sniffLanguage(readEditorText());
    } catch { /* best effort */ }
    return '';
  }

  function titleFromDocument() {
    const t = document.title
      .replace(/\s*[-–|]\s*(LeetCode|HackerRank|GeeksforGeeks|Practice|MockCode)[\s\S]*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t || t.length > 120) return '';
    if (/solution|welcome|^home\b|sign in|register/i.test(t)) return '';
    return t;
  }

  function extractTitle() {
    const fromDoc = titleFromDocument();
    if (fromDoc) return fromDoc;
    let el = null;
    if (SITE === 'leetcode') {
      el = pick('div[data-cy="question-title"]', 'a[href*="/problems/"] h4', 'a[href*="/problems/"] .ellipsis', 'h1');
    } else {
      el = pick('.problem-statement h1', '[class*="problem"] h1', 'h1');
    }
    return textOf(el, 200);
  }

  function cleanStatement(text) {
    return text
      .split('\n')
      .filter(line => !/^(problem|editorial|submissions|comments|all problems|leaderboard|discuss)$/i.test(line.trim()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---- Multi-region page context ------------------------------------------
  // Pages like HackerRank's code-repo challenges show several distinct areas
  // at once: the question/issue description, a README or doc preview, the repo
  // file tree, and the currently open file. Instead of picking one "best"
  // text blob (which ends up being UI chrome), collect the top non-duplicate
  // regions so the chatbot sees all of them, each labeled.

  const REGION_SELECTORS_SPECIFIC = [
    '[class*="problem"]', '[class*="statement"]', '[class*="description"]',
    '[class*="question"]', '[class*="task"]', '[class*="instruction"]',
    '[class*="issue"]',
    '[class*="markdown"]', '.markdown-body', '[class*="readme"]',
    '[class*="preview"]', '[class*="challenge"]',
    '[class*="file-tree"]', '[class*="treeview"]', '[class*="explorer"]',
    '[class*="navigator"]', '[role="tabpanel"]'
  ];
  const REGION_SELECTORS_GENERIC = ['main', 'article', '[role="main"]', '[class*="content"]'];

  function regionLabel(el, text) {
    const hay = (String(el.className || '') + ' ' + String(el.id || '')).toLowerCase();
    if (/markdown|readme|preview/.test(hay)) return 'doc / README preview';
    if (/question|description|statement|instruction|issue/.test(hay)) return 'question / task description';
    if (/tree|explorer|navigator/.test(hay)) return 'repo file tree';
    if (/editor|terminal|console/.test(hay)) return 'code / terminal';
    if (/^(#|\*\*)?\s*(overview|expected|task|issue|problem|description|setup|api)/im.test(text.slice(0, 600))) return 'doc / README preview';
    if (/(issue|implement|fix|bug|task|requirement|user story)/i.test(text.slice(0, 800))) return 'question / task description';
    return 'page region';
  }

  function viewportOverlapRatio(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return 0;
      const w = window.innerWidth || 0, h = window.innerHeight || 0;
      const ox = Math.max(0, Math.min(r.right, w) - Math.max(r.left, 0));
      const oy = Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0));
      return Math.max(0, Math.min(1, (ox * oy) / (r.width * r.height)));
    } catch {
      return 0;
    }
  }

  function collectPageRegions() {
    const keywords = /(constraint|example|input|output|explanation|note|question|task|requirement|error|issue|endpoint|api|overview)/i;
    const budget = 22000;
    let used = 0;

    const scan = selectors => {
      const seen = new Set();
      const scored = [];
      for (const sel of selectors) {
        let els;
        try { els = document.querySelectorAll(sel); } catch { continue; }
        for (const el of els) {
          if (seen.has(el) || !hasLayout(el)) continue;
          seen.add(el);
          const t = textOf(el, 8000);
          if (t.length < 120) continue;
          scored.push({
            el, text: t,
            score: t.length * (keywords.test(t) ? 2 : 1) * (1 + viewportOverlapRatio(el))
          });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const picked = [];
      for (const c of scored) {
        if (picked.length >= 4 || used >= budget) break;
        const dup = picked.some(p => p.text.includes(c.text) || (c.text.includes(p.text) && p.text.length > 200));
        if (dup) continue;
        used += c.text.length;
        picked.push(c);
      }
      return picked;
    };

    // Specific regions first (question / readme / tree / preview), so the
    // useful leaves win over the giant page wrappers. Generic containers are
    // only used when nothing specific was found.
    const picked = scan(REGION_SELECTORS_SPECIFIC);
    if (!picked.length) picked.push(...scan(REGION_SELECTORS_GENERIC));
    if (!picked.length) {
      const body = textOf(document.body, 12000);
      if (body) picked.push({ el: document.body, text: body });
    }
    return picked.map(p => `[${regionLabel(p.el, p.text)}]\n${p.text}`);
  }

  function regionsJoin(regions) {
    return regions.join('\n\n---\n\n');
  }

  // Full page context: the platform-tuned statement (when this is a site we
  // know) plus every generic region that isn't already covered by it.
  function pageContextText() {
    const regions = [];
    const known = (SITE !== 'other') ? extractProblem() : '';
    if (known && known.length >= 200) regions.push('[question / task description]\n' + known);
    for (const r of collectPageRegions()) {
      const body = r.slice(r.indexOf(']\n') + 2);
      const head = body.slice(0, 300);
      if (regions.some(x => head.length > 80 && x.includes(head))) continue;
      if (known && known.length >= 200 &&
          (known.includes(head) || (head.length > 80 && head.includes(known.slice(0, 300))))) continue;
      regions.push(r);
    }
    return regionsJoin(regions);
  }

  function extractProblem() {
    let descEl = null;
    if (SITE === 'leetcode') {
      descEl = pick(
        'div.elfjS',
        'div[data-track-load="description_content"]',
        '#description-content',
        'div[class*="description"]'
      );
    } else if (SITE === 'hackerrank') {
      descEl = pick(
        '[data-cy="problem-statement"]',
        '.problem-statement',
        '.problem-description',
        '.challenge-text'
      );
    } else if (SITE === 'gfg') {
      descEl = pick(
        '.problem-statement',
        '[class*="problem_statement"]',
        '.problems_statement_content',
        '[class*="statement"]'
      );
    }

    let body = textOf(descEl);
    if (body.length < 200) body = regionsJoin(collectPageRegions());
    if (!body) return '';
    body = cleanStatement(body);

    const title = titleFromDocument() || extractTitle();
    // Only prepend a title that is part of the CURRENT question — pages that
    // switch questions in place often keep the previous question's title in
    // document.title, which would mislabel the context.
    if (title && body.includes(title) && !body.startsWith(title)) return `${title}\n\n${body}`;
    return body;
  }

  function extractStarterCode() {
    try {
      const el = pick('.monaco-editor .view-lines', '.CodeMirror-code', '.ace_content');
      const t = el ? textOf(el, 2500) : '';
      return t.length > 20 ? t : '';
    } catch {
      return '';
    }
  }

  // The context attached to every chat question.
  async function buildPageContext(includePage) {
    const sel = String(window.getSelection ? window.getSelection() || '' : '').trim();
    const ctx = { title: document.title, url: location.href };
    if (sel) ctx.selection = cap(sel, 4000);
    if (includePage) {
      ctx.pageText = await buildFrameContext(900);
      ctx.editorCode = cap(readEditorText(), 12000);
      ctx.language = detectLanguage();
    }
    return ctx;
  }

  // ---- Cross-frame context -------------------------------------------------
  // Assessment IDEs (HackerRank test-v2 etc.) render the question panel, the
  // README viewer, the file tree and the code editor inside embedded frames.
  // The widget only exists in the top frame, so the top frame asks every
  // child frame (recursively) for its labeled regions and merges the answers.

  function frameOwnContext() {
    let text = pageContextText();
    const sel = String(window.getSelection ? window.getSelection() || '' : '').trim();
    if (sel) text = '[user selection in this frame]\n' + cap(sel, 4000) + '\n\n---\n\n' + text;
    try {
      if (TYPER) {
        const ed = TYPER.findEditor();
        if (ed) {
          const t = ed.readAll();
          if (t && t.trim().length > 20) text += '\n\n---\n\n[open file — editor content]\n' + cap(t, 10000);
        }
      }
    } catch { /* ignore */ }
    return text;
  }

  function requestChildContexts(timeoutMs) {
    return new Promise(resolve => {
      const frames = window.frames;
      if (!frames || !frames.length) { resolve([]); return; }
      const results = [];
      const nonce = 'cs' + Math.random().toString(36).slice(2);
      let expecting = frames.length;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(results);
      };
      const handler = event => {
        const d = event.data;
        if (!d || d.__cs !== 'CS_FRAME_CONTEXT' || d.nonce !== nonce) return;
        let known = false;
        for (let i = 0; i < frames.length; i++) {
          try { if (frames[i] === event.source) { known = true; break; } } catch { /* ignore */ }
        }
        if (!known) return;
        if (d.text) results.push(d);
        if (--expecting <= 0) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      window.addEventListener('message', handler);
      for (let i = 0; i < frames.length; i++) {
        try { frames[i].postMessage({ __cs: 'CS_GET_CONTEXT', nonce }, '*'); }
        catch { if (--expecting <= 0) finish(); }
      }
    });
  }

  async function buildFrameContext(timeoutMs = 850) {
    let text = frameOwnContext();
    const kids = await requestChildContexts(timeoutMs);
    for (const k of kids) {
      if (k.text) {
        text += '\n\n---\n\n[embedded frame: ' + String(k.frameUrl || '').replace(/[?#].*$/, '').slice(0, 160) + ']\n' + k.text;
      }
    }
    return text;
  }

  // Every frame (top or nested) answers context requests from its parent.
  window.addEventListener('message', event => {
    const d = event.data;
    if (!d || d.__cs !== 'CS_GET_CONTEXT') return;
    let isChild = false;
    for (let i = 0; i < window.frames.length; i++) {
      try { if (window.frames[i] === event.source) { isChild = true; break; } } catch { /* ignore */ }
    }
    if (!isChild) return; // only answer our own children
    buildFrameContext(700).then(text => {
      try {
        event.source.postMessage({ __cs: 'CS_FRAME_CONTEXT', nonce: d.nonce, text, frameUrl: location.href }, '*');
      } catch { /* ignore */ }
    });
  });

  // ------------------------------------------------------------------ UI

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0;
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; }
    .hidden { display: none !important; }

    .bubble {
      position: fixed; width: 54px; height: 54px; border-radius: 50%;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff; font-size: 24px; display: flex; align-items: center; justify-content: center;
      cursor: pointer; user-select: none;
      box-shadow: 0 6px 16px rgba(79, 70, 229, .45), 0 16px 40px rgba(79, 70, 229, .35);
      z-index: 2147483647; transition: transform .15s ease, box-shadow .15s ease;
    }
    .bubble:hover { transform: scale(1.07); box-shadow: 0 8px 20px rgba(79, 70, 229, .55), 0 20px 48px rgba(79, 70, 229, .4); }

    .chatcard {
      position: fixed; display: flex; flex-direction: column;
      background: linear-gradient(180deg, #111a2e 0%, #0c1425 100%);
      color: #e2e8f0; font-size: calc(16px * var(--fs, 1));
      border: 1px solid #2b3a58; border-radius: 16px;
      box-shadow: 0 10px 24px rgba(2, 8, 23, .5), 0 32px 80px rgba(2, 8, 23, .5);
      overflow: hidden; z-index: 2147483647;
      animation: cardIn .16s ease;
    }
    @keyframes cardIn { from { opacity: 0; transform: translateY(8px) scale(.985); } }

    .head {
      display: flex; align-items: center; gap: 7px; flex: none;
      padding: 10px 12px; cursor: grab; touch-action: none;
      background: linear-gradient(180deg, #182442, #141f38);
      border-bottom: 1px solid #27385a;
    }
    .head.dragging { cursor: grabbing; }
    .dot { width: 10px; height: 10px; flex: none; border-radius: 50%;
           background: linear-gradient(135deg, #818cf8, #a78bfa);
           box-shadow: 0 0 10px rgba(129, 140, 248, .8); }
    .brand { font-weight: 700; font-size: 1em; color: #dfe4ff; white-space: nowrap; letter-spacing: .2px; }
    .spacer { flex: 1; }
    .hbtn {
      background: transparent; border: none; color: #8fa0bd; cursor: pointer;
      font-size: .98em; padding: 3px 7px; border-radius: 8px; line-height: 1.2;
      transition: background .12s ease, color .12s ease;
    }
    .hbtn:hover { background: rgba(129, 140, 248, .16); color: #e2e8f0; }
    .hbtn.on { color: #a5b4fc; }
    .hbtn.fminus, .hbtn.fplus { font-size: .74em; font-weight: 700; min-width: 25px; padding: 4px 5px; }
    .priv {
      font-size: .76em; color: #4ade80; background: rgba(5, 46, 22, .9);
      border: 1px solid #166534; border-radius: 999px;
      padding: 2px 9px; white-space: nowrap;
    }

    .msgs {
      flex: 1; overflow-y: auto; padding: 14px 13px 8px;
      display: flex; flex-direction: column; gap: 10px; min-height: 0;
    }
    .msgs::-webkit-scrollbar { width: 8px; }
    .msgs::-webkit-scrollbar-track { background: transparent; }
    .msgs::-webkit-scrollbar-thumb { background: #2b3a58; border-radius: 8px; }
    .msgs::-webkit-scrollbar-thumb:hover { background: #3c5078; }
    .empty { color: #64748b; font-size: .94em; padding: 8px 4px; line-height: 1.6; }
    .msg {
      max-width: 90%; padding: 10px 14px; border-radius: 14px;
      font-size: 1em; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
    }
    .msg.user {
      align-self: flex-end; color: #fff; border-bottom-right-radius: 4px;
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      box-shadow: 0 4px 14px rgba(79, 70, 229, .28);
    }
    .msg.ai {
      align-self: flex-start; background: #17203a; border: 1px solid #263450;
      color: #e2e8f0; border-bottom-left-radius: 4px; max-width: 100%;
    }
    .msg.ai.err { background: #331414; border-color: #7f1d1d; color: #fecaca; }
    .msg.ai.thinking { color: #94a3b8; font-style: italic; }
    .msg .mtext { white-space: pre-wrap; }
    .msg .mtext b { color: #f8fafc; }
    .msg .mtext code.inline {
      background: #0b1120; border: 1px solid #263450; border-radius: 4px;
      padding: 0 5px; font-family: Consolas, 'JetBrains Mono', monospace; font-size: .85em;
    }
    .cursor { display: inline-block; width: 7px; height: .95em; background: #818cf8;
              vertical-align: text-bottom; animation: blink 1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }

    .codeblock {
      margin: 10px 0 2px; border: 1px solid #263450; border-radius: 10px;
      overflow: hidden; background: #0b1120;
    }
    .codeblock .cbhead {
      display: flex; align-items: center; gap: 8px;
      background: #0e1628; padding: 5px 10px; border-bottom: 1px solid #1f2d4a;
    }
    .codeblock .lang { font-size: .76em; color: #818cf8; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; }
    .codeblock .spacer { flex: 1; }
    .codeblock button {
      background: #1d2a45; color: #cbd5e1; border: 1px solid #2b3a58; border-radius: 6px;
      font-size: .8em; padding: 3px 10px; cursor: pointer;
      transition: background .12s ease, border-color .12s ease;
    }
    .codeblock button:hover { background: #28375c; border-color: #818cf8; }
    .codeblock pre {
      padding: 12px; overflow: auto; max-height: 300px; margin: 0;
      font-family: Consolas, 'JetBrains Mono', monospace; font-size: .94em;
      line-height: 1.55; white-space: pre; color: #dbe4f5; tab-size: 4;
    }
    .typestatus { display: flex; align-items: center; gap: 8px; margin: 5px 0 2px;
                  font-size: .82em; color: #94a3b8; }
    .typestatus .bar { flex: 1; height: 5px; background: #0b1120; border-radius: 999px; overflow: hidden; }
    .typestatus .fill { height: 100%; width: 0%; background: linear-gradient(90deg, #6366f1, #8b5cf6); transition: width .25s ease; }
    .typestatus button {
      flex: none; background: #7f1d1d; color: #fecaca; border: none; border-radius: 6px;
      font-size: .78em; padding: 3px 10px; cursor: pointer;
    }
    .verdict { font-size: .85em; margin-top: 6px; color: #86efac; }
    .verdict.warn { color: #fbbf24; }

    .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 13px 4px; flex: none; }
    .chip {
      background: rgba(129, 140, 248, .09); color: #b4c0f8;
      border: 1px solid #3a4a6b; border-radius: 999px;
      font-size: .85em; padding: 5px 13px; cursor: pointer;
      transition: background .12s ease, border-color .12s ease, transform .12s ease;
    }
    .chip:hover { border-color: #818cf8; background: rgba(129, 140, 248, .18); transform: translateY(-1px); }

    .inputrow { display: flex; gap: 8px; padding: 8px 13px 13px; flex: none; align-items: flex-end; }
    .chatinput {
      flex: 1; background: #0b1120; color: #e2e8f0; border: 1px solid #33456a;
      border-radius: 11px; padding: 10px 12px; font-size: 1em; outline: none;
      font-family: inherit; resize: none; max-height: 140px; line-height: 1.5;
      transition: border-color .12s ease, box-shadow .12s ease;
    }
    .chatinput:focus { border-color: #818cf8; box-shadow: 0 0 0 3px rgba(129, 140, 248, .15); }
    .send {
      flex: none; width: 42px; height: 42px; border: none; border-radius: 11px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff;
      font-size: 1.05em; cursor: pointer;
      transition: transform .12s ease, filter .12s ease;
    }
    .send:hover { filter: brightness(1.15); transform: scale(1.05); }
    .send[disabled] { opacity: .5; cursor: default; transform: none; }

    /* Window-style resize: right edge, bottom edge, and corner. */
    .rs { position: absolute; z-index: 9; touch-action: none; }
    .rs-r { top: 0; right: 0; bottom: 0; width: 9px; cursor: ew-resize; }
    .rs-b { left: 0; right: 0; bottom: 0; height: 9px; cursor: ns-resize; }
    .rs-c {
      right: 0; bottom: 0; width: 20px; height: 20px; cursor: nwse-resize;
      background:
        linear-gradient(135deg, transparent 0 50%, #64748b 50% 58%, transparent 58% 66%,
        #64748b 66% 74%, transparent 74% 82%, #64748b 82% 90%, transparent 90%);
      border-bottom-right-radius: 14px;
    }
    .rs:hover { background-color: rgba(129, 140, 248, .16); }
  `;

  let ui = null;
  let chatHistory = [];
  let chatBusy = false;
  let includePage = true;
  let enabledState = true;
  let typingRun = 0;

  // Screen capture / screen sharing.
  //  - Tab captures of THIS page: the capture-hook cuts the widget's region
  //    out of the shared video (Element Capture "exclude"), so the widget can
  //    stay visible to the user while being invisible in the share.
  //  - Window / full-screen captures (or if exclusion is unsupported): the
  //    widget hides itself in every tab until the capture ends.
  let ownCaptureActive = false;    // capture started from THIS page and we must hide
  let globalCaptureActive = false; // a "hide everywhere" capture reported by any tab
  let floated = false;             // chat lives in the private PiP window
  let pipWindow = null;

  function canShow() {
    return enabledState && !ownCaptureActive && !globalCaptureActive;
  }

  // Keep the exclusion box exactly over the visible widget (card or bubble),
  // padded so the card's glow/shadow is covered too.
  function syncExcludeBox() {
    if (!ui) return;
    let box = document.getElementById('codesolve-exclude-box');
    if (!box && !floated && canShow()) {
      box = document.createElement('div');
      box.id = 'codesolve-exclude-box';
      box.style.cssText = 'position:fixed;left:-200px;top:-200px;width:0;height:0;z-index:2147483645;pointer-events:none;background:transparent;border:0;margin:0;';
      (document.body || document.documentElement).appendChild(box);
    }
    if (!box) return;
    if (floated || !canShow()) {
      box.style.left = '-200px';
      box.style.top = '-200px';
      box.style.width = '0px';
      box.style.height = '0px';
      return;
    }
    const el = ui.card.classList.contains('hidden') ? ui.bubble : ui.card;
    if (!el || el.classList.contains('hidden')) {
      box.style.width = '0px';
      box.style.height = '0px';
      return;
    }
    const PAD_X = 24, PAD_TOP = 24, PAD_BOTTOM = 72; // card glow extends downward
    box.style.left = (el.offsetLeft - PAD_X) + 'px';
    box.style.top = (el.offsetTop - PAD_TOP) + 'px';
    box.style.width = (el.offsetWidth + PAD_X * 2) + 'px';
    box.style.height = (el.offsetHeight + PAD_TOP + PAD_BOTTOM) + 'px';
  }

  function setPrivateBadge(on) {
    if (!ui) return;
    ui.privEl.classList.toggle('hidden', !on);
  }

  function updateVisibility() {
    if (!ui) return;
    if (floated && !canShow()) closeFloat(false);
    ui.host.style.display = canShow() ? '' : 'none';
    syncExcludeBox();
  }

  function reportCapture(active, hideAll) {
    try {
      chrome.runtime.sendMessage({ type: 'CAPTURE_REPORT', active: !!active, hideAll: hideAll !== false }, () => void chrome.runtime.lastError);
    } catch { /* extension context gone */ }
  }

  const MIN_W = 320, MIN_H = 380;

  function defaultGeometry() {
    const w = Math.min(400, window.innerWidth - 32);
    const h = Math.min(560, window.innerHeight - 32);
    return { x: Math.max(12, window.innerWidth - w - 24), y: Math.max(12, window.innerHeight - h - 24), w, h, min: false };
  }

  function clampGeometry(g) {
    const w = Math.min(Math.max(g.w, MIN_W), window.innerWidth - 16);
    const h = Math.min(Math.max(g.h, MIN_H), window.innerHeight - 16);
    const x = Math.min(Math.max(g.x, -w + 60), window.innerWidth - 60);
    const y = Math.min(Math.max(g.y, 0), window.innerHeight - 44);
    return { x, y, w, h, min: !!g.min };
  }

  function loadGeometry() {
    return new Promise(resolve => {
      chrome.storage.local.get(['csWidget'], s => {
        resolve(clampGeometry((s && s.csWidget) || defaultGeometry()));
      });
    });
  }

  function saveGeometry() {
    if (floated) return; // the PiP window's internal layout is not page geometry
    const card = ui.card;
    const g = card.classList.contains('hidden')
      ? { x: ui.bubble.offsetLeft, y: ui.bubble.offsetTop, w: ui.lastW, h: ui.lastH, min: true }
      : { x: card.offsetLeft, y: card.offsetTop, w: card.offsetWidth, h: card.offsetHeight, min: false };
    chrome.storage.local.set({ csWidget: clampGeometry(g) });
  }

  function applyGeometry(g) {
    ui.lastW = g.w; ui.lastH = g.h;
    if (g.min) {
      ui.card.classList.add('hidden');
      ui.bubble.classList.remove('hidden');
      ui.bubble.style.left = g.x + 'px';
      ui.bubble.style.top = g.y + 'px';
    } else {
      ui.bubble.classList.add('hidden');
      ui.card.classList.remove('hidden');
      ui.card.style.left = g.x + 'px';
      ui.card.style.top = g.y + 'px';
      ui.card.style.width = g.w + 'px';
      ui.card.style.height = g.h + 'px';
    }
    syncExcludeBox();
  }

  function makeDraggable(handle, getTarget, onEnd) {
    handle.addEventListener('pointerdown', e => {
      if (floated) return; // the OS moves the private window
      if (e.target.closest('button')) return;
      e.preventDefault();
      const target = getTarget();
      const startX = e.clientX, startY = e.clientY;
      const origX = target.offsetLeft, origY = target.offsetTop;
      handle.classList.add('dragging');
      const move = ev => {
        const g = clampGeometry({ x: origX + ev.clientX - startX, y: origY + ev.clientY - startY, w: target.offsetWidth, h: target.offsetHeight, min: target === ui.bubble });
        target.style.left = g.x + 'px';
        target.style.top = g.y + 'px';
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) handle.__justDragged = true;
        syncExcludeBox();
      };
      const up = () => {
        handle.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        maximized = false;
        setTimeout(() => { handle.__justDragged = false; }, 0);
        if (onEnd) onEnd();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  function makeResizable(handle, target, axes, onEnd) {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      const origW = target.offsetWidth, origH = target.offsetHeight;
      const pip = floated ? pipWindow : null; // float mode: resize the OS window
      const move = ev => {
        let w = origW + (axes.x ? ev.clientX - startX : 0);
        let h = origH + (axes.y ? ev.clientY - startY : 0);
        const maxW = pip ? 2400 : window.innerWidth - 16;
        const maxH = pip ? 1600 : window.innerHeight - 16;
        w = Math.min(Math.max(w, MIN_W), maxW);
        h = Math.min(Math.max(h, MIN_H), maxH);
        if (pip) {
          // The card auto-fills the private window via its resize listener.
          try { pip.resizeTo(Math.round(w), Math.round(h)); } catch { /* ignore */ }
        } else {
          target.style.width = w + 'px';
          target.style.height = h + 'px';
          syncExcludeBox();
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        maximized = false;
        if (!pip && onEnd) onEnd();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  // ---- Font scale (A− / A+) ------------------------------------------------

  const FONT_STEPS = [0.85, 1, 1.15, 1.3, 1.5];
  let fontScaleIdx = 1;

  function applyFontScale() {
    if (!ui) return;
    ui.card.style.setProperty('--fs', String(FONT_STEPS[fontScaleIdx]));
    try { chrome.storage.local.set({ csFontScale: fontScaleIdx }); } catch { /* ignore */ }
  }

  // ---- Maximize (double-click the header) -----------------------------------

  let preMaxGeo = null;
  let maximized = false;

  function toggleMaximize() {
    ensureUI();
    if (maximized && preMaxGeo) {
      applyGeometry(preMaxGeo);
      maximized = false;
    } else {
      preMaxGeo = {
        x: ui.card.offsetLeft, y: ui.card.offsetTop,
        w: ui.card.offsetWidth, h: ui.card.offsetHeight, min: false
      };
      applyGeometry({
        x: 8, y: 8,
        w: window.innerWidth - 16, h: window.innerHeight - 16, min: false
      });
      maximized = true;
    }
    saveGeometry();
  }

  function ensureUI() {
    if (ui && ui.host.isConnected) return ui;

    const host = document.createElement('div');
    host.id = 'codesolve-chat-host';
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    const bubble = document.createElement('div');
    bubble.className = 'bubble hidden';
    bubble.title = 'Open CodeSolve chat';
    bubble.textContent = '⚡';

    const card = document.createElement('section');
    card.className = 'chatcard';
    card.innerHTML = `
      <header class="head">
        <span class="dot"></span>
        <span class="brand">CodeSolve</span>
        <span class="priv hidden" title="This chat is being cut out of the active screen share">🛡 hidden from share</span>
        <span class="spacer"></span>
        <button class="hbtn fminus" title="Smaller text">A−</button>
        <button class="hbtn fplus" title="Larger text">A+</button>
        <button class="hbtn ctx on" title="Include this page's content in every answer">📄</button>
        <button class="hbtn floatb" title="Float in a private always-on-top window — invisible when you share this tab or window">🪟</button>
        <button class="hbtn scr hidden" title="Move this window to your other screen">⇄</button>
        <button class="hbtn minb" title="Minimize">—</button>
      </header>
      <div class="msgs">
        <div class="empty">Ask me anything about this page — questions, tasks, code, errors. I read the page automatically; just select anything on it and ask. Paste code too.</div>
      </div>
      <div class="chips">
        <button class="chip" data-q="__solve__">🚀 Solve this problem</button>
        <button class="chip" data-q="__newquestion__">🧹 New question</button>
        <button class="chip" data-q="Explain what this page is asking and what a good solution looks like.">Explain this page</button>
        <button class="chip" data-q="Review the code in my editor (or the code on this page): bugs, edge cases, complexity.">Review my code</button>
      </div>
      <div class="inputrow">
        <textarea class="chatinput" rows="1" placeholder="Ask about this page…"></textarea>
        <button class="send" title="Send">➤</button>
      </div>
      <div class="rs rs-r" title="Drag to resize — width"></div>
      <div class="rs rs-b" title="Drag to resize — height"></div>
      <div class="rs rs-c" title="Drag to resize"></div>
    `;

    shadow.appendChild(bubble);
    shadow.appendChild(card);
    document.documentElement.appendChild(host);

    // Invisible box that mirrors the widget's on-screen footprint. The
    // MAIN-world hook excludes THIS element's region from tab captures, so it
    // must exactly cover the visible widget (plus its shadow/glow).
    let box = document.getElementById('codesolve-exclude-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'codesolve-exclude-box';
      box.style.cssText = 'position:fixed;left:-200px;top:-200px;width:0;height:0;z-index:2147483645;pointer-events:none;background:transparent;border:0;margin:0;';
      (document.body || document.documentElement).appendChild(box);
    }

    ui = {
      host, shadow, bubble, card,
      head: card.querySelector('.head'),
      privEl: card.querySelector('.priv'),
      ctxBtn: card.querySelector('.ctx'),
      floatBtn: card.querySelector('.floatb'),
      scrBtn: card.querySelector('.scr'),
      minBtn: card.querySelector('.minb'),
      fminus: card.querySelector('.fminus'),
      fplus: card.querySelector('.fplus'),
      msgs: card.querySelector('.msgs'),
      chips: card.querySelector('.chips'),
      input: card.querySelector('.chatinput'),
      sendBtn: card.querySelector('.send'),
      rsR: card.querySelector('.rs-r'),
      rsB: card.querySelector('.rs-b'),
      rsC: card.querySelector('.rs-c'),
      lastW: 400, lastH: 560
    };

    makeDraggable(ui.head, () => ui.card, saveGeometry);
    makeDraggable(ui.bubble, () => ui.bubble, saveGeometry);
    makeResizable(ui.rsR, ui.card, { x: true, y: false }, saveGeometry);
    makeResizable(ui.rsB, ui.card, { x: false, y: true }, saveGeometry);
    makeResizable(ui.rsC, ui.card, { x: true, y: true }, saveGeometry);
    applyFontScale();

    ui.head.addEventListener('dblclick', e => {
      if (floated || e.target.closest('button')) return;
      toggleMaximize();
    });

    ui.floatBtn.addEventListener('click', () => (floated ? closeFloat(false) : floatWidget()));
    ui.fminus.addEventListener('click', () => { fontScaleIdx = Math.max(0, fontScaleIdx - 1); applyFontScale(); });
    ui.fplus.addEventListener('click', () => { fontScaleIdx = Math.min(FONT_STEPS.length - 1, fontScaleIdx + 1); applyFontScale(); });
    ui.scrBtn.addEventListener('click', () => moveToOtherScreen());
    ui.minBtn.addEventListener('click', () => {
      if (floated) { closeFloat(true); return; } // minimize lands back on the page
      saveGeometry();
      applyGeometry({ x: ui.card.offsetLeft, y: ui.card.offsetTop, w: ui.card.offsetWidth, h: ui.card.offsetHeight, min: true });
      saveGeometry();
    });
    ui.bubble.addEventListener('click', e => {
      if (ui.bubble.__justDragged) return;
      applyGeometry({ x: ui.bubble.offsetLeft, y: ui.bubble.offsetTop, w: ui.lastW, h: ui.lastH, min: false });
      saveGeometry();
      ui.input.focus();
    });
    ui.ctxBtn.addEventListener('click', () => {
      includePage = !includePage;
      ui.ctxBtn.classList.toggle('on', includePage);
      chrome.storage.local.set({ csIncludePage: includePage });
    });
    ui.sendBtn.addEventListener('click', () => sendChat(ui.input.value));
    ui.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat(ui.input.value);
      }
    });
    ui.input.addEventListener('input', () => {
      ui.input.style.height = 'auto';
      ui.input.style.height = Math.min(ui.input.scrollHeight, 130) + 'px';
    });
    ui.chips.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const q = chip.dataset.q;
      if (q === '__solve__') solveFlow();
      else if (q === '__newquestion__') resetTopic();
      else sendChat(q);
    });

    updateVisibility();
    return ui;
  }

  function openWidget() {
    if (!IS_TOP) return; // the floating chat lives only in the top frame
    ensureUI();
    if (floated && pipWindow) {
      try { pipWindow.focus(); } catch { /* ignore */ }
      return;
    }
    if (!canShow()) return; // hidden during screen capture
    if (ui.card.classList.contains('hidden')) {
      applyGeometry({ x: ui.bubble.offsetLeft, y: ui.bubble.offsetTop, w: ui.lastW, h: ui.lastH, min: false });
      saveGeometry();
    }
    ui.input.focus();
  }

  function minimizeWidget() {
    ensureUI();
    applyGeometry({ x: ui.card.offsetLeft, y: ui.card.offsetTop, w: ui.card.offsetWidth, h: ui.card.offsetHeight, min: true });
    saveGeometry();
  }

  // ---- Private floating window (Document Picture-in-Picture) --------------
  // The chat moves into its own always-on-top OS window. Tab sharing and
  // window sharing NEVER capture a separate window, so the chat stays visible
  // to the user and invisible to everyone on the call.

  let preFloatGeo = null;

  async function floatWidget() {
    ensureUI();
    if (floated || !canShow()) return;
    if (!('documentPictureInPicture' in window)) {
      addMsgEl('ai', 'This Chrome version cannot open the private floating window — update Chrome. The in-page chat is still cut out of tab shares automatically.', 'err');
      return;
    }
    try {
      const w = Math.max(ui.card.offsetWidth || 400, MIN_W);
      const h = Math.max(ui.card.offsetHeight || 560, MIN_H);
      const pip = await documentPictureInPicture.requestWindow({ width: w, height: h });
      preFloatGeo = {
        x: ui.card.offsetLeft, y: ui.card.offsetTop,
        w: ui.card.offsetWidth, h: ui.card.offsetHeight, min: false
      };
      pipWindow = pip;
      floated = true;

      pip.document.body.style.margin = '0';
      pip.document.body.style.background = '#0f172a';
      const pipHost = pip.document.createElement('div');
      pipHost.id = 'codesolve-pip-host';
      pipHost.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;';
      const pipShadow = pipHost.attachShadow({ mode: 'open' });

      // Copy the stylesheet (the page keeps its own) and MOVE the card.
      pipShadow.appendChild(ui.shadow.querySelector('style').cloneNode(true));
      pipShadow.appendChild(ui.card); // appendChild adopts it across documents

      pip.document.body.appendChild(pipHost);

      // Fit the card to the private window.
      ui.card.style.left = '0px';
      ui.card.style.top = '0px';
      ui.card.style.width = pip.innerWidth + 'px';
      ui.card.style.height = pip.innerHeight + 'px';
      ui.lastW = pip.innerWidth;
      ui.lastH = pip.innerHeight;

      ui.floatBtn.classList.add('on');
      ui.floatBtn.title = 'Return the chat to this page';

      addMsgEl('ai', '💡 Private window opened — it stays on top and is never captured by tab or window sharing. Drag it anywhere, even to your other screen.');
      updateScreenBtn();

      pip.addEventListener('resize', () => {
        if (!floated || pipWindow !== pip) return;
        ui.card.style.width = pip.innerWidth + 'px';
        ui.card.style.height = pip.innerHeight + 'px';
        ui.lastW = pip.innerWidth;
        ui.lastH = pip.innerHeight;
      });

      pip.addEventListener('pagehide', () => {
        if (pipWindow === pip) closeFloat(false);
      }, { once: true });

      syncExcludeBox();
    } catch (e) {
      floated = false;
      pipWindow = null;
      addMsgEl('ai', 'Could not open the private floating window: ' + ((e && e.message) || e), 'err');
    }
  }

  function closeFloat(minimize) {
    if (!floated) return;
    floated = false;
    const pip = pipWindow;
    pipWindow = null;
    ui.floatBtn.classList.remove('on');
    ui.floatBtn.title = 'Float in a private always-on-top window — invisible when you share this tab or window';
    ui.scrBtn.classList.add('hidden');

    try {
      const pipHost = pip && pip.document && pip.document.getElementById('codesolve-pip-host');
      if (!pipHost || !pipHost.shadowRoot || !pipHost.shadowRoot.contains(ui.card)) {
        throw new Error('gone');
      }
      ui.shadow.appendChild(ui.card); // appendChild adopts it back to the page
      const geo = preFloatGeo || { x: 24, y: 24, w: ui.lastW, h: ui.lastH, min: false };
      applyGeometry({ ...geo, min: !!minimize });
      saveGeometry();
    } catch (e) {
      // The PiP window died unexpectedly — rebuild the widget on the page.
      ui = null;
      ensureUI();
      applyGeometry({ ...clampGeometry({ x: 24, y: 24, w: MIN_W, h: MIN_H, min: false }), min: !!minimize });
      saveGeometry();
    }
    syncExcludeBox();
  }

  // ---- Dual-screen support -------------------------------------------------
  // The floated chat is a real OS window, so unlike the in-page widget it can
  // live on any monitor — moved there by dragging, or with one click via the
  // ⇄ button (Chrome tells us the monitor layout through system.display).

  function getDisplays() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'GET_DISPLAYS' }, resp => {
          if (chrome.runtime.lastError || !resp || !resp.ok) return resolve(null);
          resolve(Array.isArray(resp.displays) && resp.displays.length ? resp.displays : null);
        });
      } catch { resolve(null); }
    });
  }

  function inDisplay(x, y, d) {
    const b = d.bounds;
    return x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height;
  }

  async function updateScreenBtn() {
    if (!ui || !ui.scrBtn) return;
    if (!floated || !pipWindow) { ui.scrBtn.classList.add('hidden'); return; }
    const displays = await getDisplays();
    ui.scrBtn.classList.toggle('hidden', !(displays && displays.length > 1));
  }

  async function moveToOtherScreen() {
    if (!floated || !pipWindow) return;
    const displays = await getDisplays();
    if (!displays || displays.length < 2) {
      addMsgEl('ai', 'Only one display detected — nothing to move to.');
      return;
    }
    const px = pipWindow.screenX || 0;
    const py = pipWindow.screenY || 0;
    const pw = pipWindow.outerWidth || 400;
    const ph = pipWindow.outerHeight || 560;
    const cur = displays.find(d => inDisplay(px + pw / 2, py + ph / 2, d)) || displays[0];
    const others = displays.filter(d => d !== cur);
    if (!others.length) return;
    const target = (others[0].workArea && others[0].workArea.width) ? others[0].workArea : others[0].bounds;
    const x = Math.round(target.left + Math.max(0, (target.width - pw) / 2));
    const y = Math.round(target.top + Math.max(0, (target.height - ph) / 2));

    let moved = false;
    try {
      pipWindow.moveTo(x, y);
      await new Promise(r => setTimeout(r, 220));
      const dx = Math.abs((pipWindow.screenX || 0) - px);
      const dy = Math.abs((pipWindow.screenY || 0) - py);
      moved = dx + dy > 40;
    } catch { moved = false; }
    if (!moved) {
      addMsgEl('ai', 'Chrome blocked the automatic move — just drag this window to your other screen with the mouse. It stays on top and stays private.');
    }
  }

  // ------------------------------------------------------------ rendering

  function scrollToBottom() {
    ui.msgs.scrollTop = ui.msgs.scrollHeight;
  }

  function addMsgEl(role, text, extraClass) {
    ensureUI();
    const empty = ui.msgs.querySelector('.empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
    if (text != null) el.textContent = text;
    ui.msgs.appendChild(el);
    scrollToBottom();
    return el;
  }

  // Split on fenced code blocks; an unterminated trailing fence (while
  // streaming) is rendered as an in-progress code block.
  function splitFences(text) {
    const parts = [];
    const re = /```([^\n`]*)\n([\s\S]*?)(```|$)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push({ type: 'text', content: text.slice(last, m.index) });
      parts.push({ type: 'code', lang: (m[1] || '').trim(), content: m[2].replace(/\n+$/, '') });
      last = re.lastIndex;
      if (m[3] !== '```') break; // unterminated fence — consumed the rest
    }
    if (last < text.length) parts.push({ type: 'text', content: text.slice(last) });
    return parts;
  }

  function inlineFormat(target, text) {
    // Minimal, injection-safe: **bold** and `inline code` → styled spans.
    const re = /(\*\*[^*]+\*\*|`[^`\n]+`)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('**')) {
        const b = document.createElement('b');
        b.textContent = tok.slice(2, -2);
        target.appendChild(b);
      } else {
        const c = document.createElement('code');
        c.className = 'inline';
        c.textContent = tok.slice(1, -1);
        target.appendChild(c);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
  }

  function makeCodeBlock(lang, code) {
    const wrap = document.createElement('div');
    wrap.className = 'codeblock';

    const head = document.createElement('div');
    head.className = 'cbhead';
    const langEl = document.createElement('span');
    langEl.className = 'lang';
    langEl.textContent = lang || sniffLanguage(code) || 'code';
    const sp = document.createElement('span');
    sp.className = 'spacer';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); } catch { /* ignore */ }
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
    });
    const typeBtn = document.createElement('button');
    typeBtn.textContent = '⌨️ Type';
    typeBtn.title = 'Type this code into the page editor like a human';
    typeBtn.addEventListener('click', () => typeCode(code, wrap));
    head.appendChild(langEl);
    head.appendChild(sp);
    head.appendChild(copyBtn);
    head.appendChild(typeBtn);

    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    pre.appendChild(codeEl);

    wrap.appendChild(head);
    wrap.appendChild(pre);
    return wrap;
  }

  function renderAI(target, text, opts = {}) {
    target.textContent = '';
    const body = document.createElement('div');
    body.className = 'mtext';
    target.appendChild(body);

    for (const part of splitFences(text)) {
      if (part.type === 'code') {
        body.appendChild(makeCodeBlock(part.lang, part.content));
      } else if (part.content.trim()) {
        const seg = document.createElement('span');
        inlineFormat(seg, part.content);
        body.appendChild(seg);
      }
    }
    if (opts.streaming) {
      const cur = document.createElement('span');
      cur.className = 'cursor';
      body.appendChild(cur);
    }
    scrollToBottom();
  }

  // -------------------------------------------------------------- actions

  // Drop the model's conversation history — used when moving to a new
  // question so earlier answers can't bleed into the next one.
  function resetTopic() {
    ensureUI();
    chatHistory = [];
    saveChatHistory();
    const note = addMsgEl('ai', '🧹 Fresh start — previous questions cleared from my context. Ask about the question now on screen (or select part of it first for precision).');
    note.classList.add('thinking');
    setTimeout(() => note.remove(), 3500);
  }

  // Conversation memory survives page reloads (per tab, via sessionStorage).
  function saveChatHistory() {
    try { sessionStorage.setItem('csChatHistory', JSON.stringify(chatHistory.slice(-30))); } catch { /* ignore */ }
  }

  function loadChatHistory() {
    try {
      const raw = sessionStorage.getItem('csChatHistory');
      const arr = raw ? JSON.parse(raw) : [];
      chatHistory = Array.isArray(arr) ? arr.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
    } catch { chatHistory = []; }
  }

  async function sendChat(raw) {
    const text = (raw || '').trim();
    if (!text || chatBusy) return;
    ensureUI();
    chatBusy = true;
    ui.sendBtn.disabled = true;

    addMsgEl('user', text);
    ui.input.value = '';
    ui.input.style.height = 'auto';

    const aiEl = addMsgEl('ai', '', 'thinking');
    aiEl.textContent = 'Reading this page (including embedded panels)…';

    const acc = { text: '' };
    const port = chrome.runtime.connect({ name: 'chat-stream' });
    ui.__chatPort = port;

    port.onMessage.addListener(m => {
      if (m.chunk) {
        acc.text += m.chunk;
        if (aiEl.classList.contains('thinking')) aiEl.classList.remove('thinking');
        renderAI(aiEl, acc.text, { streaming: true });
      } else if (m.done) {
        finish(acc.text || '(empty response)');
      } else if (m.error) {
        aiEl.classList.add('err');
        finish('⚠ ' + m.error);
      }
    });

    function finish(finalText) {
      try { port.disconnect(); } catch { /* already closed */ }
      ui.__chatPort = null;
      chatBusy = false;
      ui.sendBtn.disabled = false;
      chatHistory.push({ role: 'user', content: text });
      chatHistory.push({ role: 'assistant', content: finalText });
      if (chatHistory.length > 30) chatHistory = chatHistory.slice(-30);
      saveChatHistory();
      renderAI(aiEl, finalText);
    }

    try {
      const context = await buildPageContext(includePage);
      port.postMessage({
        type: 'CHAT_STREAM',
        question: text,
        history: chatHistory.slice(-16),
        context
      });
    } catch (e) {
      finish('⚠ Could not read the page: ' + ((e && e.message) || e));
    }
  }

  function solveFlow() {
    if (chatBusy) return;
    ensureUI();
    chatBusy = true;
    ui.sendBtn.disabled = true;

    addMsgEl('user', '🚀 Solve this problem');

    const settingsGet = new Promise(resolve =>
      chrome.storage.local.get(null, s => resolve(s || {}))
    );

    (async () => {
      const settings = await settingsGet;
      const problem = await buildFrameContext(900);
      const language = detectLanguage() || settings.language || CFG.DEFAULT_LANGUAGE;

      const aiEl = addMsgEl('ai', `Solving${language ? ' (' + language + ')' : ''}… reading the page and your editor.`, 'thinking');

      chrome.runtime.sendMessage(
        {
          type: 'SOLVE',
          problem: cap(problem, 22000),
          language,
          platform: SITE,
          starterCode: readEditorText()
        },
        resp => {
          chatBusy = false;
          ui.sendBtn.disabled = false;
          aiEl.classList.remove('thinking');

          if (chrome.runtime.lastError) {
            aiEl.classList.add('err');
            aiEl.textContent = 'Extension error: ' + chrome.runtime.lastError.message + ' — reload the page and try again.';
            return;
          }
          if (!resp || !resp.ok) {
            aiEl.classList.add('err');
            aiEl.textContent = (resp && resp.error) || 'Unknown error.';
            return;
          }

          const full = [
            resp.approach || '',
            resp.code ? '```' + languageTag(language) + '\n' + resp.code + '\n```' : '',
            resp.complexity || ''
          ].filter(Boolean).join('\n\n');
          renderAI(aiEl, full);

          if (resp.verdict && resp.verdict.note) {
            const v = document.createElement('div');
            v.className = 'verdict' + (resp.verdict.passed === false ? ' warn' : '');
            v.textContent = (resp.verdict.passed === false ? '⚠ Self-check: ' : '✓ Self-check: ') + resp.verdict.note.slice(0, 240);
            aiEl.appendChild(v);
          }
          scrollToBottom();
        }
      );
    })();
  }

  function languageTag(lang) {
    const map = { 'Python 3': 'python', 'Python 2': 'python', 'C++': 'cpp', Java: 'java', JavaScript: 'javascript', 'C#': 'csharp', C: 'c', Go: 'go', Rust: 'rust' };
    return map[lang] || (lang || '').toLowerCase().replace(/\s+/g, '-');
  }

  // Type code into the page editor with human cadence; progress shows inline
  // under the code block, with a Stop button.
  async function typeCode(code, codeblockEl) {
    if (!TYPER) {
      addMsgEl('ai', 'Typing engine unavailable — use Copy instead.', 'err');
      return;
    }
    if (!code || !code.trim()) return;

    let adapter = null;
    for (let i = 0; i < 10 && !adapter; i++) {
      adapter = TYPER.findEditor();
      if (!adapter) await new Promise(r => setTimeout(r, 500));
    }
    if (!adapter) {
      addMsgEl('ai', 'No code editor found on this page — use Copy instead.', 'err');
      return;
    }

    const settings = await new Promise(resolve => chrome.storage.local.get(null, s => resolve(s || {})));
    const token = ++typingRun;
    let cancelled = false;

    const status = document.createElement('div');
    status.className = 'typestatus';
    const label = document.createElement('span');
    label.textContent = 'Typing… 0%';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'fill';
    bar.appendChild(fill);
    const stopBtn = document.createElement('button');
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', () => { cancelled = true; });
    status.appendChild(label);
    status.appendChild(bar);
    status.appendChild(stopBtn);
    codeblockEl.appendChild(status);

    let res;
    try {
      res = await TYPER.humanType(adapter, code, {
        speed: settings.typingSpeed || CFG.DEFAULT_TYPING_SPEED,
        typos: settings.humanTypos !== false,
        cancelled: () => cancelled || token !== typingRun,
        onProgress: (f, line, total) => {
          if (token !== typingRun) return;
          fill.style.width = Math.round(f * 100) + '%';
          label.textContent = `Typing… ${Math.round(f * 100)}% (line ${line}/${total})`;
        }
      });
    } finally {
      if (token === typingRun) status.remove();
    }
    if (token !== typingRun) return;

    const note = document.createElement('div');
    note.className = 'verdict' + (res.cancelled ? ' warn' : '');
    if (res.cancelled) {
      note.textContent = `⚠ Typing stopped at ${Math.round((res.typed / Math.max(1, res.total)) * 100)}%.`;
    } else {
      const verdict = TYPER.looksComplete(adapter, code);
      note.textContent = verdict === true
        ? '✓ Typed — the editor matches this code.'
        : verdict === false
          ? '⚠ Typed, but the editor differs — check indentation.'
          : `✓ Typed ${res.typed} characters — review the editor.`;
    }
    codeblockEl.appendChild(note);
  }

  // ------------------------------------------------------------- plumbing

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
    } else if (msg.type === 'CAPTURE_STATE') {
      // Broadcast from the background: capture started/ended in ANY tab.
      globalCaptureActive = !!msg.active;
      updateVisibility();
      sendResponse({ ok: true });
    } else if (msg.type === 'SHOW_CHATBOT') {
      openWidget();
      sendResponse({ ok: true });
    } else if (msg.type === 'ASK_SELECTION') {
      openWidget();
      const sel = String(msg.selection || '').trim();
      if (sel) ui.input.value = sel + '\n';
      ui.input.focus();
      sendResponse({ ok: true });
    }
    return true;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) setEnabled(!!changes.enabled.newValue);
  });

  function setEnabled(isEnabled) {
    enabledState = isEnabled !== false;
    if (!IS_TOP) return; // frames have no widget
    ensureUI();
    updateVisibility();
  }

  // The MAIN-world hook (capture-hook.js) fires this when this page starts or
  // stops a screen capture. detail: {active, surface: 'browser'|'other',
  // excluded} — excluded=true means the hook cut the widget's region out of a
  // tab capture, so the widget can stay visible on screen.
  window.addEventListener('__csCaptureEvent', e => {
    const d = e.detail || {};
    const active = !!d.active;

    if (!active) {
      ownCaptureActive = false;
      setPrivateBadge(false);
      reportCapture(false);
      updateVisibility();
      return;
    }

    if (floated) {
      // The chat lives in a separate always-on-top window: a tab capture of
      // this page cannot contain it at all. Window/monitor captures CAN, so
      // the private window closes until the capture ends.
      if (d.surface === 'browser') {
        setPrivateBadge(true);
        reportCapture(true, false); // nothing of ours in the shared video
      } else {
        setPrivateBadge(false);
        closeFloat(false);
        ownCaptureActive = true;
        reportCapture(true, true);
      }
    } else if (d.excluded) {
      // Widget is cut out of the shared tab video — stay visible to the user.
      setPrivateBadge(true);
      ownCaptureActive = false;
      reportCapture(true, false);
    } else {
      // Window / monitor capture, or exclusion unsupported — hide.
      setPrivateBadge(false);
      ownCaptureActive = true;
      reportCapture(true, true);
    }
    updateVisibility();
  });

  // While a "hide everywhere" capture is live, re-report periodically so the
  // background keeps accurate state even if its service worker restarts.
  setInterval(() => {
    if (ownCaptureActive) reportCapture(true, true);
  }, 7000);

  // Sync the initial cross-tab capture state (background persists it in
  // chrome.storage.session).
  try {
    if (chrome.storage.session) {
      chrome.storage.session.get('csCaptureActive', s => {
        globalCaptureActive = !!(s && s.csCaptureActive);
        updateVisibility();
      });
    }
  } catch { /* session storage unavailable */ }

  // SPA navigation / DOM re-render safety net: keep the widget attached and
  // inside the viewport, and keep the capture-hidden state applied.
  setInterval(() => {
    try {
      if (!IS_TOP) return; // frames: nothing to re-attach
      if (!ui || !ui.host.isConnected) {
        if (floated) closeFloat(false); // rebuild on the page; user can re-float
        ensureUI();
        updateVisibility();
      }
      if (canShow() && !floated) {
        const g = ui.card.classList.contains('hidden')
          ? { x: ui.bubble.offsetLeft, y: ui.bubble.offsetTop, w: ui.lastW, h: ui.lastH, min: true }
          : { x: ui.card.offsetLeft, y: ui.card.offsetTop, w: ui.card.offsetWidth, h: ui.card.offsetHeight, min: false };
        const g2 = clampGeometry(g);
        if (g2.x !== g.x || g2.y !== g.y) applyGeometry(g2);
      }
    } catch { /* page unloading */ }
  }, 2500);

  (async () => {
    if (!IS_TOP) return; // frames only participate in the context handshake
    loadChatHistory();
    const settings = await new Promise(resolve => chrome.storage.local.get(null, s => resolve(s || {})));
    if (typeof settings.csIncludePage === 'boolean') includePage = settings.csIncludePage;
    if (Number.isInteger(settings.csFontScale)) {
      fontScaleIdx = Math.min(FONT_STEPS.length - 1, Math.max(0, settings.csFontScale));
    }
    setEnabled(settings.enabled !== false);

    const geo = await loadGeometry();
    if (typeof settings.typingSpeed === 'string') { /* used per-type via storage */ }
    ensureUI();
    ui.ctxBtn.classList.toggle('on', includePage);
    applyGeometry(geo);
  })();

  // Exposed on the content-script world only — used by dev tests.
  window.__codesolveDebug = {
    extractProblem, extractStarterCode, detectLanguage, extractTitle,
    readEditorText, buildPageContext, pageContextText, collectPageRegions,
    openWidget, minimizeWidget, sendChat, solveFlow, typeCode,
    findEditor: () => (TYPER ? TYPER.findEditor() : null)
  };
})();
