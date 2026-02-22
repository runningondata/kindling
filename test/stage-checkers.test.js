const {
  createSparkPage, runKindling,
  test, printResults,
  assertContainsCategory, assertNotContainsCategory,
  assertMinSeverity,
} = require('./helpers');

console.log('\nKindling — Stage Checker Tests\n');

// --- Skew Detection ---

console.log('--- Skew Detection ---');

test('Detects severe skew in summary metrics', () => {
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

test('Does not flag skew when within threshold', () => {
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

// --- Spill Detection ---

console.log('--- Spill Detection ---');

test('Detects memory spill', () => {
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

// --- GC Pressure ---

console.log('--- GC Pressure ---');

test('Detects high GC pressure', () => {
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

process.exit(printResults());
