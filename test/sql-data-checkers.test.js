const {
  assert,
  createSparkPage, runKindling,
  test, printResults,
  assertContainsCategory, assertNotContainsCategory,
  assertMessageContains, assertMinSeverity,
} = require('./helpers');

console.log('\nKindling — SQL Data Checker Tests\n');

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

// --- Python UDF Detection ---

console.log('--- Python UDF Detection ---');

test('Detects BatchEvalPython (regular Python UDF)', () => {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=50',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- BatchEvalPython [my_udf(col1#1)], [pythonUDF0#5]
   +- FileScan parquet [col1] PushedFilters: [] ReadSchema: struct<col1:string>
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Python UDF');
  assertMinSeverity(result, 'warning', 1);
  assertMessageContains(result, 'BatchEvalPython');
});

test('Detects ArrowEvalPython (Pandas UDF)', () => {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=51',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- ArrowEvalPython [pandas_udf(col1#1)], [pythonUDF0#5]
   +- FileScan parquet [col1] PushedFilters: [] ReadSchema: struct<col1:string>
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Python UDF');
  assertMinSeverity(result, 'warning', 1);
  assertMessageContains(result, 'ArrowEvalPython');
});

test('Detects FlatMapGroupsInPandas', () => {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=52',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- FlatMapGroupsInPandas [group_key#1], [output#5]
   +- Sort [group_key#1 ASC]
      +- Exchange hashpartitioning(group_key#1)
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Python UDF');
  assertMessageContains(result, 'grouped map');
});

test('Does not flag plans without Python UDFs', () => {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=53',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- BroadcastHashJoin [key#1], [key#2]
   :- FileScan parquet [key, value] PushedFilters: [IsNotNull(key)] ReadSchema: struct<key:int,value:string>
   +- FileScan parquet [key, name] PushedFilters: [IsNotNull(key)] ReadSchema: struct<key:int,name:string>
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertNotContainsCategory(result, 'Python UDF');
});

// --- Column Usage Detection ---

console.log('--- Column Usage Detection ---');

test('Detects wide schema scan', () => {
  const cols = Array.from({ length: 25 }, (_, i) => 'col' + i + ':string').join(',');
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=60',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- Project [col0#1, col1#2]
   +- FileScan parquet [col0, col1, col2, col3] PushedFilters: [] ReadSchema: struct&lt;${cols}&gt;
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertContainsCategory(result, 'Column Usage');
  assertMessageContains(result, '25 columns');
});

test('Does not flag narrow schema scan', () => {
  const dom = createSparkPage({
    url: 'http://localhost:4040/SQL/execution/?id=61',
    bodyHtml: `
      <div id="physical-plan-details">
        <pre>
+- FileScan parquet [id, name, value] PushedFilters: [IsNotNull(id)] ReadSchema: struct&lt;id:bigint,name:string,value:double&gt;
        </pre>
      </div>
    `,
  });
  const result = runKindling(dom);
  assertNotContainsCategory(result, 'Column Usage');
});

process.exit(printResults());
