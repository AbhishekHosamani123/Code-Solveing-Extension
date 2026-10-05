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
