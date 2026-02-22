const {
  assert,
  createSparkPage, runKindling,
  test, printResults,
  assertContainsCategory, assertNotContainsCategory,
  assertMessageContains, assertMinSeverity,
} = require('./helpers');

console.log('\nKindling — SQL Checker Tests\n');

// --- Join Strategy ---

console.log('--- Join Strategy ---');

test('Detects CartesianProduct in physical plan', () => {
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

test('Detects SortMergeJoin in physical plan', () => {
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

// --- Predicate Pushdown ---

console.log('--- Predicate Pushdown ---');

test('Detects missing predicate pushdown', () => {
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

test('Detects missing pushdown with V2 scan (PySpark 4.x)', () => {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=4',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Filter (value > 0.5)
   +- Scan parquet spark_catalog.default.test_table [id, value]
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Predicate Pushdown');
  assertMinSeverity(result, 'warning', 1);
});

// --- SQL Syntax Highlighting ---

console.log('--- SQL Syntax Highlighting ---');

test('SQL syntax highlighting setup creates hoverable spans', () => {
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
  runKindling(dom);
  const sqlExprs = dom.window.document.querySelectorAll('.kindling-sql-expr');
  assert(sqlExprs.length >= 1,
    'Expected at least 1 .kindling-sql-expr span, got ' + sqlExprs.length);
});

// --- Long Filter Condition ---

console.log('--- Long Filter Condition ---');

test('Detects long filter condition by character count', () => {
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

test('Does not flag short filter conditions', () => {
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

test('Detects long filter by predicate count', () => {
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

// --- Failed Query Detection ---

console.log('--- Failed Query Detection ---');

test('Detects failed query on SQL list page', () => {
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
  assertMessageContains(result, 'ID 2');
  assertMessageContains(result, 'SELECT * FROM bad');
});

test('Detects failed query on SQL detail page with error element', () => {
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

// --- Small Files Detection ---

console.log('--- Small Files Detection ---');

test('Detects small files in scan metrics', () => {
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

test('Does not flag large files', () => {
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

// --- PII Detection ---

console.log('--- PII Detection ---');

test('Detects PII column names in plan text', () => {
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
  const piiIssues = result.issues.filter(i => i.category === 'PII');
  assert(piiIssues.length >= 4,
    'Expected at least 4 PII findings, got ' + piiIssues.length);
});

test('Detects PII literal patterns in filter expressions', () => {
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
  const piiIssues = result.issues.filter(i => i.category === 'PII');
  assert(piiIssues.length >= 1,
    'Expected at least 1 PII finding, got ' + piiIssues.length);
});

test('Does not flag generic column names as PII', () => {
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

test('PII badge uses distinct class', () => {
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

// --- Estimation Error Detection ---

console.log('--- Estimation Error Detection ---');

test('Detects large estimation errors', () => {
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

test('Detects warning-level estimation errors', () => {
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

test('Does not flag small estimation errors', () => {
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

process.exit(printResults());
