// ============================================================================
// Kindling — Automated Unit Tests
// ============================================================================
// Tests all diagnostic checkers using synthetic DOM fixtures simulating
// Spark UI pages. No real Spark cluster required.
//
// Usage:
//   node test/kindling.test.js
// ============================================================================

const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const kindlingSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'extension', 'content', 'kindling.js'),
  'utf8'
);

// ---------------------------------------------------------------------------
// Chrome API stubs for JSDOM environment
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: create a JSDOM with Spark UI structure, inject kindling, run analysis
// ---------------------------------------------------------------------------

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
  // Inject stubs
  window.eval(STUBS);
  // Inject kindling
  window.eval(kindlingSource);

  // Trigger analysis
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

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

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

// ===========================================================================
// TESTS
// ===========================================================================

console.log('\nKindling v2 — Automated Tests\n');

// ---------------------------------------------------------------------------
// Spark UI Detection
// ---------------------------------------------------------------------------

console.log('--- Spark UI Detection ---');

test('Detects Spark UI by navigation tabs', function () {
  const dom = createSparkPage({ url: 'http://localhost:4040/' });
  const result = runKindling(dom);
  assert(result.sparkDetected === true);
});

test('Does not detect Spark UI on generic page', function () {
  const dom = new JSDOM('<html><body><h1>Hello</h1></body></html>', {
    url: 'http://example.com/',
    runScripts: 'dangerously',
  });
  dom.window.eval(STUBS);
  dom.window.eval(kindlingSource);
  let result;
  dom.window.__kindlingListener({ type: 'kindling-analyze' }, {}, function (r) { result = r; });
  assert(result.sparkDetected === false);
});

// ---------------------------------------------------------------------------
// Page Type Detection
// ---------------------------------------------------------------------------

console.log('--- Page Type Detection ---');

test('Detects stage-detail page type', function () {
  const dom = createSparkPage({ url: 'http://localhost:4040/stages/stage/?id=0&attempt=0' });
  const result = runKindling(dom);
  assert.strictEqual(result.pageType, 'stage-detail');
});

test('Detects sql-detail page type', function () {
  const dom = createSparkPage({ url: 'http://localhost:4040/SQL/execution/?id=5' });
  const result = runKindling(dom);
  assert.strictEqual(result.pageType, 'sql-detail');
});

test('Detects sql-list page type', function () {
  const dom = createSparkPage({ url: 'http://localhost:4040/SQL/' });
  const result = runKindling(dom);
  assert.strictEqual(result.pageType, 'sql-list');
});

test('Detects executors page type', function () {
  const dom = createSparkPage({ url: 'http://localhost:4040/executors/' });
  const result = runKindling(dom);
  assert.strictEqual(result.pageType, 'executors');
});

test('Detects job-detail page type', function () {
  const dom = createSparkPage({ url: 'http://localhost:4040/jobs/job/?id=1' });
  const result = runKindling(dom);
  assert.strictEqual(result.pageType, 'job-detail');
});

// ---------------------------------------------------------------------------
// Checker: Skew Detection
// ---------------------------------------------------------------------------

console.log('--- Skew Detection ---');

test('Detects severe skew in summary metrics', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/stages/stage/?id=0&attempt=0',
    bodyHtml: `
      <table id="summary-metrics-table">
        <thead><tr><th>Metric</th><th>Min</th><th>25th percentile</th><th>Median</th><th>75th percentile</th><th>Max</th></tr></thead>
        <tbody>
          <tr><td>Duration</td><td>5 ms</td><td>10 ms</td><td>15 ms</td><td>20 ms</td><td>500 ms</td></tr>
        </tbody>
      </table>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Skew');
  assertMinSeverity(result, 'critical', 1);
});

test('Does not flag skew when within threshold', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/stages/stage/?id=0&attempt=0',
    bodyHtml: `
      <table id="summary-metrics-table">
        <thead><tr><th>Metric</th><th>Min</th><th>25th percentile</th><th>Median</th><th>75th percentile</th><th>Max</th></tr></thead>
        <tbody>
          <tr><td>Duration</td><td>10 ms</td><td>12 ms</td><td>14 ms</td><td>16 ms</td><td>18 ms</td></tr>
        </tbody>
      </table>
    `,
  });
  const result = runKindling(dom);
  assertNotContainsCategory(result, 'Skew');
});

// ---------------------------------------------------------------------------
// Checker: Spill Detection
// ---------------------------------------------------------------------------

console.log('--- Spill Detection ---');

test('Detects memory spill', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/stages/stage/?id=0&attempt=0',
    bodyHtml: `
      <table id="summary-metrics-table">
        <thead><tr><th>Metric</th><th>Min</th><th>25th percentile</th><th>Median</th><th>75th percentile</th><th>Max</th></tr></thead>
        <tbody>
          <tr><td>Duration</td><td>5 s</td><td>10 s</td><td>15 s</td><td>20 s</td><td>25 s</td></tr>
          <tr><td>Spill (Memory)</td><td>0 B</td><td>0 B</td><td>100 MiB</td><td>500 MiB</td><td>2.0 GiB</td></tr>
        </tbody>
      </table>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Spill');
  assertMinSeverity(result, 'critical', 1);
});

