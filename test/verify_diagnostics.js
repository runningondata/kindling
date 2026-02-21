// ============================================================================
// Kindling Diagnostic Verification — Playwright MCP Injection Script
// ============================================================================
//
// Verifies that all Kindling diagnostic checks fire correctly against real
// Spark UI pages produced by test/spark_anti_patterns.py.
//
// WORKFLOW (using Playwright MCP from Claude Code):
//
//   1. browser_navigate  → Databricks workspace login page
//   2. User enters credentials in the Playwright browser window
//   3. browser_navigate  → Spark UI via cluster driver proxy URL
//      e.g. https://<workspace>/driver-proxy/o/<org>/<cluster>/40001/...
//   4. For each page to verify:
//      a. browser_navigate to the specific Spark UI page
//      b. browser_evaluate with the injection script (see below)
//      c. Compare returned results against EXPECTED_RESULTS
//   5. For stragglers: run notebook cell 12, then immediately check the
//      active stage detail page before the 120 s sleep completes
//
// BUILDING THE INJECTION SCRIPT:
//
//   Read this file and content/kindling.js, then combine:
//
//     const stubs    = <STUBS section below>
//     const kindling = <content of content/kindling.js>
//     const trigger  = <TRIGGER section below>
//     browser_evaluate(`${stubs}\n${kindling}\n${trigger}`)
//
//   The result is a JSON object:
//     { sparkDetected, pageType, issues[], criticalCount, warningCount, infoCount }
//
// ============================================================================

// ---------------------------------------------------------------------------
// STUBS — Chrome extension API stubs for standalone injection
// ---------------------------------------------------------------------------
// Paste this BEFORE the kindling.js content in browser_evaluate.

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
// TRIGGER — call after kindling.js has been eval'd
// ---------------------------------------------------------------------------
// Paste this AFTER the kindling.js content in browser_evaluate.
// Returns the diagnostic results object.

const TRIGGER = `
  (function () {
    var result;
    if (typeof window.__kindlingListener === 'function') {
      window.__kindlingListener(
        { type: 'kindling-analyze' },
        {},
        function (r) { result = r; }
      );
    }
    return result || { error: 'Listener not registered — check STUBS were injected before kindling.js' };
  })();
`;

// ---------------------------------------------------------------------------
// EXPECTED RESULTS — what each Spark UI page should report
// ---------------------------------------------------------------------------
// After browser_evaluate returns `result`, assert against these expectations.
// Each entry maps a notebook cell to the page type and expected diagnostics.

const EXPECTED_RESULTS = {

  // --- Stage detail pages (navigate to the completed stage for each cell) ---

  'cell2_skew': {
    pageType: 'stage-detail',
    minCritical: 1,
    requiredCategories: ['Skew'],
    messageContains: ['median'],
  },

  'cell3_spill': {
    pageType: 'stage-detail',
    minWarning: 1,
    requiredCategories: ['Spill'],
    messageContains: ['spill'],
  },

  'cell4_gc': {
    pageType: 'stage-detail',
    minWarning: 1,
    requiredCategories: ['GC Pressure'],
    messageContains: ['GC'],
  },

  'cell5_small_tasks': {
    pageType: 'stage-detail',
    minInfo: 1,
    requiredCategories: ['Small Tasks'],
    messageContains: ['tasks'],
  },

  // --- SQL detail pages (navigate to the SQL query for each cell) ---

  'cell6_cartesian': {
    pageType: 'sql-detail',
    minCritical: 1,
    requiredCategories: ['Join Strategy'],
    messageContains: ['CartesianProduct'],
  },

  'cell7_bnlj': {
    pageType: 'sql-detail',
    minWarning: 1,
    requiredCategories: ['Join Strategy'],
    messageContains: ['BroadcastNestedLoopJoin'],
  },

  'cell8_smj': {
    pageType: 'sql-detail',
    minInfo: 1,
    requiredCategories: ['Join Strategy', 'Shuffle'],
    messageContains: ['SortMergeJoin', 'Exchange'],
  },

  'cell9_pushdown': {
    pageType: 'sql-detail',
    minWarning: 1,
    requiredCategories: ['Predicate Pushdown'],
    messageContains: ['PushedFilters'],
  },

  // --- Jobs page (shows all completed stages with durations) ---

  'cell10_dominant': {
    pageType: 'job-detail',
    minWarning: 1,
    requiredCategories: ['Dominant Stage'],
    messageContains: ['%'],
  },

  // --- Executors page (cumulative shuffle read across all jobs) ---

  'cell11_executor_imbalance': {
    pageType: 'executors',
    minWarning: 1,
    requiredCategories: ['Executor Skew'],
    messageContains: ['imbalance'],
  },

  // --- Active stage detail (check WHILE cell 12 is running) ---

  'cell12_stragglers': {
    pageType: 'stage-detail',
    minWarning: 1,
    requiredCategories: ['Stragglers'],
    messageContains: ['straggler'],
  },

  // --- NEW v2 FEATURES ---

  // Long filter condition (SQL detail with a complex filter)
  'long_filter': {
    pageType: 'sql-detail',
    minInfo: 1,
    requiredCategories: ['Long Filter'],
    messageContains: ['filter condition', 'predicates'],
  },

  // Memory over-utilisation (executors page with high memory usage)
  'memory_high': {
    pageType: 'executors',
    minWarning: 1,
    requiredCategories: ['Memory'],
    messageContains: ['memory utilisation'],
  },

  // Small files (SQL detail with many small file reads)
  'small_files': {
    pageType: 'sql-detail',
    minInfo: 1,
    requiredCategories: ['Small Files'],
    messageContains: ['files', 'averaging'],
  },

  // PII detection (SQL detail with PII-related column names)
  'pii_columns': {
    pageType: 'sql-detail',
    minInfo: 1,
    requiredCategories: ['PII'],
    messageContains: ['PII'],
  },

  // Estimation error (SQL detail with large estimation multipliers)
  'estimation_error': {
    pageType: 'sql-detail',
    minWarning: 1,
    requiredCategories: ['Estimation Error'],
    messageContains: ['estimation error'],
  },

  // Failed query (SQL list or detail with failed query)
  'failed_query': {
    pageType: 'sql-list',
    minCritical: 1,
    requiredCategories: ['Failed Query'],
    messageContains: ['failed'],
  },
};

