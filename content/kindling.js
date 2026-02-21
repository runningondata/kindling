// ============================================================================
// Kindling — Spark UI Diagnostic Content Script
// ============================================================================
// Injected on demand by the popup. Scans the rendered Spark Web UI HTML,
// applies performance heuristics, and overlays results inline.
// ============================================================================

(function () {
  'use strict';

  // Guard against double injection — listeners persist in the isolated world.
  if (window.__kindlingSetup) return;
  window.__kindlingSetup = true;

  // --------------------------------------------------------------------------
  // Default configuration — overridden by chrome.storage.sync values
  // --------------------------------------------------------------------------

  const DEFAULT_CONFIG = {
    skewThreshold: 1.5,
    severeSkewThreshold: 3.0,
    gcPressureThreshold: 0.10,
    stragglerMultiple: 5.0,
    smallTaskDurationMs: 50,
    smallTaskCountMin: 1000,
    executorSkewRatio: 3.0,
    stageTimeDominance: 0.8,
  };

  let config = { ...DEFAULT_CONFIG };

  // --------------------------------------------------------------------------
  // Severity levels
  // --------------------------------------------------------------------------

  const SEVERITY = {
    CRITICAL: 'critical',
    WARNING: 'warning',
    INFO: 'info',
  };

  // --------------------------------------------------------------------------
  // Issue tracker
  // --------------------------------------------------------------------------

  let issues = [];

  function addIssue(severity, category, message, element) {
    issues.push({ severity, category, message, element });
  }

  // Saved original content for elements we modify (e.g. SQL plan <pre>).
  let savedOriginals = {};

  // --------------------------------------------------------------------------
  // Parsing utilities
  // --------------------------------------------------------------------------

  function parseDuration(str) {
    if (!str || typeof str !== 'string') return NaN;
    str = str.trim();
    if (str === '' || str === '-') return NaN;

    var match = str.match(/^([\d.]+)\s*(ms|s|min|h|d)$/i);
    if (match) {
      var val = parseFloat(match[1]);
      switch (match[2].toLowerCase()) {
        case 'ms':  return val;
        case 's':   return val * 1000;
        case 'min': return val * 60000;
        case 'h':   return val * 3600000;
        case 'd':   return val * 86400000;
      }
    }

    var bare = parseFloat(str);
    if (!isNaN(bare)) return bare;
    return NaN;
  }

  function parseBytes(str) {
    if (!str || typeof str !== 'string') return NaN;
    str = str.trim();
    if (str === '' || str === '-') return NaN;

    // Handle compound strings like "1.5 GiB / 1000"
    var slashIdx = str.indexOf('/');
    if (slashIdx !== -1) str = str.substring(0, slashIdx).trim();

    var match = str.match(
      /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|PiB|KB|MB|GB|TB|PB|EiB|EB)$/i
    );
    if (match) {
      var val = parseFloat(match[1]);
      switch (match[2]) {
        case 'B':   return val;
        case 'KiB': case 'KB': return val * 1024;
        case 'MiB': case 'MB': return val * 1048576;
        case 'GiB': case 'GB': return val * 1073741824;
        case 'TiB': case 'TB': return val * 1099511627776;
        case 'PiB': case 'PB': return val * 1125899906842624;
        case 'EiB': case 'EB': return val * 1152921504606846976;
      }
    }

    var bare = parseFloat(str);
    if (!isNaN(bare)) return bare;
    return NaN;
  }

  function parseCellValue(str) {
    if (!str || typeof str !== 'string') return NaN;
    str = str.trim();
    if (str === '' || str === '-') return NaN;

    var val = parseDuration(str);
    if (!isNaN(val)) return val;
    val = parseBytes(str);
    if (!isNaN(val)) return val;
    return parseFloat(str.replace(/,/g, ''));
  }

  function cellText(td) {
    if (!td) return '';
    return (td.textContent || td.innerText || '').trim();
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // --------------------------------------------------------------------------
  // Highlight helpers
  // --------------------------------------------------------------------------

  function highlightElement(el, severity, tip) {
    if (!el) return;
    el.classList.add('kindling-highlight-' + severity);
    if (tip) {
      el.classList.add('kindling-tooltip');
      el.setAttribute('data-kindling-tip', tip);
    }
  }

  function highlightRow(row, severity, tip) {
    highlightElement(row, severity, tip);
  }

  function highlightCell(cell, severity, tip) {
    highlightElement(cell, severity, tip);
  }

  function clearHighlights() {
    document.querySelectorAll(
      '.kindling-highlight-critical,' +
      '.kindling-highlight-warning,' +
      '.kindling-highlight-info'
    ).forEach(function (el) {
      el.classList.remove(
        'kindling-highlight-critical',
        'kindling-highlight-warning',
        'kindling-highlight-info',
        'kindling-tooltip'
      );
      el.removeAttribute('data-kindling-tip');
    });

    document.querySelectorAll('.kindling-stage-badge').forEach(function (el) {
      el.remove();
    });

    // Restore any original DOM content we replaced
    Object.keys(savedOriginals).forEach(function (key) {
      var entry = savedOriginals[key];
      if (entry.element && entry.element.parentNode) {
        entry.element.textContent = entry.text;
      }
    });
    savedOriginals = {};
  }

  // --------------------------------------------------------------------------
  // Spark UI detection (DOM-based, not URL-based)
  // --------------------------------------------------------------------------

  function detectSparkUI() {
    // 1. Check for Spark navigation tabs
    var navLinks = document.querySelectorAll(
      '.nav-item a, .nav a, .navbar-nav a, ul.nav li a'
    );
    var sparkTabs = ['Jobs', 'Stages', 'Storage', 'Environment', 'Executors', 'SQL'];
    var tabMatches = 0;
    navLinks.forEach(function (link) {
      var text = link.textContent.trim();
      for (var i = 0; i < sparkTabs.length; i++) {
        if (text === sparkTabs[i]) { tabMatches++; break; }
      }
    });
    if (tabMatches >= 3) return true;

    // 2. Check for Spark version header
    var brand = document.querySelector('.navbar-brand, .navbar-header');
    if (brand && /spark/i.test(brand.textContent)) return true;

    // 3. Check for characteristic Spark table IDs
    var sparkTableIds = [
      'activeJob-table', 'completedJob-table', 'failedJob-table',
      'activeStage-table', 'completedStage-table', 'failedStage-table',
      'active-tasks-table', 'summary-metrics-table',
      'active-executors-table', 'summary-execs-table',
      'running-table', 'completed-table', 'failed-table',
    ];
    for (var i = 0; i < sparkTableIds.length; i++) {
      if (document.getElementById(sparkTableIds[i])) return true;
    }

    // 4. Check for the Spark UI footer
    var footer = document.querySelector('.navbar-fixed-bottom, footer');
    if (footer && /spark/i.test(footer.textContent)) return true;

    // TODO: Detect Spark UI embedded in iframes within Databricks pages
    return false;
  }

  // --------------------------------------------------------------------------
  // Page type detection
  // --------------------------------------------------------------------------

  function getPageType() {
    var path = window.location.pathname;
    var hash = window.location.hash;

    if (/\/stages\/stage\b/.test(path) || /\/stages\/stage\b/.test(hash)) {
      return 'stage-detail';
    }
    if (/\/stages\/?$/.test(path) || /\/stages\/?$/.test(hash)) {
      return 'stages-list';
    }
    if (/\/SQL\/execution\b/i.test(path) || /\/SQL\/execution\b/i.test(hash) ||
        /\/sqlserver\/execution\b/i.test(path)) {
      return 'sql-detail';
    }
    if (/\/SQL\/?$/i.test(path) || /\/sqlserver\/?$/i.test(path)) {
      return 'sql-list';
    }
    if (/\/jobs\/job\b/.test(path)) {
      return 'job-detail';
    }
    if (/\/jobs\/?$/.test(path)) {
      return 'jobs-list';
    }
    if (/\/executors\/?$/.test(path)) {
      return 'executors';
    }
    if (/\/$/.test(path) || path.endsWith(':4040') || path.endsWith(':18080')) {
      return 'jobs-list';
    }
    return 'unknown';
  }

  // --------------------------------------------------------------------------
  // Table helpers
  // --------------------------------------------------------------------------

  function findColumnIndex(table, headerText) {
    if (!table) return -1;
    var headers = table.querySelectorAll('thead th');
    var search = headerText.toLowerCase();
    for (var i = 0; i < headers.length; i++) {
      if (cellText(headers[i]).toLowerCase().indexOf(search) !== -1) return i;
    }
    return -1;
  }

  function getDataRows(table) {
    if (!table) return [];
    var tbody = table.querySelector('tbody');
    if (!tbody) return [];
    return Array.from(tbody.querySelectorAll('tr'));
  }

  function findTable(idOrPartial) {
    var table = document.getElementById(idOrPartial);
    if (table && table.tagName === 'TABLE') return table;

    try {
      table = document.querySelector('table#' + CSS.escape(idOrPartial));
      if (table) return table;
    } catch (e) { /* CSS.escape may not exist in very old browsers */ }

    var tables = document.querySelectorAll('table[id]');
    for (var i = 0; i < tables.length; i++) {
      if (tables[i].id.indexOf(idOrPartial) !== -1) return tables[i];
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Summary Metrics table helpers (stage detail page)
  // --------------------------------------------------------------------------

  /**
   * The Summary Metrics table is rendered client-side by stagepage.js as a
   * DataTable with id="summary-metrics-table".
   *
   * Columns: Metric | Min | 25th percentile | Median | 75th percentile | Max
   */
  function parseSummaryMetrics() {
    var table = document.getElementById('summary-metrics-table');
    if (!table) return null;

    var metrics = {};
    var rows = getDataRows(table);

    rows.forEach(function (row) {
      var cells = row.querySelectorAll('td');
      if (cells.length < 6) return;

      var metricName = cellText(cells[0]);
      metrics[metricName] = {
        min:    parseCellValue(cellText(cells[1])),
        p25:    parseCellValue(cellText(cells[2])),
        median: parseCellValue(cellText(cells[3])),
        p75:    parseCellValue(cellText(cells[4])),
        max:    parseCellValue(cellText(cells[5])),
        row:    row,
        cells:  cells,
      };
    });

    return metrics;
  }

  // --------------------------------------------------------------------------
  // Checker 1 — Skew detection (stage detail)
  // --------------------------------------------------------------------------

  function checkSkew(metrics) {
    if (!metrics) return;
    var d = metrics['Duration'];
    if (!d) return;

    var median = d.median, p75 = d.p75, max = d.max;
    if (isNaN(max) || isNaN(p75) || isNaN(median)) return;
    if (max === 0 || p75 === 0 || median === 0) return;

    var maxP75 = max / p75;
    var maxMed = max / median;

    if (maxMed > config.severeSkewThreshold) {
      highlightRow(d.row, SEVERITY.CRITICAL,
        'Severe skew: Max duration is ' + maxMed.toFixed(1) + 'x the median.\n' +
        'Fix: Repartition data, use salting, or adjust join keys.');
      highlightCell(d.cells[5], SEVERITY.CRITICAL,
        'Max is ' + maxMed.toFixed(1) + 'x median');
      addIssue(SEVERITY.CRITICAL, 'Skew',
        'Severe skew: Max duration is ' + maxMed.toFixed(1) + 'x the median (threshold: ' +
        config.severeSkewThreshold + 'x)', d.row);
    } else if (maxP75 > config.skewThreshold) {
      highlightRow(d.row, SEVERITY.WARNING,
        'Skew: Max duration is ' + maxP75.toFixed(1) + 'x the 75th percentile.\n' +
        'Consider repartitioning or investigating key distribution.');
      highlightCell(d.cells[5], SEVERITY.WARNING,
        'Max is ' + maxP75.toFixed(1) + 'x p75');
      addIssue(SEVERITY.WARNING, 'Skew',
        'Skew: Max duration is ' + maxP75.toFixed(1) + 'x the 75th pctl (threshold: ' +
        config.skewThreshold + 'x)', d.row);
    }
  }

  // --------------------------------------------------------------------------
  // Checker 2 — Spill detection (stage detail)
  // --------------------------------------------------------------------------

  function checkSpill(metrics) {
    if (!metrics) return;

    var memSpill  = metrics['Spill (Memory)']  || metrics['Shuffle Spill (Memory)'];
    var diskSpill = metrics['Spill (Disk)']    || metrics['Shuffle Spill (Disk)'];

    function check(metric, label) {
      if (!metric) return;
      var max = metric.max;
      if (isNaN(max) || max === 0) return;

      var severity = SEVERITY.WARNING;
      var tip = label + ' detected (max: ' + cellText(metric.cells[5]) + ').\n' +
        'Fix: Increase executor memory, reduce partition size, or optimise queries.';

      if (max > 1073741824) {
        severity = SEVERITY.CRITICAL;
        tip = 'Heavy ' + label + ' (max: ' + cellText(metric.cells[5]) + ').\n' +
          'Fix: Increase spark.executor.memory or spark.memory.fraction,\n' +
          'reduce partition sizes, or repartition data.';
      }

      highlightRow(metric.row, severity, tip);
      highlightCell(metric.cells[5], severity, label + ': ' + cellText(metric.cells[5]));
      addIssue(severity, 'Spill', label + ' detected — max: ' + cellText(metric.cells[5]), metric.row);
    }

    check(memSpill, 'Memory spill');
    check(diskSpill, 'Disk spill');
  }

  // --------------------------------------------------------------------------
  // Checker 3 — GC pressure (stage detail)
  // --------------------------------------------------------------------------

  function checkGCPressure(metrics) {
    if (!metrics) return;

    var dur = metrics['Duration'];
    var gc  = metrics['GC Time'];
    if (!dur || !gc) return;

    var keys   = ['min', 'p25', 'median', 'p75', 'max'];
    var labels = ['Min', '25th pctl', 'Median', '75th pctl', 'Max'];
    var idx    = [1, 2, 3, 4, 5];

    var worstRatio = 0;
    var worstLabel = '';

    for (var i = 0; i < keys.length; i++) {
      var d = dur[keys[i]], g = gc[keys[i]];
      if (isNaN(d) || isNaN(g) || d === 0) continue;
      var ratio = g / d;
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worstLabel = labels[i];
      }
    }

    if (worstRatio > config.gcPressureThreshold) {
      var pct = (worstRatio * 100).toFixed(1);
      var severity = worstRatio > 0.25 ? SEVERITY.CRITICAL : SEVERITY.WARNING;

      highlightRow(gc.row, severity,
        'GC pressure: ' + pct + '% of task time in GC (' + worstLabel + ').\n' +
        'Fix: Increase executor memory or tune GC settings.');

      for (var j = 0; j < keys.length; j++) {
        var d2 = dur[keys[j]], g2 = gc[keys[j]];
        if (isNaN(d2) || isNaN(g2) || d2 === 0) continue;
        if (g2 / d2 > config.gcPressureThreshold) {
          highlightCell(gc.cells[idx[j]], severity,
            'GC: ' + (g2 / d2 * 100).toFixed(1) + '% of duration');
        }
      }

      addIssue(severity, 'GC Pressure',
        'GC consuming ' + pct + '% of task time at ' + worstLabel +
        ' (threshold: ' + (config.gcPressureThreshold * 100) + '%)', gc.row);
    }
  }

  // --------------------------------------------------------------------------
  // Checker 4 — Straggler detection (stage detail — task table)
  // --------------------------------------------------------------------------

  function checkStragglers() {
    // The task table is rendered client-side by stagepage.js with id "active-tasks-table".
    // DataTables uses server-side pagination, so we can only see the current page of tasks.
    var table = document.getElementById('active-tasks-table');
    if (!table) return;

    var durationCol = findColumnIndex(table, 'duration');
    if (durationCol === -1) return;

    var rows = getDataRows(table);
    var durations = [];

    rows.forEach(function (row) {
      var cells = row.querySelectorAll('td');
      if (durationCol >= cells.length) return;
      var dur = parseDuration(cellText(cells[durationCol]));
      if (!isNaN(dur)) {
        durations.push({ dur: dur, row: row, cell: cells[durationCol] });
      }
    });

    if (durations.length < 2) return;

    var sorted = durations.slice().sort(function (a, b) { return a.dur - b.dur; });
    var medianDur = sorted[Math.floor(sorted.length / 2)].dur;
    if (medianDur === 0) return;

    var count = 0;
    durations.forEach(function (item) {
      var ratio = item.dur / medianDur;
      if (ratio > config.stragglerMultiple) {
        count++;
        highlightRow(item.row, SEVERITY.WARNING,
          'Straggler task: ' + ratio.toFixed(1) + 'x the median duration.\n' +
          'Check: Data skew on this partition, slow node, or GC issues.');
        highlightCell(item.cell, SEVERITY.WARNING,
          'Straggler: ' + ratio.toFixed(1) + 'x median');
      }
    });

    if (count > 0) {
      addIssue(SEVERITY.WARNING, 'Stragglers',
        count + ' straggler task(s) running >' + config.stragglerMultiple + 'x median duration');
    }
  }

  // --------------------------------------------------------------------------
  // Checker 5 — Small tasks (stage detail)
  // --------------------------------------------------------------------------

  function checkSmallTasks(metrics) {
    if (!metrics) return;
    var d = metrics['Duration'];
    if (!d || isNaN(d.median)) return;

    // Try to extract total task count from the page
    var taskCount = 0;
    var bodyText = document.body.innerText;
    var m = bodyText.match(/Total Tasks[:\s]+(\d[\d,]*)/i) ||
            bodyText.match(/(\d[\d,]*)\s+tasks?/i);
    if (m) taskCount = parseInt(m[1].replace(/,/g, ''), 10);

    if (taskCount === 0) {
      var info = document.querySelector('.dataTables_info');
      if (info) {
        var im = cellText(info).match(/of\s+([\d,]+)\s+entries/i);
        if (im) taskCount = parseInt(im[1].replace(/,/g, ''), 10);
      }
    }

    if (d.median < config.smallTaskDurationMs && taskCount >= config.smallTaskCountMin) {
      addIssue(SEVERITY.INFO, 'Small Tasks',
        taskCount.toLocaleString() + ' tasks with median duration ' +
        d.median.toFixed(0) + 'ms. Consider coalescing partitions to reduce scheduling overhead.');
      highlightRow(d.row, SEVERITY.INFO,
        'Too many small tasks: ' + taskCount.toLocaleString() + ' tasks at ' +
        d.median.toFixed(0) + 'ms median.\n' +
        'Fix: Use .coalesce() or .repartition(), or lower spark.sql.shuffle.partitions.');
    }
  }

  // --------------------------------------------------------------------------
  // Checker 6 — Join strategy flags (SQL detail page)
  // --------------------------------------------------------------------------

  function checkJoinStrategies() {
    // The physical plan is in a collapsible <pre> rendered by ExecutionPage.scala.
    var planContainer = document.getElementById('physical-plan-details');
    var planPre = planContainer ? planContainer.querySelector('pre') : null;
    if (!planPre) return;

    var planText = planPre.textContent || '';
    if (!planText.trim()) return;

    // Save original so we can restore on clear / re-run
    if (!savedOriginals['plan-pre']) {
      savedOriginals['plan-pre'] = { element: planPre, text: planText };
    }

    var lines = planText.split('\n');
    var hasIssues = false;
    var highlighted = lines.map(function (line) {
      var esc = escapeHtml(line);

      if (/CartesianProduct/i.test(line)) {
        hasIssues = true;
        addIssue(SEVERITY.CRITICAL, 'Join Strategy',
          'CartesianProduct detected — produces N*M rows, almost always a mistake.');
        return '<span class="kindling-plan-critical">' + esc + '</span>';
      }
      if (/BroadcastNestedLoopJoin/i.test(line)) {
        hasIssues = true;
        addIssue(SEVERITY.WARNING, 'Join Strategy',
          'BroadcastNestedLoopJoin detected — can be very expensive. Check join condition.');
        return '<span class="kindling-plan-warning">' + esc + '</span>';
      }
      if (/SortMergeJoin/i.test(line)) {
        hasIssues = true;
        addIssue(SEVERITY.INFO, 'Join Strategy',
          'SortMergeJoin found. If one side is small, consider a broadcast hint or ' +
          'increasing spark.sql.autoBroadcastJoinThreshold.');
        return '<span class="kindling-plan-info">' + esc + '</span>';
      }
      if (/\bExchange\b/.test(line) && !/BroadcastExchange/.test(line)) {
        hasIssues = true;
        addIssue(SEVERITY.INFO, 'Shuffle', 'Shuffle Exchange: ' + line.trim());
        return '<span class="kindling-plan-info">' + esc + '</span>';
      }

      return esc;
    });

    if (hasIssues) {
      planPre.innerHTML = highlighted.join('\n');
    }
  }

  // --------------------------------------------------------------------------
  // Checker 7 — Missing predicate pushdown (SQL detail page)
  // --------------------------------------------------------------------------

  function checkPredicatePushdown() {
    var planContainer = document.getElementById('physical-plan-details');
    var planPre = planContainer ? planContainer.querySelector('pre') : null;
    if (!planPre) return;

    // Use saved original text so we read pre-modified content
    var planText = savedOriginals['plan-pre']
      ? savedOriginals['plan-pre'].text
      : (planPre.textContent || '');
    if (!planText.trim()) return;

    var hasEmptyPush = /(?:FileScan|Scan)\s+\w+.*?PushedFilters:\s*\[\s*\]/gi.test(planText);
    var hasFilter = /\bFilter\b/i.test(planText);

    if (hasEmptyPush && hasFilter) {
      addIssue(SEVERITY.WARNING, 'Predicate Pushdown',
        'Scan with empty PushedFilters while Filter operators exist. ' +
        'Filters may not be pushed to the data source.');
    }
  }

  // --------------------------------------------------------------------------
  // Checker 9 — Long-running / dominant stages (jobs page & job detail)
  // --------------------------------------------------------------------------

  function checkLongRunningStages() {
    // On job-detail pages, stage tables use stageTag-table IDs.
    var stageTable =
      findTable('activeStage-table') ||
      findTable('completedStage-table') ||
      findTable('failedStage-table');
    if (!stageTable) return;

    var durationCol = findColumnIndex(stageTable, 'duration');
    if (durationCol === -1) return;

    var rows = getDataRows(stageTable);
    var items = [];

    rows.forEach(function (row) {
      var cells = row.querySelectorAll('td');
      if (durationCol >= cells.length) return;
      var dur = parseDuration(cellText(cells[durationCol]));
      if (!isNaN(dur)) items.push({ dur: dur, row: row, cell: cells[durationCol] });
    });

    if (items.length < 2) return;

    var total = items.reduce(function (s, i) { return s + i.dur; }, 0);
    if (total === 0) return;

    items.forEach(function (item) {
      var frac = item.dur / total;
      if (frac > config.stageTimeDominance) {
        var pct = (frac * 100).toFixed(0);
        highlightRow(item.row, SEVERITY.WARNING,
          'This stage took ' + pct + '% of total job time.\n' +
          'Investigate for skew, spill, or inefficient operations.');
        highlightCell(item.cell, SEVERITY.WARNING, 'Dominant stage: ' + pct + '% of job time');
        addIssue(SEVERITY.WARNING, 'Dominant Stage',
          'A stage consumed ' + pct + '% of total job time (threshold: ' +
          (config.stageTimeDominance * 100) + '%)', item.row);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Checker 10 — Imbalanced executors (executors page)
  // --------------------------------------------------------------------------

  function checkExecutorBalance() {
    // The executors table is rendered client-side by executorspage.js.
    // Table ID: "active-executors-table"
    var table = document.getElementById('active-executors-table');
    if (!table) return;

    var shuffleReadCol = findColumnIndex(table, 'shuffle read');
    if (shuffleReadCol === -1) return;

    var rows = getDataRows(table);
    var items = [];

    rows.forEach(function (row) {
      var cells = row.querySelectorAll('td');
      if (shuffleReadCol >= cells.length) return;
      // Skip the driver row
      if (cells[0] && cellText(cells[0]).toLowerCase() === 'driver') return;

      var val = parseBytes(cellText(cells[shuffleReadCol]));
      if (!isNaN(val)) items.push({ val: val, row: row, cell: cells[shuffleReadCol] });
    });

    if (items.length < 2) return;

    var vals = items.map(function (i) { return i.val; }).filter(function (v) { return v > 0; });
    if (vals.length < 2) return;

    var minVal = Math.min.apply(null, vals);
    var maxVal = Math.max.apply(null, vals);
    if (minVal === 0) return;

    var ratio = maxVal / minVal;
    if (ratio > config.executorSkewRatio) {
      addIssue(SEVERITY.WARNING, 'Executor Skew',
        'Shuffle read imbalance: ' + ratio.toFixed(1) + 'x spread between min and max executor ' +
        '(threshold: ' + config.executorSkewRatio + 'x).');

      items.forEach(function (item) {
        if (item.val === maxVal) {
          highlightRow(item.row, SEVERITY.WARNING,
            'Highest shuffle read.\nSpread ratio: ' + ratio.toFixed(1) + 'x.');
          highlightCell(item.cell, SEVERITY.WARNING, 'Max shuffle read');
        } else if (item.val === minVal) {
          highlightCell(item.cell, SEVERITY.INFO, 'Min shuffle read');
        }
      });
    }
  }

  // --------------------------------------------------------------------------
  // Stage badges (stages list page)
  // --------------------------------------------------------------------------

  function addStageBadges() {
    var tableIds = [
      'activeStage-table', 'completedStage-table',
      'failedStage-table', 'pendingStage-table',
      'skippedStage-table',
    ];

    tableIds.forEach(function (tableId) {
      var table = findTable(tableId);
      if (!table) return;

      var durationCol = findColumnIndex(table, 'duration');
      var rows = getDataRows(table);
      if (rows.length === 0 || durationCol < 0) return;

      var durations = [];
      rows.forEach(function (row) {
        var cells = row.querySelectorAll('td');
        if (durationCol < cells.length) {
          var dur = parseDuration(cellText(cells[durationCol]));
          if (!isNaN(dur)) durations.push(dur);
        }
      });

      if (durations.length < 2) return;
      var sorted = durations.slice().sort(function (a, b) { return a - b; });
      var medianDur = sorted[Math.floor(sorted.length / 2)];

      rows.forEach(function (row) {
        var cells = row.querySelectorAll('td');
        if (durationCol >= cells.length) return;
        var dur = parseDuration(cellText(cells[durationCol]));
        if (isNaN(dur) || medianDur === 0) return;

        var ratio = dur / medianDur;
        if (ratio > config.stragglerMultiple) {
          var idCell = cells[0];
          if (idCell && !idCell.querySelector('.kindling-stage-badge')) {
            var badge = document.createElement('span');
            badge.className = 'kindling-stage-badge warning kindling-tooltip';
            badge.setAttribute('data-kindling-tip',
              'This stage is ' + ratio.toFixed(1) + 'x slower than the median.');
            idCell.appendChild(badge);
          }
          highlightRow(row, SEVERITY.WARNING,
            'Stage duration ' + ratio.toFixed(1) + 'x the median — possible bottleneck.');
        }
      });
    });
  }

  // --------------------------------------------------------------------------
  // Diagnostic panel (on-page floating summary)
  // --------------------------------------------------------------------------

  function buildPanel() {
    var existing = document.getElementById('kindling-panel');
    if (existing) existing.remove();

    var criticals = issues.filter(function (i) { return i.severity === SEVERITY.CRITICAL; });
    var warnings  = issues.filter(function (i) { return i.severity === SEVERITY.WARNING; });
    var infos     = issues.filter(function (i) { return i.severity === SEVERITY.INFO; });
    var total     = issues.length;

    var panel = document.createElement('div');
    panel.id = 'kindling-panel';

    if (total === 0) {
      panel.classList.add('collapsed');
      panel.innerHTML =
        '<div id="kindling-panel-header">' +
          '<span id="kindling-panel-title">Kindling: No issues</span>' +
          '<span id="kindling-panel-toggle">&#x25B6;</span>' +
        '</div>' +
        '<div id="kindling-panel-body">' +
          '<div style="padding:8px 0;color:#666;font-size:12px;">' +
            'No performance issues detected on this page.' +
          '</div>' +
        '</div>';
      document.body.appendChild(panel);
      setupPanelToggle(panel);
      return;
    }

    var badges = '';
    if (criticals.length) badges += '<span class="kindling-count critical">' + criticals.length + '</span>';
    if (warnings.length)  badges += '<span class="kindling-count warning">'  + warnings.length  + '</span>';
    if (infos.length)     badges += '<span class="kindling-count info">'     + infos.length     + '</span>';

    var body = '';
    var groups = [
      { severity: SEVERITY.CRITICAL, label: 'Critical', items: criticals },
      { severity: SEVERITY.WARNING,  label: 'Warnings', items: warnings },
      { severity: SEVERITY.INFO,     label: 'Info',     items: infos },
    ];

    groups.forEach(function (g) {
      if (!g.items.length) return;
      body += '<div class="kindling-section">';
      body += '<div class="kindling-section-title ' + g.severity + '">' +
              g.label + ' (' + g.items.length + ')</div>';
      g.items.forEach(function (item) {
        body += '<div class="kindling-issue">' +
          '<span class="kindling-badge ' + item.severity + '">' + escapeHtml(item.category) + '</span> ' +
          escapeHtml(item.message) +
          '</div>';
      });
      body += '</div>';
    });

    panel.innerHTML =
      '<div id="kindling-panel-header">' +
        '<span id="kindling-panel-title">Kindling ' + badges + '</span>' +
        '<span id="kindling-panel-toggle">&#x25BC;</span>' +
      '</div>' +
      '<div id="kindling-panel-body">' + body + '</div>';

    document.body.appendChild(panel);
    setupPanelToggle(panel);

    // Make issues clickable to scroll to the affected element
    var issueEls = panel.querySelectorAll('.kindling-issue');
    var flatIssues = criticals.concat(warnings, infos);
    issueEls.forEach(function (el, idx) {
      var issue = flatIssues[idx];
      if (issue && issue.element) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', function () {
          issue.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          issue.element.style.transition = 'outline 0.2s';
          issue.element.style.outline = '3px solid #f57c00';
          setTimeout(function () { issue.element.style.outline = ''; }, 2000);
        });
      }
    });
  }

  function setupPanelToggle(panel) {
    var header = panel.querySelector('#kindling-panel-header');
    var toggle = panel.querySelector('#kindling-panel-toggle');
    header.addEventListener('click', function () {
      panel.classList.toggle('collapsed');
      toggle.innerHTML = panel.classList.contains('collapsed') ? '&#x25B6;' : '&#x25BC;';
    });
  }

  // --------------------------------------------------------------------------
  // Run all diagnostics
  // --------------------------------------------------------------------------

  function runDiagnostics() {
    issues.length = 0;
    clearHighlights();

    var sparkDetected = detectSparkUI();
    if (!sparkDetected) {
      return {
        sparkDetected: false,
        pageType: 'unknown',
        issues: [],
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
      };
    }

    var pageType = getPageType();

    try {
      switch (pageType) {
        case 'stage-detail': {
          var metrics = parseSummaryMetrics();
          checkSkew(metrics);
          checkSpill(metrics);
          checkGCPressure(metrics);
          checkStragglers();
          checkSmallTasks(metrics);
          break;
        }
        case 'stages-list': {
          addStageBadges();
          break;
        }
        case 'sql-detail': {
          checkJoinStrategies();
          checkPredicatePushdown();
          break;
        }
        case 'sql-list': {
          // No specific checks for the SQL list page yet.
          break;
        }
        case 'jobs-list':
        case 'job-detail': {
          checkLongRunningStages();
          break;
        }
        case 'executors': {
          checkExecutorBalance();
          break;
        }
        default:
          break;
      }
    } catch (e) {
      console.warn('[Kindling] Error during analysis:', e);
    }

    buildPanel();

    var criticalCount = issues.filter(function (i) { return i.severity === SEVERITY.CRITICAL; }).length;
    var warningCount  = issues.filter(function (i) { return i.severity === SEVERITY.WARNING; }).length;
    var infoCount     = issues.filter(function (i) { return i.severity === SEVERITY.INFO; }).length;

    // Update the extension icon badge
    try {
      chrome.runtime.sendMessage({
        type: 'kindling-badge-update',
        criticalCount: criticalCount,
        warningCount: warningCount,
        infoCount: infoCount,
      });
    } catch (e) { /* popup / service worker may not be listening */ }

    return {
      sparkDetected: true,
      pageType: pageType,
      issues: issues.map(function (i) {
        return { severity: i.severity, category: i.category, message: i.message };
      }),
      criticalCount: criticalCount,
      warningCount: warningCount,
      infoCount: infoCount,
    };
  }

  // --------------------------------------------------------------------------
  // Clear all diagnostics
  // --------------------------------------------------------------------------

  function clearDiagnostics() {
    issues.length = 0;
    clearHighlights();
    var panel = document.getElementById('kindling-panel');
    if (panel) panel.remove();

    try {
      chrome.runtime.sendMessage({
        type: 'kindling-badge-update',
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
      });
    } catch (e) { /* ignore */ }
  }

  // --------------------------------------------------------------------------
  // Message listener — commands from popup / service worker
  // --------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === 'kindling-analyze') {
      chrome.storage.sync.get('config', function (result) {
        config = Object.assign({}, DEFAULT_CONFIG, result.config || {});
        var results = runDiagnostics();
        sendResponse(results);
      });
      return true; // async response
    }

    if (message.type === 'kindling-clear') {
      clearDiagnostics();
      sendResponse({ cleared: true });
      return false;
    }

    if (message.type === 'kindling-status') {
      sendResponse({
        sparkDetected: detectSparkUI(),
        pageType: getPageType(),
        issueCount: issues.length,
      });
      return false;
    }
  });

  // TODO: "Watch mode" — re-analyse when page content changes
  // TODO: Export diagnostic report as JSON or markdown
  // TODO: Detect Spark UI embedded in iframes (Databricks)
  // TODO: Firefox WebExtension support
})();