// ---------------------------------------------------------------------------
// Checker: GC Pressure
// ---------------------------------------------------------------------------

console.log('--- GC Pressure ---');

test('Detects high GC pressure', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/stages/stage/?id=0&attempt=0',
    bodyHtml: `
      <table id="summary-metrics-table">
        <thead><tr><th>Metric</th><th>Min</th><th>25th percentile</th><th>Median</th><th>75th percentile</th><th>Max</th></tr></thead>
        <tbody>
          <tr><td>Duration</td><td>1 s</td><td>2 s</td><td>3 s</td><td>4 s</td><td>5 s</td></tr>
          <tr><td>GC Time</td><td>0.2 s</td><td>0.5 s</td><td>1 s</td><td>1.5 s</td><td>2 s</td></tr>
        </tbody>
      </table>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'GC Pressure');
  assertMinSeverity(result, 'critical', 1);
});

// ---------------------------------------------------------------------------
// Checker: Join Strategy (SQL detail)
// ---------------------------------------------------------------------------

console.log('--- Join Strategy ---');

test('Detects CartesianProduct in physical plan', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=1',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- CartesianProduct
   :- Range (0, 500, step=1)
   +- Range (0, 500, step=1)
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Join Strategy');
  assertMinSeverity(result, 'critical', 1);
  assertMessageContains(result, 'CartesianProduct');
});

test('Detects SortMergeJoin in physical plan', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=2',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- SortMergeJoin [key#1], [key#2]
   :- Sort [key#1 ASC]
   :  +- Exchange hashpartitioning(key#1)
   +- Sort [key#2 ASC]
      +- Exchange hashpartitioning(key#2)
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Join Strategy');
  assertContainsCategory(result, 'Shuffle');
});

// ---------------------------------------------------------------------------
// Checker: Predicate Pushdown
// ---------------------------------------------------------------------------

console.log('--- Predicate Pushdown ---');

test('Detects missing predicate pushdown', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=3',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Filter (value > 0.5)
   +- FileScan parquet [id, value] PushedFilters: [] ReadSchema: struct<id:bigint,value:double>
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Predicate Pushdown');
  assertMinSeverity(result, 'warning', 1);
});

// ---------------------------------------------------------------------------
// Feature 1: SQL Syntax Highlighting
// ---------------------------------------------------------------------------

console.log('--- SQL Syntax Highlighting ---');

test('SQL syntax highlighting setup creates hoverable spans', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=10',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Filter ((column1#23 = 'value') AND (column2#24 > 100) OR (column3#25 IS NOT NULL AND column4#26 LIKE '%test%'))
+- Project [column1#23, column2#24, column3#25]
+- FileScan parquet [id, column1, column2] PushedFilters: [IsNotNull(column1)] ReadSchema: struct<id:bigint>
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  // Check that sql-expr spans were created for Filter and Project lines
  const sqlExprs = dom.window.document.querySelectorAll('.kindling-sql-expr');
  assert(sqlExprs.length >= 1,
    'Expected at least 1 .kindling-sql-expr span, got ' + sqlExprs.length);
});

// ---------------------------------------------------------------------------
// Feature 2: Long Filter Condition Detection
// ---------------------------------------------------------------------------

console.log('--- Long Filter Condition ---');

test('Detects long filter condition by character count', function () {
  // Create a filter expression > 500 chars
  const longCondition = Array(60).fill('(column' + 'X' + '#1 = value)').join(' AND ');
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=11',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Filter ${longCondition}
+- FileScan parquet [id] PushedFilters: [IsNotNull(id)] ReadSchema: struct<id:bigint>
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Long Filter');
  assertMessageContains(result, 'filter condition');
});

test('Does not flag short filter conditions', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=12',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Filter (id > 10)
+- FileScan parquet [id] PushedFilters: [GreaterThan(id,10)] ReadSchema: struct<id:bigint>
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertNotContainsCategory(result, 'Long Filter');
});

test('Detects long filter by predicate count', function () {
  // Create a filter with >10 AND/OR predicates
  const predicates = Array(15).fill('(col#1 = val)').join(' AND ');
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=13',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Filter ${predicates}
+- FileScan parquet [id] PushedFilters: [] ReadSchema: struct<id:bigint>
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Long Filter');
  assertMessageContains(result, 'predicates');
});

// ---------------------------------------------------------------------------
// Feature 3: Failed Query Error Handling
// ---------------------------------------------------------------------------

console.log('--- Failed Query Detection ---');

test('Detects failed query on SQL list page', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/',
    bodyHtml: `
      <table>
        <thead><tr><th>ID</th><th>Description</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>SELECT * FROM t</td><td>COMPLETED</td></tr>
          <tr><td>2</td><td>SELECT * FROM bad</td><td>FAILED</td></tr>
        </tbody>
      </table>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Failed Query');
  assertMinSeverity(result, 'critical', 1);
});

