// ============================================================================
// Kindling — Options Page
// ============================================================================

(function () {
  'use strict';

  var DEFAULTS = {
    skewThreshold: 1.5,
    severeSkewThreshold: 3.0,
    gcPressureThreshold: 0.10,
    stragglerMultiple: 5.0,
    smallTaskDurationMs: 50,
    smallTaskCountMin: 1000,
    executorSkewRatio: 3.0,
    stageTimeDominance: 0.8,
  };

  var FIELDS = Object.keys(DEFAULTS);

  function loadConfig() {
    chrome.storage.sync.get('config', function (result) {
      var cfg = Object.assign({}, DEFAULTS, result.config || {});
      FIELDS.forEach(function (key) {
        var el = document.getElementById(key);
        if (el) el.value = cfg[key];
      });
    });
  }

  function saveConfig() {
    var cfg = {};
    FIELDS.forEach(function (key) {
      var el = document.getElementById(key);
      if (el) cfg[key] = parseFloat(el.value);
    });

    chrome.storage.sync.set({ config: cfg }, function () {
      var msg = document.getElementById('save-msg');
      msg.classList.add('visible');
      setTimeout(function () { msg.classList.remove('visible'); }, 1500);
    });
  }

  function resetDefaults() {
    FIELDS.forEach(function (key) {
      var el = document.getElementById(key);
      if (el) el.value = DEFAULTS[key];
    });
    chrome.storage.sync.set({ config: DEFAULTS }, function () {
      var msg = document.getElementById('save-msg');
      msg.textContent = 'Reset to defaults';
      msg.classList.add('visible');
      setTimeout(function () {
        msg.classList.remove('visible');
        msg.textContent = 'Saved';
      }, 1500);
    });
  }

  document.getElementById('save-btn').addEventListener('click', saveConfig);
  document.getElementById('reset-btn').addEventListener('click', resetDefaults);

  loadConfig();
})();
