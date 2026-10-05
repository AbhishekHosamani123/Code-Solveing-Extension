// typer.js — editor adapters + human-like typing engine (content-script world).
// Loaded before content.js. Exposes window.__codesolveTyper.
//
// The engine never "pastes": every character goes through the same insertion
// path a real keystroke would (execCommand('insertText'), which the editors
// handle exactly like typing), with jittered delays, occasional typos that are
// corrected with Backspace, and per-line indentation normalization so editor
// auto-indent can never corrupt the code.
(() => {
  if (window.__codesolveTyper) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const NBSP = /\u00a0/g;
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent || '');

  // Base delay (ms) per character by speed setting. Jitter multiplies this.
  const SPEED_BASE = { slow: 190, normal: 75, fast: 30 };

  function normalize(s) {
    return String(s == null ? '' : s).replace(NBSP, ' ').replace(/\r/g, '');
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 80 && r.height >= 24;
  }

  function area(el) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }

  // ---------------------------------------------------------- low-level ops

  function execInsert(text) {
    try { return document.execCommand('insertText', false, text); } catch { return false; }
  }

  // el must already be focused. text is one character, '\n', or a short
  // indent string — the engine never inserts anything longer.
  function focusedInsertUnit(el, text) {
    if (execInsert(text)) return true;

    if (el && el.tagName === 'TEXTAREA') {
      const s = el.selectionStart == null ? el.value.length : el.selectionStart;
      const e = el.selectionEnd == null ? s : el.selectionEnd;
      if (el.setRangeText) el.setRangeText(text, s, e, 'end');
      else el.value = el.value.slice(0, s) + text + el.value.slice(e);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      return true;
    }

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    if (text === '\n') {
      range.insertNode(document.createElement('br'));
    } else {
      range.insertNode(document.createTextNode(text));
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return true;
  }

  // Synthetic Backspace. Editors with keymaps (CodeMirror/Monaco/ACE) react to
  // the keydown and preventDefault; if nobody handles it, fall back to
  // execCommand('delete') which browsers apply to the focused editable.
  function focusedBackspace(el) {
    if (!el) return;
    const ev = new KeyboardEvent('keydown', {
      key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8,
      bubbles: true, cancelable: true
    });
    el.dispatchEvent(ev);
    if (!ev.defaultPrevented) {
      try { document.execCommand('delete'); } catch { /* ignore */ }
    }
  }

  function dispatchSelectAll(target) {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', code: 'KeyA', ctrlKey: !isMac, metaKey: isMac,
      keyCode: 65, which: 65, bubbles: true, cancelable: true
    }));
  }

  function domSelectAll(el) {
    if (!el) return;
    if (el.tagName === 'TEXTAREA') { el.focus(); el.select(); return; }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ------------------------------------------------------------- adapters

  function cm6Adapter(root) {
    const content = root.querySelector('.cm-content');
    return {
      name: 'codemirror6',
      async focus() {
        try { root.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
        content.focus();
      },
      async selectAll() {
        dispatchSelectAll(content);
        await sleep(25);
        domSelectAll(content);
      },
      insertUnit(text) { return focusedInsertUnit(content, text); },
      backspace() { focusedBackspace(content); },
      deleteFallback() { try { document.execCommand('delete'); } catch { /* ignore */ } },
      currentLineText() {
        const active = root.querySelector('.cm-activeLine');
        return active ? normalize(active.textContent) : null;
      },
      readAll() {
        const lines = root.querySelectorAll('.cm-content .cm-line');
        if (lines.length) return Array.from(lines).map(l => normalize(l.textContent)).join('\n');
        return normalize(content.textContent);
      }
    };
  }

  function cm5Adapter(root) {
    const ta = root.querySelector('textarea');
    return {
      name: 'codemirror5',
      async focus() {
        try { root.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
        if (ta) ta.focus();
      },
      async selectAll() { if (ta) dispatchSelectAll(ta); },
      insertUnit(text) { return focusedInsertUnit(ta, text); },
      backspace() { focusedBackspace(ta); },
      deleteFallback() { try { document.execCommand('delete'); } catch { /* ignore */ } },
      currentLineText() {
        const line = root.querySelector('.CodeMirror-activeline');
        return line ? normalize(line.textContent) : null;
      },
      readAll() {
        const lines = root.querySelectorAll('.CodeMirror-line');
        return lines.length ? Array.from(lines).map(l => normalize(l.textContent)).join('\n') : '';
      }
    };
  }

  function monacoLineText(root) {
    const cursor = root.querySelector('.cursors-layer .cursor');
    const lines = root.querySelectorAll('.view-lines .view-line');
    if (!cursor || !lines.length) return null;
    const top = cursor.offsetTop;
    let best = null, bestD = Infinity;
    for (const ln of lines) {
      const d = Math.abs(ln.offsetTop - top);
      if (d < bestD) { bestD = d; best = ln; }
    }
    return best && bestD < 8 ? normalize(best.textContent) : null;
  }

  function monacoAdapter(root) {
    const ta = root.querySelector('textarea.inputarea') || root.querySelector('textarea');
    return {
      name: 'monaco',
      async focus() {
        try { root.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
        if (ta) ta.focus();
      },
      async selectAll() { if (ta) dispatchSelectAll(ta); },
      onTypeStart() { return monacoBridgeOp({ op: 'typeStart' }); },
      onTypeEnd() { return monacoBridgeOp({ op: 'typeEnd' }); },
      insertUnit(text) {
        // Monaco builds that ignore synthetic textarea edits are driven
        // through the MAIN-world bridge (Monaco's own 'type' command).
        if (monacoBridgeReady) return monacoBridgeInsert(text);
        return focusedInsertUnit(ta, text);
      },
      backspace() { focusedBackspace(ta); },
      deleteFallback() { try { document.execCommand('delete'); } catch { /* ignore */ } },
      currentLineText() { return monacoLineText(root); },
      readAll() {
        const lines = root.querySelectorAll('.view-lines .view-line');
        return lines.length ? Array.from(lines).map(l => normalize(l.textContent)).join('\n') : '';
      }
    };
  }

  // ------------------------------------------------------------ Monaco bridge

  let monacoBridgeReady = false;

  // Injects monaco-bridge.js into the page's MAIN world via the background
  // (content scripts cannot reach page JS), then verifies it responds to pings.
  async function ensureMonacoBridge() {
    if (monacoBridgeReady) return true;
    if (!monacoHostCandidate()) return false;
    try {
      await new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage({ type: 'INJECT_MAIN', file: 'monaco-bridge.js' }, resp => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(resp);
          });
        } catch (e) { reject(e); }
      });
    } catch {
      return false; // no background access (e.g. dev harness) — fall back below
    }
    monacoBridgeReady = await pingMonacoBridge();
    return monacoBridgeReady;
  }

  function monacoHostCandidate() {
    return !!document.querySelector('.monaco-editor textarea.inputarea');
  }

  function pingMonacoBridge() {
    return new Promise(resolve => {
      document.documentElement.removeAttribute('data-cs-monaco-result');
      window.dispatchEvent(new CustomEvent('__csMonacoType', { detail: { op: 'ping' } }));
      resolve(document.documentElement.getAttribute('data-cs-monaco-result') === 'pong');
    });
  }

  function monacoBridgeInsert(text) {
    document.documentElement.removeAttribute('data-cs-monaco-result');
    window.dispatchEvent(new CustomEvent('__csMonacoType', { detail: { op: 'insert', text } }));
    return document.documentElement.getAttribute('data-cs-monaco-result') === 'ok';
  }

  function monacoBridgeOp(detail) {
    try {
      document.documentElement.removeAttribute('data-cs-monaco-result');
      window.dispatchEvent(new CustomEvent('__csMonacoType', { detail }));
      return document.documentElement.getAttribute('data-cs-monaco-result') === 'ok';
    } catch {
      return false;
    }
  }

  function aceLineText(root) {
    const cursor = root.querySelector('.ace_cursor');
    const line = cursor && cursor.closest('.ace_line');
    return line ? normalize(line.textContent) : null;
  }

  function aceAdapter(root) {
    const ta = root.querySelector('textarea.ace_text-input') || root.querySelector('textarea');
    return {
      name: 'ace',
      async focus() {
        try { root.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
        if (ta) ta.focus();
      },
      async selectAll() { if (ta) dispatchSelectAll(ta); },
      insertUnit(text) { return focusedInsertUnit(ta, text); },
      backspace() { focusedBackspace(ta); },
      deleteFallback() { try { document.execCommand('delete'); } catch { /* ignore */ } },
      currentLineText() { return aceLineText(root); },
      readAll() {
        const lines = root.querySelectorAll('.ace_line');
        return lines.length ? Array.from(lines).map(l => normalize(l.textContent)).join('\n') : '';
      }
    };
  }

  function textareaAdapter(el) {
    return {
      name: 'textarea',
      async focus() {
        try { el.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
        el.focus();
      },
      async selectAll() { el.focus(); el.select(); },
      insertUnit(text) { return focusedInsertUnit(el, text); },
      backspace() {
        const s = el.selectionStart == null ? el.value.length : el.selectionStart;
        const e = el.selectionEnd == null ? s : el.selectionEnd;
        if (s !== e) el.setRangeText ? el.setRangeText('', s, e, 'end') : (el.value = el.value.slice(0, s) + el.value.slice(e));
        else if (s > 0) el.setRangeText ? el.setRangeText('', s - 1, s, 'end') : (el.value = el.value.slice(0, s - 1) + el.value.slice(s));
        else return;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      },
      deleteFallback() { this.backspace(); },
      currentLineText() {
        const pos = el.selectionStart == null ? 0 : el.selectionStart;
        const start = el.value.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
        const nl = el.value.indexOf('\n', pos);
        const end = nl === -1 ? el.value.length : nl;
        return el.value.slice(start, end);
      },
      readAll() { return el.value; }
    };
  }

  function contenteditableAdapter(el) {
    return {
      name: 'contenteditable',
      async focus() {
        try { el.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
        el.focus();
      },
      async selectAll() { domSelectAll(el); },
      insertUnit(text) { return focusedInsertUnit(el, text); },
      backspace() { focusedBackspace(el); },
      deleteFallback() { try { document.execCommand('delete'); } catch { /* ignore */ } },
      currentLineText() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return '';
        const anchor = sel.anchorNode;
        if (!anchor || !el.contains(anchor)) return null;
        let block = anchor.nodeType === 1 ? anchor : anchor.parentElement;
        while (block && block !== el && block.parentElement !== el) block = block.parentElement;
        if (!block || block === el) return '';
        return normalize(block.textContent);
      },
      readAll() { return normalize(el.innerText || el.textContent || ''); }
    };
  }

  // --------------------------------------------------------- editor lookup

  function findEditor() {
    const cands = [];
    const push = (prio, root, make) => {
      if (!visible(root)) return;
      cands.push({ prio, area: area(root), make, root });
    };

    document.querySelectorAll('.cm-editor').forEach(r => {
      if (r.querySelector('.cm-content')) push(0, r, cm6Adapter);
    });
    document.querySelectorAll('.CodeMirror').forEach(r => {
      if (r.querySelector('textarea')) push(1, r, cm5Adapter);
    });
    document.querySelectorAll('.monaco-editor').forEach(r => push(2, r, monacoAdapter));
    document.querySelectorAll('.ace_editor').forEach(r => push(3, r, aceAdapter));
    document.querySelectorAll('textarea').forEach(ta => {
      if (ta.closest('.CodeMirror, .monaco-editor, .ace_editor')) return;
      if (ta.readOnly || ta.disabled) return;
      push(4, ta, textareaAdapter);
    });
    document.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach(el => {
      if (el.closest('.cm-editor')) return;
      push(5, el, contenteditableAdapter);
    });

    if (!cands.length) return null;
    cands.sort((a, b) => a.prio - b.prio || b.area - a.area);
    return cands[0].make(cands[0].root);
  }

  // ------------------------------------------------------- typing engine

  const NEIGHBORS = {
    q: 'w', w: 'e', e: 'r', r: 't', t: 'y', y: 'u', u: 'i', i: 'o', o: 'p',
    a: 's', s: 'd', d: 'f', f: 'g', g: 'h', h: 'j', j: 'k', k: 'l',
    z: 'x', x: 'c', c: 'v', v: 'b', b: 'n', n: 'm'
  };

  function typoChar(ch) {
    const low = ch.toLowerCase();
    const nb = NEIGHBORS[low] || (low === 'l' ? 'k' : low === 'p' ? 'o' : 'x');
    return ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? nb.toUpperCase() : nb;
  }

  // After a typed newline, editors may have auto-indented the new line.
  // Remove that whitespace so the code's own exact indentation can be typed.
  // Only ever backspaces while the cursor line is observed to be empty —
  // if the line can't be read, nothing is deleted.
  async function clearAutoIndent(adapter) {
    for (let guard = 0; guard < 80; guard++) {
      let line = adapter.currentLineText();
      if (line == null) return;
      line = normalize(line);
      if (line.length === 0 || !/^[ \t]*$/.test(line)) return;
      const before = line.length;
      adapter.backspace();
      await sleep(18);
      const after = normalize(adapter.currentLineText() || '');
      if (after.length >= before) {
        adapter.deleteFallback();
        await sleep(18);
        const after2 = normalize(adapter.currentLineText() || '');
        if (after2.length >= before) return; // can't make progress — stop
      }
    }
  }

  // code: full solution text. opts: { speed, typos, cancelled, onProgress }.
  async function humanType(adapter, code, opts = {}) {
    const base = SPEED_BASE[opts.speed] || SPEED_BASE.normal;
    const typosOn = opts.typos !== false;
    const cancelled = opts.cancelled || (() => false);
    const onProgress = opts.onProgress || (() => {});

    const text = String(code).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
    const lines = text.split('\n');
    const totalChars = text.length + Math.max(0, lines.length - 1);
    let done = 0;

    const finish = () => ({ cancelled: cancelled(), typed: done, total: totalChars });

    await adapter.focus();
    await sleep(70);
    await adapter.selectAll();
    await sleep(50);

    if (adapter.name === 'monaco' && !monacoBridgeReady) {
      await ensureMonacoBridge();
    }
    if (adapter.onTypeStart) adapter.onTypeStart();

    try {
      for (let li = 0; li < lines.length; li++) {
        if (cancelled()) return finish();
        const raw = lines[li];
        const indent = raw.match(/^[ \t]*/)[0];
        const body = raw.slice(indent.length);

        if (li > 0) {
          await adapter.insertUnit('\n');
          done += 1;
          await sleep(rand(base * 0.9, base * 2.0));
          await clearAutoIndent(adapter);
          if (indent) {
            await adapter.insertUnit(indent);
            done += indent.length;
            await sleep(rand(base * 0.3, base * 0.9));
          }
        } else if (indent) {
          await adapter.insertUnit(indent);
          done += indent.length;
        }

        for (let ci = 0; ci < body.length; ci++) {
          if (cancelled()) return finish();
          const ch = body[ci];

          if (typosOn && /[a-z]/i.test(ch) && Math.random() < 0.016) {
            await adapter.insertUnit(typoChar(ch));
            await sleep(rand(140, 420));
            await adapter.backspace();
            await sleep(rand(30, 110));
          }

          await adapter.insertUnit(ch);
          done += 1;

          let d = rand(base * 0.45, base * 1.65);
          if ('{}();:,.=<>+-*/!&|[]'.includes(ch)) d += rand(15, 110);
          if (Math.random() < 0.02) d += rand(220, 850);
          onProgress(Math.min(1, done / totalChars), li + 1, lines.length);
          await sleep(d);
        }
        onProgress(Math.min(1, done / totalChars), li + 1, lines.length);
      }
    } finally {
      if (adapter.onTypeEnd) adapter.onTypeEnd();
    }
    return finish();
  }

  // Best-effort read-back verification. Returns true (exact match after
  // ignoring trailing whitespace), false (readable and different) or null
  // (the editor virtualizes off-screen lines, so nothing can be concluded).
  function looksComplete(adapter, code) {
    let actual = '';
    try { actual = adapter.readAll(); } catch { return null; }
    if (!actual) return null;
    const lines = String(code).replace(/\r\n?/g, '\n').split('\n');
    const first = lines[0].trim();
    const last = lines[lines.length - 1].trim();
    if (!last) return null;
    if (!actual.includes(first) || !actual.includes(last)) return null;

    const norm = s => s.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').trim();
    return norm(actual) === norm(String(code));
  }

  window.__codesolveTyper = { findEditor, humanType, looksComplete, ensureMonacoBridge, SPEED_BASE };
})();
