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
      },
      readLines() {
        const els = root.querySelectorAll('.cm-content .cm-line');
        if (els.length) return Array.from(els).map(l => normalize(l.textContent));
        const t = normalize(content.textContent);
        return t ? t.split('\n') : [];
      },
      selectRange(startLine, endLine) {
        try {
          const els = root.querySelectorAll('.cm-content .cm-line');
          if (!els.length || startLine < 1 || endLine < startLine) return false;
          const s = els[Math.max(0, startLine - 1)], e = els[Math.min(els.length - 1, endLine - 1)];
          if (!s || !e) return false;
          const range = document.createRange();
          range.setStartBefore(s); range.setEndAfter(e);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          content.focus(); return true;
        } catch { return false; }
      },
      replaceSelection(text) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) { sel.deleteContents(); sel.collapseToEnd(); }
        content.focus();
        try { document.execCommand('insertText', false, String(text || '')); } catch {}
        content.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(text || ''), inputType: 'insertText' }));
        return true;
      }
    };
  }

  function cm5Adapter(root) {
    const ta = root.querySelector('textarea');
    function cm5Lines() {
      const els = root.querySelectorAll('.CodeMirror-line');
      if (els.length) return Array.from(els).map(l => normalize(l.textContent));
      if (ta) return normalize(ta.value).split('\n');
      return [];
    }
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
      },
      readLines() { return cm5Lines(); },
      selectRange(startLine, endLine) {
        if (!ta) return false;
        const lines = cm5Lines();
        let s=0, e=ta.value.length;
        if (startLine>=1) { let off=0; for(let i=0;i<startLine-1&&i<lines.length;i++) off += lines[i].length+1; s=off; }
        if (endLine>=startLine) { let off=0; for(let i=0;i<endLine&&i<lines.length;i++) off += lines[i].length+1; e=off>0?off-1:ta.value.length; if(e>ta.value.length) e=ta.value.length; }
        try { ta.focus(); ta.setSelectionRange(Math.max(0,s), Math.max(s,e)); } catch {}
        return true;
      },
      replaceSelection(text) {
        if (!ta) return false;
        const s=ta.selectionStart??ta.value.length, e=ta.selectionEnd??s;
        if (ta.setRangeText) ta.setRangeText(String(text||''), s, e, 'end'); else ta.value = ta.value.slice(0,s)+String(text||'')+ta.value.slice(e);
        ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(text||''), inputType: 'insertText' }));
        return true;
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
        if (monacoBridgeReady) return monacoBridgeInsert(text);
        return focusedInsertUnit(ta, text);
      },
      backspace() { focusedBackspace(ta); },
      deleteFallback() { try { document.execCommand('delete'); } catch { /* ignore */ } },
      currentLineText() { return monacoLineText(root); },
      readAll() {
        // Prefer the editor model via the bridge (virtualised lines are invisible in the DOM).
        if (monacoBridgeReady) {
          const info = monacoBridgeGetLines();
          if (info && typeof info.text === 'string' && info.text.length) return info.text;
        }
        const lines = root.querySelectorAll('.view-lines .view-line');
        return lines.length ? Array.from(lines).map(l => normalize(l.textContent)).join('\n') : '';
      },
      getEditorState() {
        if (!monacoBridgeReady) return null;
        return monacoBridgeGetLines();
      },
      selectRange(startLine, endLine, startCol, endCol) {
        if (!monacoBridgeReady) return false;
        return monacoBridgeSelectRange(startLine, endLine, startCol, endCol);
      },
      // For selection-based edits: replace whatever is currently selected with a single insert.
      replaceSelection(text) {
        if (ta) { ta.focus(); }
        // Monaco's 'type' command with a non-collapsed selection replaces it.
        if (monacoBridgeReady) return monacoBridgeInsert(String(text || ''));
        return focusedInsertUnit(ta, String(text || ''));
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

  function monacoBridgeGetLines() {
    try {
      document.documentElement.removeAttribute('data-cs-monaco-lines');
      document.documentElement.removeAttribute('data-cs-monaco-result');
      window.dispatchEvent(new CustomEvent('__csMonacoType', { detail: { op: 'getLines' } }));
      const raw = document.documentElement.getAttribute('data-cs-monaco-lines') || '';
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  function monacoBridgeSelectRange(startLine, endLine, startCol, endCol) {
    try {
      document.documentElement.removeAttribute('data-cs-monaco-result');
      window.dispatchEvent(new CustomEvent('__csMonacoType', { detail: { op: 'selectRange', startLine, endLine, startCol, endCol } }));
      return document.documentElement.getAttribute('data-cs-monaco-result') === 'ok';
    } catch { return false; }
  }

  function aceLineText(root) {
    const cursor = root.querySelector('.ace_cursor');
    const line = cursor && cursor.closest('.ace_line');
    return line ? normalize(line.textContent) : null;
  }

  function aceAdapter(root) {
    const ta = root.querySelector('textarea.ace_text-input') || root.querySelector('textarea');
    function aceLines() {
      const els = root.querySelectorAll('.ace_line');
      if (els.length) return Array.from(els).map(l => normalize(l.textContent));
      return normalize(ta ? ta.value : '').split('\n');
    }
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
      },
      readLines() { return aceLines(); },
      selectRange(startLine, endLine) {
        const els = root.querySelectorAll('.ace_line');
        if (els.length && startLine >= 1) {
          const s = els[Math.max(0, startLine - 1)], e = els[Math.min(els.length - 1, endLine - 1)];
          if (s && e) {
            try {
              const range = document.createRange();
              range.setStartBefore(s); range.setEndAfter(e);
              const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
              if (ta) ta.focus();
              return true;
            } catch { /* fallback */ }
          }
        }
        // fallback via textarea offsets
        if (!ta) return false;
        const lines = aceLines();
        let sOff = 0, eOff = ta.value.length;
        if (startLine >= 1) { let o = 0; for (let i = 0; i < startLine - 1 && i < lines.length; i++) o += lines[i].length + 1; sOff = o; }
        if (endLine >= startLine) { let o = 0; for (let i = 0; i < endLine && i < lines.length; i++) o += lines[i].length + 1; eOff = o > 0 ? o - 1 : ta.value.length; }
        try { ta.focus(); ta.setSelectionRange(Math.max(0, sOff), Math.max(sOff, eOff)); } catch {}
        return true;
      },
      replaceSelection(text) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && root.contains(sel.anchorNode)) {
          sel.deleteContents(); sel.collapseToEnd();
          try { document.execCommand('insertText', false, String(text || '')); } catch {}
          return true;
        }
        if (ta) {
          const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
          if (ta.setRangeText) ta.setRangeText(String(text || ''), s, e, 'end'); else ta.value = ta.value.slice(0, s) + String(text || '') + ta.value.slice(e);
          ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(text || ''), inputType: 'insertText' }));
          return true;
        }
        return focusedInsertUnit(ta, String(text || ''));
      }
    };
  }

  function textareaAdapter(el) {
    function taLines() { return normalize(el.value).split('\n'); }
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
      readAll() { return el.value; },
      readLines() { return taLines(); },
      selectRange(startLine, endLine) {
        const lines = taLines();
        let sOff = 0, eOff = el.value.length;
        if (startLine >= 1) { let o = 0; for (let i = 0; i < startLine - 1 && i < lines.length; i++) o += lines[i].length + 1; sOff = o; }
        if (endLine >= startLine) { let o = 0; for (let i = 0; i < endLine && i < lines.length; i++) o += lines[i].length + 1; eOff = o > 0 ? o - 1 : el.value.length; }
        try { el.focus(); el.setSelectionRange(Math.max(0, sOff), Math.max(sOff, eOff)); } catch {}
        return true;
      },
      replaceSelection(text) {
        const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
        if (el.setRangeText) el.setRangeText(String(text || ''), s, e, 'end'); else el.value = el.value.slice(0, s) + String(text || '') + el.value.slice(e);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(text || ''), inputType: 'insertText' }));
        return true;
      }
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
      readAll() { return normalize(el.innerText || el.textContent || ''); },
      readLines() { return normalize(el.innerText || el.textContent || '').split('\n'); },
      selectRange(startLine, endLine) {
        try {
          const lines = Array.from(el.children || el.childNodes || []);
          const s = Math.max(0, startLine - 1), e = Math.min(lines.length - 1, endLine - 1);
          if (!isFinite(s) || !isFinite(e) || s > e) return false;
          const range = document.createRange();
          const sEl = lines[s], eEl = lines[e];
          if (!sEl || !eEl) return false;
          range.setStartBefore(sEl); range.setEndAfter(eEl);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          el.focus(); return true;
        } catch { return false; }
      },
      replaceSelection(text) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && el.contains(sel.anchorNode)) { sel.deleteContents(); sel.collapseToEnd(); }
        el.focus();
        try { document.execCommand('insertText', false, String(text || '')); } catch {}
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(text || ''), inputType: 'insertText' }));
        return true;
      }
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

  // --------------------------------------------------- helpers for smart typing

  function tabsToSpaces(s, tabWidth) {
    tabWidth = tabWidth || 4;
    return String(s || '').replace(/\t/g, ' '.repeat(tabWidth));
  }

  function detectIndent(lines) {
    let spaces = 0, tabs = 0, minSpaces = Infinity;
    for (const l of lines) {
      if (!l.trim()) continue;
      const m = l.match(/^([ \t]+)/);
      if (!m) continue;
      const ind = m[1];
      if (ind.includes('\t')) tabs++; else spaces++;
      if (!ind.includes('\t')) minSpaces = Math.min(minSpaces, ind.length);
    }
    if (tabs > spaces) return { unit: '\t', size: 1 };
    const unit = ' ';
    let size = isFinite(minSpaces) && minSpaces > 0 ? minSpaces : 4;
    // snap to 2 or 4
    if (size >= 3 && size <= 5) size = 4;
    else if (size <= 2) size = 2;
    else size = 4;
    return { unit, size };
  }

  function reindentLine(raw, targetIndent) {
    const target = targetIndent || { unit: ' ', size: 4 };
    const m = String(raw).match(/^([ \t]*)/);
    const cur = m ? m[1] : '';
    const depth = cur ? tabsToSpaces(cur, 4).length : 0;
    // Convert cur indentation depth into the target style: round to nearest unit
    const levels = target.unit === '\t' ? Math.round(depth / 4) : Math.round(depth / target.size);
    const prefix = target.unit.repeat(Math.max(0, levels));
    return prefix + String(raw).slice(cur.length);
  }

  function isPlaceholderish(line) {
    const t = String(line || '').trim();
    if (!t) return true; // blank is trivially inside the placeholder span
    // "# Write your code here", "// TODO", "pass", "...", "/* TODO */", etc.
    if (/^(#|\/\/)\s*(write your code here|todo|your code here|complete.*here)/i.test(t)) return true;
    if (/^pass\s*$/i.test(t)) return true;
    if (/^\.\.\.\s*$/.test(t)) return true;
    if (/^\/\*.*\*\/\s*$/.test(t) && /todo|write/i.test(t)) return true;
    return false;
  }

  function stripPlaceholderLines(lines) {
    // Drop leading/trailing pure placeholders inside a span, but keep blanks.
    let s = 0, e = lines.length - 1;
    while (s <= e && isPlaceholderish(lines[s]) && lines[s].trim() !== '') s++;
    while (e >= s && isPlaceholderish(lines[e]) && lines[e].trim() !== '') e--;
    return lines.slice(s, e + 1);
  }

  function findAnchorRange(editorLines, codeLines, targetName) {
    const lc = s => String(s || '').trim();
    // Narrow by targetName when we can: poisonousPlants => def poisonousPlants
    let candidateSpan = null;
    let fnLine = -1, fnDepth = 0;
    let defRe = null;
    if (targetName && /^[_A-Za-z]\w*$/.test(targetName)) {
      // Python / JS / Java-ish def detection
      const esc = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      defRe = new RegExp('\\b' + esc + '\\s*\\(');
    }
    for (let i = 0; i < editorLines.length; i++) {
      if (defRe && defRe.test(editorLines[i])) {
        fnLine = i;
        fnDepth = tabsToSpaces(editorLines[i].match(/^[ \t]*/)[0] || '', 4).length;
        break;
      }
    }
    if (fnLine === -1) {
      for (let i = 0; i < editorLines.length; i++) {
        if (/^\s*(def |function |public |private |class |func )/.test(editorLines[i])) {
          // fallback: first def-like header
          fnLine = i;
          fnDepth = tabsToSpaces(editorLines[i].match(/^[ \t]*/)[0] || '', 4).length;
          break;
        }
      }
    }
    if (fnLine === -1) return null;

    // Body is the indented block after fnLine until dedent at or above fnDepth.
    let bodyStart = fnLine + 1;
    let bodyEnd = editorLines.length - 1;
    // Skip blank right after header
    while (bodyStart < editorLines.length && !editorLines[bodyStart].trim()) bodyStart++;
    // Walk until a non-blank line at depth <= fnDepth (or end-of-file).
    for (let i = bodyStart; i < editorLines.length; i++) {
      if (!editorLines[i].trim()) continue;
      const d = tabsToSpaces(editorLines[i].match(/^[ \t]*/)[0] || '', 4).length;
      if (d <= fnDepth) { bodyEnd = i - 1; break; }
    }
    while (bodyEnd > bodyStart && !editorLines[bodyEnd].trim()) bodyEnd--;
    const span = editorLines.slice(bodyStart, bodyEnd + 1);
    if (!span.length) return { startLine: bodyStart + 1, endLine: bodyStart + 1, isEmpty: true, bodyDepth: fnDepth + 4, fnLine, fnDepth };
    // Consider it an anchor only when the span looks placeholder-ish or
    // clearly empty/pass-like. Otherwise this is a big repo file — don't touch.
    const placeholderRatio = span.filter(l => isPlaceholderish(l)).length / span.length;
    const nonempty = span.filter(l => l.trim()).length;
    const isMostlyPlaceholder = nonempty <= 3 && placeholderRatio >= 0.5;
    const looksEmptyish = nonempty === 0 || (nonempty === 1 && isPlaceholderish(span.find(l => l.trim())));
    // Also treat a single-line stub under the function as fillable
    const isFillable = looksEmptyish || isMostlyPlaceholder || (nonempty <= 2 && span.join('\n').length < 120);
    if (!isFillable) return null;
    candidateSpan = span;
    // Derive body indentation from the first non-blank line
    let bodyDepth = fnDepth + 4;
    for (const l of span) {
      if (!l.trim() || isPlaceholderish(l) && l.trim() !== '') continue;
      bodyDepth = tabsToSpaces(l.match(/^[ \t]*/)[0] || '', 4).length;
      break;
    }
    if (!isFinite(bodyDepth) || bodyDepth <= fnDepth) bodyDepth = fnDepth + 4;

    return { startLine: bodyStart + 1, endLine: bodyEnd + 1, isEmpty: isMostlyPlaceholder || looksEmptyish, bodyDepth, fnLine, fnDepth, candidateSpan };
  }

  function reindentSnippetForRange(snippet, range) {
    if (!range || !range.bodyDepth) return String(snippet || '').replace(/\r\n?/g, '\n');
    const snippetLines = String(snippet || '').replace(/\r\n?/g, '\n').split('\n');
    const snippetDepth = (() => {
      for (const l of snippetLines) if (l.trim()) return tabsToSpaces(l.match(/^[ \t]*/)[0] || '', 4).length;
      return 0;
    })();
    const delta = range.bodyDepth - (isFinite(snippetDepth) ? snippetDepth : 0);
    if (delta === 0) return snippetLines.join('\n');
    const targetUnit = String(range.candidateSpan && range.candidateSpan.find(l => l.includes('\t')) ? '\t' : ' ');
    const targetSize = range.bodyDepth >= 8 ? 4 : range.bodyDepth - range.fnDepth;
    const normalized = snippetLines.map(l => {
      if (!l.trim()) return '';
      const cur = tabsToSpaces(l.match(/^[ \t]*/)[0] || '', 4).length;
      const next = Math.max(range.bodyDepth, cur + delta);
      const levels = targetUnit === '\t' ? Math.round(next / 4) : Math.round(next / Math.max(1, targetSize || 4));
      const prefix = targetUnit.repeat(Math.max(0, levels));
      return prefix + String(l).slice((l.match(/^[ \t]*/)[0] || '').length);
    }).join('\n');

    // For single-indent snippets, above is enough; for nested blocks the
    // relative spacing is already preserved by the delta shift.
    return normalized;
  }

  function planTargetedEdit(adapter, generatedCode, hint) {
    try {
      const editorLines = ( adapter.readLines ? adapter.readLines() : (adapter.readAll() || '').split('\n') );
      const targetName = (hint && hint.targetName) || '';
      const range = findAnchorRange(editorLines, String(generatedCode||'').split('\n'), targetName);
      if (!range) return null;

      // Extract the body snippet from generatedCode. If it contains the same
      // function header, use only its body. Otherwise reindent whole snippet to bodyDepth.
      const genLines = String(generatedCode || '').replace(/\r\n?/g, '\n').split('\n');
      let bodySnippet = String(generatedCode || '');
      if (targetName) {
        const esc = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('\\b' + esc + '\\s*\\(');
        let gFnLine = -1, gDepth = 0;
        for (let i = 0; i < genLines.length; i++) if (re.test(genLines[i])) { gFnLine = i; gDepth = tabsToSpaces(genLines[i].match(/^[ \t]*/)[0]||'',4).length; break; }
        if (gFnLine !== -1) {
          // body after gFnLine until dedent
          let s = gFnLine + 1;
          while (s < genLines.length && !genLines[s].trim()) s++;
          let e = genLines.length - 1;
          for (let i = s; i < genLines.length; i++) {
            if (!genLines[i].trim()) continue;
            const d = tabsToSpaces(genLines[i].match(/^[ \t]*/)[0]||'',4).length;
            if (d <= gDepth) { e = i - 1; break; }
          }
          while (e >= s && !genLines[e].trim()) e--;
          if (s <= e) {
            bodySnippet = genLines.slice(s, e + 1).join('\n');
          } else {
            bodySnippet = '';
          }
        }
      } else {
        // No target — if the generated code is a single indented block, dedent its first level.
        // reindentSnippetForRange handles general case.
      }

      // If bodySnippet was blank (e.g. stub only), fall back to reindenting full generated text.
      if (!String(bodySnippet||'').trim()) bodySnippet = String(generatedCode||'');
      // Drop placeholder comment lines from the body before inserting.
      bodySnippet = stripPlaceholderLines(bodySnippet.split('\n')).join('\n');

      let reindented = reindentSnippetForRange(bodySnippet, range);
      // Safety: never insert an empty range.
      if (!String(reindented||'').trim()) reindented = stripPlaceholderLines(bodySnippet.split('\n')).join('\n');
      if (!String(reindented||'').trim()) return null;

      // If range is empty/placeholder, we want to ensure surrounding file is untouched.
      return { range, snippet: reindented, mode: 'fill-range' };
    } catch { return null; }
  }

  // Generic substring-finder for large-repo patches: if the generated code
  // directly contains some 40+ char line from the editor and proposes a
  // replacement nearby, surface a patch button instead of full overwrite.
  function findSubstringMatch(editorText, generatedText) {
    const ed = String(editorText || '');
    const gen = String(generatedText || '');
    if (!ed || !gen || ed.length < 80 || gen.length < 80) return null;
    const genLines = gen.split('\n').map(l => l.trim()).filter(l => l.length >= 30);
    let longest = null;
    for (const line of genLines) {
      if (ed.includes(line) && (!longest || line.length > longest.length)) longest = line;
    }
    if (!longest || longest.length < 35) return null;
    // Roughly locate line numbers of that match in both files
    const edLines = ed.split('\n');
    let edLine = -1;
    for (let i = 0; i < edLines.length; i++) if (edLines[i].includes(longest.slice(0, 30))) { edLine = i; break; }
    if (edLine === -1) return null;
    const genLines2 = gen.split('\n');
    let gLine = -1;
    for (let i = 0; i < genLines2.length; i++) if (genLines2[i].includes(longest.slice(0, 30))) { gLine = i; break; }
    if (gLine === -1) return null;
    // We don't auto-apply generic patches — caller decides. Expose the anchors
    // so the UI can offer "Apply patch" when this is a repo fix rather than a
    // function-fill task.
    return { anchorLine: longest, edLine: edLine + 1, gLine: gLine + 1 };
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

  // Targeted edit: replace only range.startLine..range.endLine
  async function humanTypeRange(adapter, snippet, range, opts = {}) {
    const base = SPEED_BASE[opts.speed] || SPEED_BASE.normal;
    const typosOn = opts.typos !== false;
    const cancelled = opts.cancelled || (() => false);
    const onProgress = opts.onProgress || (() => {});
    const text = String(snippet || '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
    const lines = text.split('\n');
    const totalChars = text.length + Math.max(0, lines.length - 1);
    let done = 0;
    const finish = () => ({ cancelled: cancelled(), typed: done, total: totalChars });

    await adapter.focus();
    await sleep(70);

    // Ensure bridge for Monaco and select the exact range (does not wipe boilerplate).
    if (adapter.name === 'monaco' && !monacoBridgeReady) await ensureMonacoBridge();
    if (adapter.getEditorState) {
      try { adapter.getEditorState(); } catch {}
    }
    await sleep(20);
    let selected = false;
    try { selected = !!adapter.selectRange(range.startLine, range.endLine); } catch {}
    await sleep(50);
    if (!selected) {
      // Fallback: legacy full-type — still strictly better than silent failure.
      return humanType(adapter, snippet, opts);
    }
    await sleep(40);
    if (adapter.onTypeStart) adapter.onTypeStart();

    try {
      // Replacement is one atomic insert: the selection is replaced by the snippet's first char,
      // then remaining units are typed incrementally. Using replaceSelection when available
      // keeps Monaco's undo stack clean (single undo replaces the range).
      const firstLineIndent = lines[0] ? (lines[0].match(/^[ \t]*/)[0] || '') : '';
      const firstBody = lines[0] ? lines[0].slice(firstLineIndent.length) : '';

      // Clear the range with a single insert of the first indent; then stream.
      if (adapter.replaceSelection) {
        // Prime the range by inserting the first indent; browsers with execCommand
        // semantics replace the selection with the inserted text.
        adapter.replaceSelection(firstLineIndent);
        done += firstLineIndent.length;
        await sleep(rand(base * 0.3, base * 0.9));
      } else {
        adapter.replaceSelection ? adapter.replaceSelection('') : null;
        if (firstLineIndent) { await adapter.insertUnit(firstLineIndent); done += firstLineIndent.length; await sleep(rand(base * 0.3, base * 0.9)); }
      }

      for (let li = 0; li < lines.length; li++) {
        if (cancelled()) return finish();
        const raw = lines[li];
        const indent = raw.match(/^[ \t]*/)[0];
        const body = raw.slice(indent.length);

        if (li === 0) {
          // First line's indent already handled above — only type its body here.
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
          continue;
        }

        // Newlines re-use the same indentation logic as humanType
        await adapter.insertUnit('\n');
        done += 1;
        await sleep(rand(base * 0.9, base * 2.0));
        await clearAutoIndent(adapter);
        if (indent) {
          await adapter.insertUnit(indent);
          done += indent.length;
          await sleep(rand(base * 0.3, base * 0.9));
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

  window.__codesolveTyper = { findEditor, humanType, humanTypeRange, looksComplete, ensureMonacoBridge, SPEED_BASE, planTargetedEdit, findSubstringMatch, detectIndent, reindentSnippetForRange };
})();