// ---------------------------------------------------------------------------
// ASSERTION HELPER
// ---------------------------------------------------------------------------
// Pass the browser_evaluate result and an entry from EXPECTED_RESULTS.
// Returns { pass: boolean, failures: string[] }.

function assertDiagnostics(result, expected) {
  const failures = [];

  if (!result || !result.sparkDetected) {
    return { pass: false, failures: ['Spark UI not detected on page'] };
  }

  if (expected.pageType && result.pageType !== expected.pageType) {
    failures.push(`Expected pageType "${expected.pageType}", got "${result.pageType}"`);
  }

  if (expected.minCritical && result.criticalCount < expected.minCritical) {
    failures.push(`Expected ≥${expected.minCritical} critical, got ${result.criticalCount}`);
  }
  if (expected.minWarning && result.warningCount < expected.minWarning) {
    failures.push(`Expected ≥${expected.minWarning} warning, got ${result.warningCount}`);
  }
  if (expected.minInfo && result.infoCount < expected.minInfo) {
    failures.push(`Expected ≥${expected.minInfo} info, got ${result.infoCount}`);
  }

  const categories = (result.issues || []).map(i => i.category);
  for (const req of (expected.requiredCategories || [])) {
    if (!categories.includes(req)) {
      failures.push(`Missing required category "${req}" in issues`);
    }
  }

  const allMessages = (result.issues || []).map(i => i.message.toLowerCase()).join(' ');
  for (const substr of (expected.messageContains || [])) {
    if (!allMessages.includes(substr.toLowerCase())) {
      failures.push(`No issue message contains "${substr}"`);
    }
  }

  return { pass: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// NAVIGATION GUIDE
// ---------------------------------------------------------------------------
// How to reach the correct Spark UI page for each verification step.
//
// Base URL pattern (Databricks):
//   https://<workspace>/driver-proxy/o/<org-id>/<cluster-id>/40001/
//
// Stage detail:
//   <base>/stages/stage/?id=<stageId>&attempt=0
//   → Find stage IDs on the Stages tab; pick the stage from the relevant job
//
// SQL detail:
//   <base>/SQL/execution/?id=<executionId>
//   → Find execution IDs on the SQL/DataFrame tab; pick the query matching
//     the cell (cartesian = crossJoin, BNLJ = non-equi join, etc.)
//
// Job detail (for dominant stage):
//   <base>/jobs/job/?id=<jobId>
//   → Pick the job from cell 10 on the Jobs tab
//
// Executors page:
//   <base>/executors/
//   → Check after running all of cell 11's iterations
//
// Active stage detail (for stragglers):
//   <base>/stages/stage/?id=<stageId>&attempt=0
//   → Start cell 12, quickly navigate to the Stages tab, click the
//     active (running) stage

// ---------------------------------------------------------------------------
// MODULE EXPORTS (for Node.js usage / testing harness)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { STUBS, TRIGGER, EXPECTED_RESULTS, assertDiagnostics };
}