test('Detects failed query on SQL detail page with error element', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=2',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>== Physical Plan == not available due to error</pre>
      </div>
      <h4>Query Status: FAILED</h4>
      <div class="alert-danger">
        org.apache.spark.sql.AnalysisException: Table or view not found: bad_table; please check your query syntax
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Failed Query');
  assertMinSeverity(result, 'critical', 1);
  assertMessageContains(result, 'failed');
});

// ---------------------------------------------------------------------------
// Feature 4: Export Diagnostic Report
// ---------------------------------------------------------------------------

console.log('--- Export Buttons ---');

test('Panel includes export buttons', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=1',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- CartesianProduct
   :- Range (0, 500, step=1)
   +- Range (0, 500, step=1)
        </pre>
      </div>
    `,
  });
  runKindling(dom);
  const panel = dom.window.document.getElementById('kindling-panel');
  assert(panel, 'Panel should exist');
  const exportBtns = panel.querySelectorAll('.kindling-export-btn');
  assert.strictEqual(exportBtns.length, 2, 'Should have 2 export buttons');
  assert(exportBtns[0].getAttribute('data-export') === 'json');
  assert(exportBtns[1].getAttribute('data-export') === 'md');
});

test('Export buttons present even with no issues', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=1',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Range (0, 500, step=1)
        </pre>
      </div>
    `,
  });
  runKindling(dom);
  const panel = dom.window.document.getElementById('kindling-panel');
  assert(panel, 'Panel should exist');
  const exportBtns = panel.querySelectorAll('.kindling-export-btn');
  assert.strictEqual(exportBtns.length, 2, 'Should have 2 export buttons even with no issues');
});

// ---------------------------------------------------------------------------
// Feature 6: Memory Over-Utilisation Detection
// ---------------------------------------------------------------------------

console.log('--- Memory Over-Utilisation ---');

test('Detects executor at critical memory utilisation', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/executors/',
    bodyHtml: `
      <table id="active-executors-table">
        <thead><tr><th>Executor ID</th><th>Address</th><th>Storage Memory</th><th>Shuffle Read</th></tr></thead>
        <tbody>
          <tr><td>0</td><td>host1:8080</td><td>2.6 GiB / 2.7 GiB</td><td>100 MiB</td></tr>
          <tr><td>1</td><td>host2:8080</td><td>1.0 GiB / 2.7 GiB</td><td>100 MiB</td></tr>
        </tbody>
      </table>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Memory');
  assertMinSeverity(result, 'critical', 1);
  assertMessageContains(result, 'memory utilisation');
});

test('Detects executor at warning memory utilisation', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/executors/',
    bodyHtml: `
      <table id="active-executors-table">
        <thead><tr><th>Executor ID</th><th>Address</th><th>Storage Memory</th><th>Shuffle Read</th></tr></thead>
        <tbody>
          <tr><td>0</td><td>host1:8080</td><td>2.5 GiB / 2.7 GiB</td><td>100 MiB</td></tr>
          <tr><td>1</td><td>host2:8080</td><td>0.5 GiB / 2.7 GiB</td><td>100 MiB</td></tr>
        </tbody>
      </table>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Memory');
  assertMinSeverity(result, 'warning', 1);
});

