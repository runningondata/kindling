import { escapeHtml } from '../content/utils.js';

const statusEl  = document.getElementById('status');
const resultsEl = document.getElementById('results');
const analyzeBtn = document.getElementById('analyze-btn');
const clearBtn   = document.getElementById('clear-btn');
const optionsLink = document.getElementById('options-link');

let activeTabId = null;
let injected = false;

optionsLink.addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  if (!tabs?.[0]) {
    statusEl.textContent = 'No active tab found.';
    statusEl.className = 'error';
    analyzeBtn.disabled = true;
    return;
  }
  activeTabId = tabs[0].id;
});

function injectContentScript(callback) {
  if (injected) { callback(); return; }

  chrome.scripting.insertCSS({
    target: { tabId: activeTabId },
    files: ['content/kindling.css'],
  }, () => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = 'Cannot access this page.';
      statusEl.className = 'error';
      analyzeBtn.disabled = true;
      return;
    }

    chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ['content/kindling.js'],
    }, () => {
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

function analyze() {
  if (!activeTabId) return;

  statusEl.textContent = 'Analysing\u2026';
  statusEl.className = 'detecting';
  analyzeBtn.disabled = true;
  resultsEl.innerHTML = '';

  injectContentScript(() => {
    chrome.tabs.sendMessage(activeTabId, { type: 'kindling-analyze' }, response => {
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

  const total = data.issues.length;
  const pageLabel = data.pageType.replaceAll('-', ' ');

  if (total === 0) {
    statusEl.innerHTML = 'Spark UI <span class="page-type">' + escapeHtml(pageLabel) + '</span>';
    resultsEl.innerHTML = '<div class="no-issues">No performance issues detected.</div>';
    return;
  }

  statusEl.innerHTML =
    'Spark UI <span class="page-type">' + escapeHtml(pageLabel) + '</span> &mdash; ' +
    total + ' issue' + (total === 1 ? '' : 's');

  const groups = [
    { severity: 'critical', label: 'Critical', items: [] },
    { severity: 'warning',  label: 'Warnings', items: [] },
    { severity: 'info',     label: 'Info',     items: [] },
  ];

  for (const issue of data.issues) {
    for (const g of groups) {
      if (g.severity === issue.severity) {
        g.items.push(issue);
        break;
      }
    }
  }

  let html = '';
  groups.forEach(g => {
    if (!g.items.length) return;
    html += '<div class="result-group">';
    html += '<div class="result-group-title ' + g.severity + '">' +
            g.label +
            ' <span class="count">' + g.items.length + '</span>' +
            '</div>';
    g.items.forEach(item => {
      html += '<div class="result-item">' +
        '<span class="category ' + item.severity + '">' + escapeHtml(item.category) + '</span>' +
        escapeHtml(item.message) +
        '</div>';
    });
    html += '</div>';
  });

  resultsEl.innerHTML = html;
}

function clearOverlays() {
  if (!activeTabId) return;
  chrome.tabs.sendMessage(activeTabId, { type: 'kindling-clear' }, () => {
    statusEl.textContent = 'Diagnostics cleared.';
    statusEl.className = '';
    resultsEl.innerHTML = '';
    clearBtn.disabled = true;
  });
}

analyzeBtn.addEventListener('click', analyze);
clearBtn.addEventListener('click', clearOverlays);
