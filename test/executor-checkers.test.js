const {
  createSparkPage, runKindling,
  test, printResults,
  assertContainsCategory, assertNotContainsCategory,
  assertMinSeverity,
} = require('./helpers');

console.log('\nKindling — Executor & Stage Checker Tests\n');

// --- Memory Over-Utilisation ---

console.log('--- Memory Over-Utilisation ---');

test('Detects executor at critical memory utilisation', () => {
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
});

test('Detects executor at warning memory utilisation', () => {
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

test('Does not flag low memory utilisation', () => {
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

test('Skips driver row for memory check', () => {
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

// --- Dominant Stage ---

console.log('--- Dominant Stage ---');

test('Detects dominant stage', () => {
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

// --- Executor Balance ---

console.log('--- Executor Balance ---');

test('Detects executor imbalance', () => {
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

process.exit(printResults());