test('Does not flag low memory utilisation', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/executors/',
    bodyHtml: `
      <table id="active-executors-table">
        <thead><tr><th>Executor ID</th><th>Address</th><th>Storage Memory</th><th>Shuffle Read</th></tr></thead>
        <tbody>
          <tr><td>0</td><td>host1:8080</td><td>0.5 GiB / 2.7 GiB</td><td>100 MiB</td></tr>
          <tr><td>1</td><td>host2:8080</td><td>0.3 GiB / 2.7 GiB</td><td>100 MiB</td></tr>
        </tbody>
      </table>
    `,
  });
  const result = runKindling(dom);
  assertNotContainsCategory(result, 'Memory');
});

test('Skips driver row for memory check', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/executors/',
    bodyHtml: `
      <table id="active-executors-table">
        <thead><tr><th>Executor ID</th><th>Address</th><th>Storage Memory</th><th>Shuffle Read</th></tr></thead>
        <tbody>
          <tr><td>driver</td><td>host0:8080</td><td>2.6 GiB / 2.7 GiB</td><td>0 B</td></tr>
          <tr><td>0</td><td>host1:8080</td><td>0.5 GiB / 2.7 GiB</td><td>100 MiB</td></tr>
        </tbody>
      </table>
    `,
  });
  const result = runKindling(dom);
  assertNotContainsCategory(result, 'Memory');
});

// ---------------------------------------------------------------------------
// Feature 7: Small Files Reading Detection
// ---------------------------------------------------------------------------

console.log('--- Small Files Detection ---');

test('Detects small files in scan metrics', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=20',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- FileScan parquet [id, name] PushedFilters: [] ReadSchema: struct<id:bigint,name:string>
        </pre>
        <div>
          number of files read: 5000
          size of files read: 500 MiB
        </div>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Small Files');
  assertMessageContains(result, 'files');
  assertMessageContains(result, 'averaging');
});

test('Does not flag large files', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=21',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- FileScan parquet [id] PushedFilters: [] ReadSchema: struct<id:bigint>
        </pre>
        <div>
          number of files read: 10
          size of files read: 5 GiB
        </div>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertNotContainsCategory(result, 'Small Files');
});

// ---------------------------------------------------------------------------
// Feature 8: PII Pattern Detection
// ---------------------------------------------------------------------------

console.log('--- PII Detection ---');

test('Detects PII column names in plan text', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=30',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Project [customer_id#1, email#2, phone#3, ssn#4, first_name#5, last_name#6]
   +- FileScan parquet [customer_id, email, phone, ssn, first_name, last_name]
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'PII');
  assertMessageContains(result, 'PII');
  // Should detect multiple PII columns
  const piiIssues = result.issues.filter(i => i.category === 'PII');
  assert(piiIssues.length >= 4,
    'Expected at least 4 PII findings, got ' + piiIssues.length);
});

test('Detects PII literal patterns in filter expressions', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=31',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Filter (email#2 = 'john@example.com')
   +- FileScan parquet [id, email] PushedFilters: [EqualTo(email,'john@example.com')]
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'PII');
  // Should find email column AND email literal
  const piiIssues = result.issues.filter(i => i.category === 'PII');
  assert(piiIssues.length >= 1,
    'Expected at least 1 PII finding, got ' + piiIssues.length);
});

test('Does not flag generic column names as PII', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=32',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Project [id#1, value#2, count#3, timestamp#4]
   +- FileScan parquet [id, value, count, timestamp]
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertNotContainsCategory(result, 'PII');
});

