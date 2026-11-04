// js/app/loader.js — WP-CORE
// Injects the manifest, then the map and content the query string selects, then boots (ARCHITECTURE 4.6). Everything
// is a classic script, because the game must run from file://. Missing files are collected and shown, never hidden.
(function (TLV) {
  'use strict';

  var INDEX_FILES = ['data/maps/index.js', 'content/index.js', 'data/assets/index.js'];

  /** Added here, not in index.html, whose contents ARCHITECTURE 4.1 fixes. Without it a phone lays the page out 980 wide and shrinks it. */
  function setViewport() {
    var meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1';
    document.head.appendChild(meta);
  }

  /** A ?map= value may be a local script path, like createTLV's map option, but never a URL or a climb out of the game. */
  var LOCAL_SCRIPT = /^[\w-]+(\/[\w.-]+)*\.js$/;

  /** The text browsers give an error from a file:// script, whatever really happened. */
  var MASKED_ERROR = /^Script error\.?$/;

  var missing = [];
  var scriptErrors = [];    // { src, message }
  var unclaimed = [];       // window errors since the last script finished
  var shown = [];
  var mapSrc = null;
  var mapNote = null;

  /**
   * Reads a key the object itself holds. A map ID comes from the URL, so ?map=constructor must not find Object's.
   * @returns {*} The value, or undefined.
   */
  function own(obj, key) {
    return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
  }

  /** Writes plain text into #ui-root, which needs nothing but the page itself. */
  function plainError(text) {
    var root = document.getElementById('ui-root') || document.body;
    var box = document.getElementById('load-error');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'load-error';
      box.style.cssText = 'position:fixed;left:0;right:0;top:0;max-height:100%;box-sizing:border-box;overflow:auto;margin:0;' +
        'padding:16px;z-index:1000;background:#1b1b1f;color:#fff;font:14px/1.5 monospace;white-space:pre-wrap';
      root.appendChild(box);
    }
    box.textContent = text;
  }

  /**
   * Adds to the error overlay: TLV.ui.showError when it works, else plain text in #ui-root. Each call carries everything
   * shown so far, so a later message can never hide the first one, which is usually the cause.
   * @param {string} text Message.
   */
  function showError(text) {
    if (shown.indexOf(text) >= 0) return;
    shown.push(text);
    var all = shown.join('\n\n');
    if (TLV && TLV.ui && typeof TLV.ui.showError === 'function') {
      try {
        TLV.ui.showError(all);
        return;
      } catch (e) {
        console.error(e);
      }
    }
    plainError(all);
  }

  /** @param {string[]} list Script paths, executed in order. @param {function():void} done Called when all have fired. */
  function inject(list, done) {
    var pending = list.length;
    if (!pending) {
      done();
      return;
    }
    function settled() {
      pending--;
      if (pending === 0) done();
    }
    list.forEach(function (src) {
      var script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = function () {
        claimErrors(src);
        settled();
      };
      script.onerror = function () {
        missing.push(src);
        settled();
      };
      document.head.appendChild(script);
    });
  }

  /** Holds an error from a script that is running now. It fires onload all the same, so nothing else would notice. */
  function onScriptError(e) {
    unclaimed.push(MASKED_ERROR.test(e.message) ? 'it threw, and the browser hides why on file://. The console has the reason.' : e.message);
  }

  /**
   * Names the script behind the errors held so far. With async off, scripts run one at a time and each fires load right after
   * it runs, so an error always falls between the load before and its own. The event itself cannot say: on file:// the browser
   * blanks its filename and replaces its message.
   * @param {string} src The script that just finished.
   */
  function claimErrors(src) {
    unclaimed.forEach(function (message) {
      scriptErrors.push({ src: src, message: message });
    });
    unclaimed = [];
  }

  /** @returns {boolean} True for files boot cannot go on without. */
  function isFatal(src) {
    return TLV.manifest.sim.indexOf(src) >= 0 || src === mapSrc || src === 'data/maps/index.js';
  }

  /**
   * Checks the page's own stylesheet. It was parsed before this script ran, so its events are gone, and a failed link
   * on file:// looks like a loaded one. A second link fires them, and is removed at once.
   * @param {function():void} done Called when the check has settled.
   */
  function probeStylesheet(done) {
    var link = document.querySelector('link[rel="stylesheet"]');
    if (!link) {
      done();
      return;
    }
    var probe = document.createElement('link');
    probe.rel = 'stylesheet';
    probe.href = link.getAttribute('href');
    probe.onload = function () {
      probe.remove();
      done();
    };
    probe.onerror = function () {
      missing.push(link.getAttribute('href'));
      probe.remove();
      done();
    };
    document.head.appendChild(probe);
  }

  /**
   * Builds the overlay text for this load. The file list comes last, because it can run past the bottom of the screen.
   * @returns {?string} Text, or null if the load was clean.
   */
  function report(fatal) {
    var lines = [];
    if (fatal) lines.push('Sidurim cannot start.');
    else if (missing.length || scriptErrors.length) lines.push('Sidurim is missing some files and will run without them.');
    if (mapNote) lines.push('', mapNote);
    var probe = TLV.const && TLV.const._charsetProbe;
    if (probe && probe.length !== 7) {
      lines.push('', 'Text is not being read as UTF-8: Hebrew, the shekel sign and the OSM attribution will be wrong.');
    }
    if (scriptErrors.length) {
      lines.push('', 'Scripts that failed while loading:');
      scriptErrors.forEach(function (err) { lines.push('  ' + err.src + ': ' + err.message); });
    }
    if (missing.length) {
      lines.push('', 'Missing files (' + missing.length + '):');
      missing.forEach(function (src) { lines.push('  ' + src); });
    }
    return lines.length ? lines.join('\n') : null;
  }

  /** Step 5: boots once everything has fired. */
  function finish() {
    window.removeEventListener('error', onScriptError);
    claimErrors('an unknown script');
    if (typeof window.THREE === 'undefined') missing.push('vendor/three.min.js');
    // A sim file that threw is as gone as a missing one, and booting on it only buries the cause under a stranger error.
    var fatal = !TLV.params || mapSrc === null || missing.some(isFatal) ||
      scriptErrors.some(function (err) { return isFatal(err.src); });
    var text = report(fatal);
    if (text) showError(text);
    if (fatal) return;
    if (typeof TLV.app.boot !== 'function') {
      showError('js/app/main.js did not define TLV.app.boot.');
      return;
    }
    try {
      TLV.app.boot();
    } catch (e) {
      console.error(e);
      showError('Boot failed: ' + (e && e.message));
    }
  }

  /** Steps 2 and 3: the map ID comes from the query string, so these must follow the indexes. */
  function afterIndexes() {
    if (!TLV.config) {
      probeStylesheet(finish);
      return;
    }
    TLV.params = TLV.config.parse(window.location.search);
    var id = TLV.params.map;
    var entry = own(TLV.mapIndex && TLV.mapIndex.maps, id);
    if (entry) mapSrc = entry.src;
    else if (id && LOCAL_SCRIPT.test(id) && id.indexOf('..') < 0) mapSrc = id;

    if (mapSrc === null) {
      mapNote = id ? 'Unknown map "' + id + '": it is not in data/maps/index.js.' : 'No map is available.';
      mapNote += ' Maps are built by: node tools/import.mjs tlv_center';
    }
    // Content still loads with no map, so one overlay lists everything that is missing.
    var files = TLV.contentFiles || {};
    var content = own(files, id) || files.default || [];
    inject((mapSrc === null ? [] : [mapSrc]).concat(content), function () {
      probeStylesheet(finish);
    });
  }

  if (!TLV || !TLV.manifest) {
    plainError('Sidurim cannot start.\n\nMissing files:\n  js/core/namespace.js or js/manifest.js');
    return;
  }

  document.title = 'Sidurim / סידורים';
  setViewport();
  TLV.ns('app')._showError = showError;
  window.addEventListener('error', onScriptError);
  inject(TLV.manifest.sim.concat(TLV.manifest.browser, INDEX_FILES), afterIndexes);
})(window.TLV);
