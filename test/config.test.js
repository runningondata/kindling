const {
  fs, path, assert,
  test, printResults,
} = require('./helpers');

console.log('\nKindling — Config, Build & CSS Tests\n');

// --- Firefox Build ---

console.log('--- Firefox Build ---');

test('Firefox build produces valid manifest', () => {
  const firefoxManifestPath = path.resolve(__dirname, '..', 'dist', 'firefox', 'manifest.json');
  if (!fs.existsSync(firefoxManifestPath)) {
    require('../scripts/build-firefox.js');
  }
  const manifest = JSON.parse(fs.readFileSync(firefoxManifestPath, 'utf8'));
  assert(manifest.background.scripts, 'Firefox manifest should have background.scripts');
  assert(!manifest.background.service_worker, 'Firefox manifest should not have service_worker');
  assert(manifest.browser_specific_settings, 'Firefox manifest should have browser_specific_settings');
  assert.strictEqual(manifest.browser_specific_settings.gecko.id, 'kindling@kindling-spark-diagnostics');
});

test('Chrome manifest retains service_worker', () => {
  const chromeManifestPath = path.resolve(__dirname, '..', 'extension', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(chromeManifestPath, 'utf8'));
  assert(manifest.background.service_worker, 'Chrome manifest should have service_worker');
  assert(!manifest.background.scripts, 'Chrome manifest should not have background.scripts');
});

// --- Configuration ---

console.log('--- Configuration ---');

test('New config thresholds have sensible defaults', () => {
  const configSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'content', 'config.js'),
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
  requiredKeys.forEach(key => {
    assert(configSource.includes(key),
      'options.js should contain config key: ' + key);
  });
});

test('Options HTML has inputs for all new thresholds', () => {
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
  requiredIds.forEach(id => {
    assert(optionsHtml.includes('id="' + id + '"'),
      'options.html should contain input with id: ' + id);
  });
});

// --- CSS ---

console.log('--- CSS ---');

test('CSS contains SQL syntax highlighting styles', () => {
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

test('CSS contains PII badge styles', () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, '..', 'extension', 'content', 'kindling.css'),
    'utf8'
  );
  assert(css.includes('.kindling-badge.pii'), 'CSS should have .kindling-badge.pii');
});

test('CSS contains export button styles', () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, '..', 'extension', 'content', 'kindling.css'),
    'utf8'
  );
  assert(css.includes('.kindling-export-btn'), 'CSS should have .kindling-export-btn');
  assert(css.includes('.kindling-export-bar'), 'CSS should have .kindling-export-bar');
});

process.exit(printResults());