test('PII badge uses distinct class', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=33',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Project [email#1, phone#2]
   +- FileScan parquet [email, phone]
        </pre>
      </div>
    `,
  });
  runKindling(dom);
  const panel = dom.window.document.getElementById('kindling-panel');
  assert(panel, 'Panel should exist');
  const piiBadges = panel.querySelectorAll('.kindling-badge.pii');
  assert(piiBadges.length >= 1,
    'Expected at least 1 PII badge, got ' + piiBadges.length);
});

// ---------------------------------------------------------------------------
// Feature 9: Estimation Error Detection
// ---------------------------------------------------------------------------

console.log('--- Estimation Error Detection ---');

test('Detects large estimation errors', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=40',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- SortMergeJoin [key#1], [key#2]
   :- Sort [key#1 ASC]
   :  +- Exchange hashpartitioning(key#1)
   +- Sort [key#2 ASC]
      +- Exchange hashpartitioning(key#2)
        </pre>
        <div>
          estimated rows output: 1000
          rows output: 25000000000000 (1000X)
        </div>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Estimation Error');
  assertMinSeverity(result, 'critical', 1);
  assertMessageContains(result, 'estimation error');
});

test('Detects warning-level estimation errors', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=41',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Aggregate [key], [count(1)]
        </pre>
        <div>
          rows output: 500000 (200X)
        </div>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Estimation Error');
  assertMinSeverity(result, 'warning', 1);
});

test('Does not flag small estimation errors', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=42',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Aggregate [key], [count(1)]
        </pre>
        <div>
          rows output: 5000 (5X)
        </div>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertNotContainsCategory(result, 'Estimation Error');
});

// ---------------------------------------------------------------------------
// Checker: Dominant Stage
// ---------------------------------------------------------------------------

console.log('--- Dominant Stage ---');

test('Detects dominant stage', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/jobs/job/?id=1',
    bodyHtml: `
      <table id="completedStage-table">
        <thead><tr><th>Stage ID</th><th>Description</th><th>Duration</th></tr></thead>
        <tbody>
          <tr><td>0</td><td>scan</td><td>1 s</td></tr>
          <tr><td>1</td><td>aggregate</td><td>59 s</td></tr>
        </tbody>
      </table>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Dominant Stage');
  assertMinSeverity(result, 'warning', 1);
});

// ---------------------------------------------------------------------------
// Checker: Executor Balance
// ---------------------------------------------------------------------------

console.log('--- Executor Balance ---');

test('Detects executor imbalance', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/executors/',
    bodyHtml: `
      <table id="active-executors-table">
        <thead><tr><th>Executor ID</th><th>Address</th><th>Storage Memory</th><th>Shuffle Read</th></tr></thead>
        <tbody>
          <tr><td>driver</td><td>host0:8080</td><td>0 B / 2.7 GiB</td><td>0 B</td></tr>
          <tr><td>0</td><td>host1:8080</td><td>0.5 GiB / 2.7 GiB</td><td>10 GiB</td></tr>
          <tr><td>1</td><td>host2:8080</td><td>0.5 GiB / 2.7 GiB</td><td>500 MiB</td></tr>
        </tbody>
      </table>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Executor Skew');
  assertMinSeverity(result, 'warning', 1);
});

// ---------------------------------------------------------------------------
// Panel and Clear
// ---------------------------------------------------------------------------

console.log('--- Panel & Clear ---');

test('Panel is created with correct severity counts', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=1',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- CartesianProduct
   :- Range (0, 500, step=1)
   +- Range (0, 500, step=1)
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  const panel = dom.window.document.getElementById('kindling-panel');
  assert(panel, 'Panel should exist');
  assert(result.criticalCount >= 1);
});

test('Clear removes panel and highlights', function () {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=1',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- CartesianProduct
   :- Range (0, 500, step=1)
   +- Range (0, 500, step=1)
        </pre>
      </div>
    `,
  });
  runKindling(dom);
  assert(dom.window.document.getElementById('kindling-panel'), 'Panel should exist before clear');

  // Trigger clear
  dom.window.__kindlingListener(
    { type: 'kindling-clear' },
    {},
    function () {}
  );
  assert(!dom.window.document.getElementById('kindling-panel'), 'Panel should be removed after clear');
});

// ---------------------------------------------------------------------------
// Firefox build script
// ---------------------------------------------------------------------------

console.log('--- Firefox Build ---');

