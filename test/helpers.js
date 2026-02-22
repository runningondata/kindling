const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const kindlingSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'extension', 'content', 'kindling.js'),
  'utf8'
);

const STUBS = `
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      onMessage: {
        addListener: function (fn) { window.__kindlingListener = fn; }
      },
      sendMessage: function () {}
    };
  }
  if (!window.chrome.storage) {
    window.chrome.storage = {
      sync: {
        get: function (_key, cb) { cb({}); }
      }
    };
  }
  delete window.__kindlingSetup;
`;

function createSparkPage(options) {
  const {
    url = 'http://localhost:4040/stages/stage/?id=0&attempt=0',
    navTabs = ['Jobs', 'Stages', 'Storage', 'Environment', 'Executors', 'SQL'],
    bodyHtml = '',
  } = options;

  const navItems = navTabs.map(t => `<li class="nav-item"><a>${t}</a></li>`).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head><title>Spark UI</title></head>
    <body>
      <nav class="navbar">
        <span class="navbar-brand">Spark</span>
        <ul class="nav">${navItems}</ul>
      </nav>
      ${bodyHtml}
    </body>
    </html>
  `;

  const dom = new JSDOM(html, {
    url: url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  return dom;
}

function runKindling(dom) {
  const window = dom.window;
  window.eval(STUBS);
  window.eval(kindlingSource);

  let result;
  if (typeof window.__kindlingListener === 'function') {
    window.__kindlingListener(
      { type: 'kindling-analyze' },
      {},
      function (r) { result = r; }
    );
  }
  return result;
}

// Test runner
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS: ' + name);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log('  FAIL: ' + name);
    console.log('        ' + e.message);
  }
}

function printResults() {
  console.log('\n' + '='.repeat(60));
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f.name + ': ' + f.error));
  }
  console.log('='.repeat(60) + '\n');
  return failed > 0 ? 1 : 0;
}

function assertContainsCategory(result, category) {
  const cats = (result.issues || []).map(i => i.category);
  assert(cats.includes(category),
    'Expected category "' + category + '" in issues, got: [' + cats.join(', ') + ']');
}

function assertNotContainsCategory(result, category) {
  const cats = (result.issues || []).map(i => i.category);
  assert(!cats.includes(category),
    'Did not expect category "' + category + '" in issues');
}

function assertMessageContains(result, substring) {
  const msgs = (result.issues || []).map(i => i.message.toLowerCase()).join(' ');
  assert(msgs.includes(substring.toLowerCase()),
    'Expected message containing "' + substring + '" in: ' + msgs.substring(0, 200));
}

function assertMinSeverity(result, severity, minCount) {
  const count = (result.issues || []).filter(i => i.severity === severity).length;
  assert(count >= minCount,
    'Expected at least ' + minCount + ' ' + severity + ' issues, got ' + count);
}

module.exports = {
  JSDOM, fs, path, assert,
  kindlingSource, STUBS,
  createSparkPage, runKindling,
  test, printResults,
  assertContainsCategory, assertNotContainsCategory,
  assertMessageContains, assertMinSeverity,
};
