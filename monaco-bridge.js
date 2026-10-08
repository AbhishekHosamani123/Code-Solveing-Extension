// monaco-bridge.js — runs in the page's MAIN world (injected by the
// background via chrome.scripting.executeScript). Lets the content script
// drive Monaco through its own 'type' command — the same code path real
// keystrokes take — because many sites (e.g. LeetCode) configure Monaco to
// ignore synthetic textarea edits.
(function () {
  if (window.__csMonacoBridgeReady) return;
  window.__csMonacoBridgeReady = true;

  function pickEditor() {
    if (!(window.monaco && monaco.editor)) return null;
    var editors = monaco.editor.getEditors ? monaco.editor.getEditors() : [];
    if (!editors.length) return null;
    for (var i = 0; i < editors.length; i++) {
      try { if (editors[i].hasTextFocus()) return editors[i]; } catch (e) { /* ignore */ }
    }
    return editors[0];
  }

  window.addEventListener('__csMonacoType', function (e) {
    document.documentElement.setAttribute('data-cs-monaco-result', '');
    try {
      var detail = e.detail || {};
      if (detail.op === 'ping') {
        document.documentElement.setAttribute('data-cs-monaco-result', 'pong');
        return;
      }
      if (detail.op === 'getLines') {
        var edG = pickEditor(); var near=null;
        if (edG) try {
          var m = edG.getModel();
          near = {
            lineCount: m ? m.getLineCount() : 0,
            sel: (function(){ try{ var s=edG.getSelection(); return s?{ startLineNumber:s.startLineNumber||s.startLine||1, endLineNumber:s.endLineNumber||s.endLine||s.startLineNumber||1 }:{ startLineNumber:1, endLineNumber:1 }; }catch(e){ return {startLineNumber:1,endLineNumber:1}; }})(),
            text: m ? m.getValue() : ''
          };
        } catch (e5) {}
        document.documentElement.setAttribute('data-cs-monaco-lines', near ? JSON.stringify(near) : '');
        document.documentElement.setAttribute('data-cs-monaco-result', near ? 'ok' : 'error');
        return;
      }
      if (detail.op === 'typeStart' || detail.op === 'typeEnd') {
        var eds = (window.monaco && monaco.editor && monaco.editor.getEditors) ? monaco.editor.getEditors() : [];
        for (var j = 0; j < eds.length; j++) {
          try {
            if (detail.op === 'typeStart') {
              var EO = monaco.editor.EditorOption;
              eds[j].__csSavedOptions = {
                autoClosingBrackets: eds[j].getOption(EO.autoClosingBrackets),
                autoClosingQuotes: eds[j].getOption(EO.autoClosingQuotes),
                autoClosingComments: eds[j].getOption(EO.autoClosingComments),
                autoSurround: eds[j].getOption(EO.autoSurround)
              };
              eds[j].updateOptions({
                autoClosingBrackets: 'never',
                autoClosingQuotes: 'never',
                autoClosingComments: 'never',
                autoSurround: 'never'
              });
            } else if (eds[j].__csSavedOptions) {
              eds[j].updateOptions(eds[j].__csSavedOptions);
              eds[j].__csSavedOptions = null;
            }
          } catch (err2) { /* per-editor failure must not break others */ }
        }
        document.documentElement.setAttribute('data-cs-monaco-result', 'ok');
        return;
      }
      if (detail.op === 'selectRange') {
        var ed2 = pickEditor();
        if (!ed2) return;
        try {
          var RangeCtor = monaco.Range || (monaco.editor && monaco.editor.Range);
          var r = RangeCtor ? new RangeCtor(detail.startLine, detail.startCol || 1, detail.endLine, detail.endCol || 1)
                            : { startLineNumber: detail.startLine, startColumn: detail.startCol||1, endLineNumber: detail.endLine, endColumn: detail.endCol||1 };
          ed2.setSelection(r);
          try { ed2.revealLineInCenter(detail.startLine); } catch (e2) {}
          try { ed2.focus(); } catch (e3) {}
        } catch (e4) {}
        document.documentElement.setAttribute('data-cs-monaco-result', 'ok');
        return;
      }
      if (detail.op !== 'insert') return;
      var ed = pickEditor();
      if (!ed) return;
      ed.trigger('keyboard', 'type', { text: String(detail.text || '') });
      document.documentElement.setAttribute('data-cs-monaco-result', 'ok');
    } catch (err) {
      document.documentElement.setAttribute('data-cs-monaco-result', 'error');
    }
  }, false);
})();