test('Firefox build produces valid manifest', function () {
  const firefoxManifestPath = path.resolve(__dirname, '..', 'dist', 'firefox', 'manifest.json');
  if (!fs.existsSync(firefoxManifestPath)) {
    // Run build script first
    require('../scripts/build-firefox.js');
  }
  const manifest = JSON.parse(fs.readFileSync(firefoxManifestPath, 'utf8'));
  assert(manifest.background.scripts, 'Firefox manifest should have background.scripts');
  assert(!manifest.background.service_worker, 'Firefox manifest should not have service_worker');
  assert(manifest.browser_specific_settings, 'Firefox manifest should have browser_specific_settings');
  assert.strictEqual(manifest.browser_specific_settings.gecko.id, 'kindling@kindling-spark-diagnostics');
});

test('Chrome manifest retains service_worker', function () {
  const chromeManifestPath = path.resolve(__dirname, '..', 'extension', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(chromeManifestPath, 'utf8'));
  assert(manifest.background.service_worker, 'Chrome manifest should have service_worker');
  assert(!manifest.background.scripts, 'Chrome manifest should not have background.scripts');
});

// ---------------------------------------------------------------------------
// Config: new thresholds exist in defaults
// ---------------------------------------------------------------------------

console.log('--- Configuration ---');

test('New config thresholds have sensible defaults', function () {
  const configSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'extension', 'options', 'options.js'),
    'utf8'
  );
  const requiredKeys = [
    'smallFileAvgSizeWarningMb',
    'smallFileAvgSizeCriticalMb',
    'smallFileMinCount',
    'memoryUtilWarning',
    'memoryUtilCritical',
    'longFilterCharThreshold',
    'longFilterPredicateThreshold',
    'estimationErrorWarning',
    'estimationErrorCritical',
  ];
  requiredKeys.forEach(function (key) {
    assert(configSource.includes(key),
      'options.js should contain config key: ' + key);
  });
});

test('Options HTML has inputs for all new thresholds', function () {
  const optionsHtml = fs.readFileSync(
    path.resolve(__dirname, '..', 'extension', 'options', 'options.html'),
    'utf8'
  );
  const requiredIds = [
    'smallFileAvgSizeWarningMb',
    'smallFileAvgSizeCriticalMb',
    'smallFileMinCount',
    'memoryUtilWarning',
    'memoryUtilCritical',
    'longFilterCharThreshold',
    'longFilterPredicateThreshold',
    'estimationErrorWarning',
    'estimationErrorCritical',
  ];
  requiredIds.forEach(function (id) {
    assert(optionsHtml.includes('id="' + id + '"'),
      'options.html should contain input with id: ' + id);
  });
});

// ---------------------------------------------------------------------------
// CSS: new styles present
// ---------------------------------------------------------------------------

console.log('--- CSS ---');

test('CSS contains SQL syntax highlighting styles', function () {
  const css = fs.readFileSync(
    path.resolve(__dirname, '..', 'extension', 'content', 'kindling.css'),
    'utf8'
  );
  assert(css.includes('.kindling-sql-keyword'), 'CSS should have .kindling-sql-keyword');
  assert(css.includes('.kindling-sql-function'), 'CSS should have .kindling-sql-function');
  assert(css.includes('.kindling-sql-string'), 'CSS should have .kindling-sql-string');
  assert(css.includes('.kindling-sql-number'), 'CSS should have .kindling-sql-number');
  assert(css.includes('.kindling-sql-operator'), 'CSS should have .kindling-sql-operator');
  assert(css.includes('.kindling-sql-tooltip'), 'CSS should have .kindling-sql-tooltip');
});

test('CSS contains PII badge styles', function () {
  const css = fs.readFileSync(
    path.resolve(__dirname, '..', 'extension', 'content', 'kindling.css'),
    'utf8'
  );
  assert(css.includes('.kindling-badge.pii'), 'CSS should have .kindling-badge.pii');
});

test('CSS contains export button styles', function () {
  const css = fs.readFileSync(
    path.resolve(__dirname, '..', 'extension', 'content', 'kindling.css'),
    'utf8'
  );
  assert(css.includes('.kindling-export-btn'), 'CSS should have .kindling-export-btn');
  assert(css.includes('.kindling-export-bar'), 'CSS should have .kindling-export-bar');
});

// ===========================================================================
// Results
// ===========================================================================

console.log('\n' + '='.repeat(60));
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach(function (f) {
    console.log('  - ' + f.name + ': ' + f.error);
  });
}
console.log('='.repeat(60) + '\n');

process.exit(failed > 0 ? 1 : 0);
