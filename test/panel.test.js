const {
  assert,
  createSparkPage, runKindling,
  test, printResults,
} = require('./helpers');

console.log('\nKindling — Panel & Export Tests\n');

// --- Export Buttons ---

console.log('--- Export Buttons ---');

test('Panel includes export buttons', () => {
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

test('Export buttons present even with no issues', () => {
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

// --- Panel & Clear ---

console.log('--- Panel & Clear ---');

test('Panel is created with correct severity counts', () => {
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

test('Clear removes panel and highlights', () => {
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

  dom.window.__kindlingListener(
    { type: 'kindling-clear' },
    {},
    () => {}
  );
  assert(!dom.window.document.getElementById('kindling-panel'), 'Panel should be removed after clear');
});

process.exit(printResults());
