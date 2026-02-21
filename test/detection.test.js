const {
  JSDOM, assert,
  kindlingSource, STUBS,
  createSparkPage, runKindling,
  test, printResults,
} = require('./helpers');

console.log('\nKindling — Detection Tests\n');

// --- Spark UI Detection ---

console.log('--- Spark UI Detection ---');

test('Detects Spark UI by navigation tabs', () => {
  const dom = createSparkPage({ url: 'http://localhost:4040/' });
  const result = runKindling(dom);
  assert(result.sparkDetected === true);
});

test('Does not detect Spark UI on generic page', () => {
  const dom = new JSDOM('<html><body><h1>Hello</h1></body></html>', {
    url: 'http://example.com/',
    runScripts: 'dangerously',
  });
  dom.window.eval(STUBS);
  dom.window.eval(kindlingSource);
  let result;
  dom.window.__kindlingListener({ type: 'kindling-analyze' }, {}, r => { result = r; });
  assert(result.sparkDetected === false);
});

// --- Page Type Detection ---

console.log('--- Page Type Detection ---');

test('Detects stage-detail page type', () => {
  const dom = createSparkPage({ url: 'http://localhost:4040/stages/stage/?id=0&attempt=0' });
  const result = runKindling(dom);
  assert.strictEqual(result.pageType, 'stage-detail');
});

test('Detects sql-detail page type', () => {
  const dom = createSparkPage({ url: 'http://localhost:4040/SQL/execution/?id=5' });
  const result = runKindling(dom);
  assert.strictEqual(result.pageType, 'sql-detail');
});

test('Detects sql-list page type', () => {
  const dom = createSparkPage({ url: 'http://localhost:4040/SQL/' });
  const result = runKindling(dom);
  assert.strictEqual(result.pageType, 'sql-list');
});

test('Detects executors page type', () => {
  const dom = createSparkPage({ url: 'http://localhost:4040/executors/' });
  const result = runKindling(dom);
  assert.strictEqual(result.pageType, 'executors');
});

test('Detects job-detail page type', () => {
  const dom = createSparkPage({ url: 'http://localhost:4040/jobs/job/?id=1' });
  const result = runKindling(dom);
  assert.strictEqual(result.pageType, 'job-detail');
});

process.exit(printResults());
