// capture-hook.js — runs in the page's MAIN world (declared in the manifest as
// a content script with "world": "MAIN", "run_at": "document_start"), BEFORE
// any site code, so screen-capture APIs can be wrapped.
//
// It watches for browser-based screen sharing / recording — any page calling
// getDisplayMedia() (Meet / Zoom-web / Teams screen share, proctoring apps, web
// recorders) or getScreenDetails() (multi-screen capture) — and notifies the
// extension through a CustomEvent.
//
// When the capture is of THIS tab, it also EXCLUDES the CodeSolve chatbot's
// on-screen region from the captured video (Element Capture "exclude" mode):
// the chatbot stays visible on the user's screen but is cut out of what the
// other side sees. The exclusion region tracks the widget live as it moves.
//
// Both the instance property AND MediaDevices.prototype are wrapped, so calls
// like MediaDevices.prototype.getDisplayMedia.call(...) are caught too.
//
// Native OS-level recorders (OBS, Xbox Game Bar, desktop Zoom, phone recorders)
// never touch these APIs and cannot be detected by any browser extension.
// Sharing the ENTIRE screen also cannot exclude anything — pixels are pixels.
(function () {
  'use strict';
  if (window.__csCaptureHook) return;
  window.__csCaptureHook = true;

  // The content script keeps this invisible box exactly over the visible
  // widget (padded to cover its glow). Excluding THIS element's region is
  // what cuts the chatbot out of a tab capture — the widget host itself is
  // zero-size, so it must never be used here.
  var BOX_ID = 'codesolve-exclude-box';
  var liveStreams = 0;

  function notify(active, surface, excluded) {
    try {
      window.dispatchEvent(new CustomEvent('__csCaptureEvent', {
        detail: { active: !!active, surface: surface || null, excluded: !!excluded }
      }));
    } catch (e) { /* ignore */ }
  }

  function isTabCapture(stream) {
    try {
      var t = (stream.getVideoTracks() || [])[0];
      return !!(t && t.getSettings && t.getSettings().displaySurface === 'browser');
    } catch (e) {
      return false;
    }
  }

  // Resolve true only when EVERY video track of the stream is restricted with
  // {mode:'exclude'} to the chatbot host element. Anything unsupported or
  // failing resolves false (the extension then falls back to hiding).
  function ensureExcluded(stream) {
    return new Promise(function (resolve) {
      try {
        if (!window.RestrictionTarget || typeof RestrictionTarget.fromElement !== 'function') {
          resolve(false);
          return;
        }
        var box = document.getElementById(BOX_ID);
        if (!box) { resolve(false); return; }
        var tracks = (stream.getVideoTracks() || []).filter(function (t) {
          return typeof t.restrictTo === 'function';
        });
        if (!tracks.length) { resolve(false); return; }

        RestrictionTarget.fromElement(box).then(function (target) {
          var pending = tracks.length;
          var anyFail = false;
          tracks.forEach(function (t) {
            var result;
            try {
              result = t.restrictTo(target, { mode: 'exclude' });
            } catch (e) {
              result = Promise.reject(e);
            }
            Promise.resolve(result).then(function () {
              if (--pending === 0) resolve(!anyFail);
            }, function () {
              anyFail = true;
              if (--pending === 0) resolve(false);
            });
          });
        }).catch(function () { resolve(false); });
      } catch (e) {
        resolve(false);
      }
    });
  }

  function watchStream(stream) {
    liveStreams += 1;

    var surface = isTabCapture(stream) ? 'browser' : 'other';
    var decided = (surface === 'browser')
      ? ensureExcluded(stream)
      : Promise.resolve(false);
    decided.then(function (excluded) {
      notify(true, surface, excluded);
    });

    var done = false;
    var check = function () {
      if (done) return;
      var tracks = stream.getVideoTracks() || [];
      var anyLive = tracks.some(function (t) { return t.readyState === 'live'; });
      if (!anyLive) {
        done = true;
        clearInterval(poll);
        liveStreams = Math.max(0, liveStreams - 1);
        if (liveStreams === 0) notify(false, surface, false);
      }
    };
    // Track 'ended' plus a light poll as a safety net for missed events.
    var poll = setInterval(check, 2000);
    (stream.getVideoTracks() || []).forEach(function (t) {
      t.addEventListener('ended', check);
    });
    stream.addEventListener('inactive', check);
    check();
  }

  function wrapDisplayMedia(target) {
    if (!target || typeof target.getDisplayMedia !== 'function') return;
    var orig = target.getDisplayMedia;
    var wrapped = function () {
      var promise = orig.apply(this, arguments);
      promise.then(function (stream) {
        if (stream) watchStream(stream);
      }).catch(function () { /* user denied — nothing to do */ });
      return promise;
    };
    try { target.getDisplayMedia = wrapped; } catch (e) { /* property locked */ }
  }

  var md = navigator.mediaDevices;
  if (md) {
    wrapDisplayMedia(md);
    try { wrapDisplayMedia(MediaDevices.prototype); } catch (e) { /* ignore */ }
  }

  // Window Management API (used by some capture tools for multi-screen setups).
  if (typeof window.getScreenDetails === 'function') {
    var origGetScreenDetails = window.getScreenDetails.bind(window);
    var wrappedGetScreenDetails = function () {
      var promise = origGetScreenDetails.apply(null, arguments);
      promise.then(function () { notify(true, 'other', false); }).catch(function () { /* denied */ });
      return promise;
    };
    try {
      window.getScreenDetails = wrappedGetScreenDetails;
    } catch (e) { /* ignore */ }
  }
})();
