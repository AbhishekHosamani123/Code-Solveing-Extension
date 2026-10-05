// capture-relay.js — content script (isolated world, ALL frames, document_start).
//
// capture-hook.js (MAIN world) fires __csCaptureEvent on the window of the
// frame where a screen capture started. The main chatbot content script only
// runs in the top frame, so a capture started inside an IFRAME (e.g. embedded
// meeting/proctoring components) would go unnoticed. This relay runs in every
// frame and forwards the event to the background, which hides the chatbot in
// ALL tabs.
(function () {
  'use strict';
  if (window.__csCaptureRelay) return;
  window.__csCaptureRelay = true;

  var lastActive = false;
  window.addEventListener('__csCaptureEvent', function (e) {
    var active = !!(e.detail && e.detail.active);
    if (active === lastActive) return; // dedupe repeated notifications
    lastActive = active;
    try {
      chrome.runtime.sendMessage({ type: 'CAPTURE_REPORT', active: active }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* extension context gone */ }
  });
})();
