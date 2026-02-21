// ============================================================================
// Kindling — Popup Script
// ============================================================================
// Manages injection, analysis trigger, and result display.
// ============================================================================

(function () {
  'use strict';

  var statusEl  = document.getElementById('status');
  var resultsEl = document.getElementById('results');
  var analyzeBtn = document.getElementById('analyze-btn');
  var clearBtn   = document.getElementById('clear-btn');
  var optionsLink = document.getElementById('options-link');

  var activeTabId = null;
  var injected = false;

  // Open the options page
  optionsLink.addEventListener('click', function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Get the active tab
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || !tabs[0]) {
      statusEl.textContent = 'No active tab found.';
      statusEl.className = 'error';
      analyzeBtn.disabled = true;
      return;
    }
    activeTabId = tabs[0].id;
  });

  // Inject content script + CSS into the tab
  function injectContentScript(callback) {
    if (injected) { callback(); return; }

    chrome.scripting.insertCSS({
      target: { tabId: activeTabId },
      files: ['content/kindling.css'],
    }, function () {
      if (chrome.runtime.lastError) {
        statusEl.textContent = 'Cannot access this page.';
        statusEl.className = 'error';
        analyzeBtn.disabled = true;
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        files: ['content/kindling.js'],
      }, function () {
        if (chrome.runtime.lastError) {
          statusEl.textContent = 'Cannot inject script into this page.';
          statusEl.className = 'error';
          analyzeBtn.disabled = true;
          return;
        }
        injected = true;
        callback();
      });
    });
  }

  // Run analysis
  function analyze() {
    if (!activeTabId) return;

    statusEl.textContent = 'Analysing\u2026';
    statusEl.className = 'detecting';
    analyzeBtn.disabled = true;
    resultsEl.innerHTML = '';

    injectContentScript(function () {
      chrome.tabs.sendMessage(activeTabId, { type: 'kindling-analyze' }, function (response) {
        analyzeBtn.disabled = false;

        if (chrome.runtime.lastError || !response) {
          statusEl.textContent = 'Error communicating with the page. Try refreshing.';
          statusEl.className = 'error';
          return;
        }

        displayResults(response);
      });
    });
  }

  // Display results in the popup
  function displayResults(data) {
    if (!data.sparkDetected) {
      statusEl.textContent = 'No Spark UI detected on this page.';
      statusEl.className = 'no-spark';
      clearBtn.disabled = true;
      resultsEl.innerHTML =
        '<div class="no-spark-msg">' +
        'Kindling analyses Apache Spark Web UI pages including standalone ' +
        'Spark UI, History Server, and Databricks driver proxy.' +
        '</div>';
      return;
    }

    clearBtn.disabled = false;

    var total = data.issues.length;
    var pageLabel = data.pageType.replace(/-/g, ' ');

    if (total === 0) {
      statusEl.innerHTML = 'Spark UI <span class="page-type">' + escapeHtml(pageLabel) + '</span>';
      resultsEl.innerHTML = '<div class="no-issues">No performance issues detected.</div>';
      return;
    }

    statusEl.innerHTML =
      'Spark UI <span class="page-type">' + escapeHtml(pageLabel) + '</span> &mdash; ' +
      total + ' issue' + (total === 1 ? '' : 's');

    var groups = [
      { severity: 'critical', label: 'Critical', items: [] },
      { severity: 'warning',  label: 'Warnings', items: [] },
      { severity: 'info',     label: 'Info',     items: [] },
    ];

    data.issues.forEach(function (issue) {
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].severity === issue.severity) {
          groups[i].items.push(issue);
          break;
        }
      }
    });

    var html = '';
    groups.forEach(function (g) {
      if (!g.items.length) return;
      html += '<div class="result-group">';
      html += '<div class="result-group-title ' + g.severity + '">' +
              g.label +
              ' <span class="count">' + g.items.length + '</span>' +
              '</div>';
      g.items.forEach(function (item) {
        html += '<div class="result-item">' +
          '<span class="category ' + item.severity + '">' + escapeHtml(item.category) + '</span>' +
          escapeHtml(item.message) +
          '</div>';
      });
      html += '</div>';
    });

    resultsEl.innerHTML = html;
  }

  // Clear diagnostics
  function clearOverlays() {
    if (!activeTabId) return;
    chrome.tabs.sendMessage(activeTabId, { type: 'kindling-clear' }, function () {
      statusEl.textContent = 'Diagnostics cleared.';
      statusEl.className = '';
      resultsEl.innerHTML = '';
      clearBtn.disabled = true;
    });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // Wire up buttons
  analyzeBtn.addEventListener('click', analyze);
  clearBtn.addEventListener('click', clearOverlays);
})();
