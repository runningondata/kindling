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
    smallFileAvgSizeWarningMb: 10,
    smallFileAvgSizeCriticalMb: 1,
    smallFileMinCount: 100,
    memoryUtilWarning: 0.90,
    memoryUtilCritical: 0.95,
    longFilterCharThreshold: 500,
    longFilterPredicateThreshold: 10,
    estimationErrorWarning: 100,
    estimationErrorCritical: 1000,
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

    // Only return bare number if string has no letter suffixes (avoids
    // matching byte values like "2.0 GiB" as 2.0 ms duration).
    if (!/[a-zA-Z]/.test(str)) {
      var bare = parseFloat(str);
      if (!isNaN(bare)) return bare;
    }
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

  function formatBytesHuman(bytes) {
    if (bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i >= units.length) i = units.length - 1;
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
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

    // Reset any coloured plan-viz SVG nodes
    document.querySelectorAll('#plan-viz-graph .node rect[data-kindling-original-fill]').forEach(function (rect) {
      rect.style.fill = rect.getAttribute('data-kindling-original-fill');
      rect.style.stroke = rect.getAttribute('data-kindling-original-stroke') || '';
      rect.removeAttribute('data-kindling-original-fill');
      rect.removeAttribute('data-kindling-original-stroke');
    });

    // Remove SQL syntax highlighting tooltips
    document.querySelectorAll('.kindling-sql-tooltip').forEach(function (el) {
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
    var bodyText = document.body.innerText || document.body.textContent || '';
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

    highlightPlanVizNodes();
  }

  // --------------------------------------------------------------------------
  // Plan visualization SVG node colouring
  // --------------------------------------------------------------------------

  var PLAN_VIZ_COLORS = {
    critical: { fill: 'rgba(211, 47, 47, 0.25)', stroke: '#d32f2f' },
    warning:  { fill: 'rgba(245, 124, 0, 0.25)', stroke: '#f57c00' },
    info:     { fill: 'rgba(25, 118, 210, 0.18)', stroke: '#1976d2' },
  };

  var PLAN_VIZ_PATTERNS = [
    { pattern: /CartesianProduct/i, severity: 'critical' },
    { pattern: /BroadcastNestedLoopJoin/i, severity: 'warning' },
    { pattern: /SortMergeJoin/i, severity: 'info' },
    { pattern: /\bExchange\b(?!.*BroadcastExchange)/, severity: 'info' },
  ];

  function highlightPlanVizNodes() {
    var svg = document.querySelector('#plan-viz-graph svg');
    if (!svg) return;

    svg.querySelectorAll('.node').forEach(function (node) {
      var label = node.getAttribute('name') || '';
      for (var i = 0; i < PLAN_VIZ_PATTERNS.length; i++) {
        if (!PLAN_VIZ_PATTERNS[i].pattern.test(label)) continue;

        var rect = node.querySelector('rect');
        if (!rect) break;

        var colors = PLAN_VIZ_COLORS[PLAN_VIZ_PATTERNS[i].severity];

        // Preserve originals for clearHighlights
        if (!rect.hasAttribute('data-kindling-original-fill')) {
          rect.setAttribute('data-kindling-original-fill', rect.style.fill || '');
          rect.setAttribute('data-kindling-original-stroke', rect.style.stroke || '');
        }

        rect.style.fill = colors.fill;
        rect.style.stroke = colors.stroke;
        rect.style.strokeWidth = '2px';
        break;
      }
    });
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
  // Feature 1 — SQL Syntax Highlighting on Plan Expressions
  // --------------------------------------------------------------------------

  var SQL_KEYWORDS = [
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN',
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'IS', 'NULL', 'TRUE', 'FALSE',
    'JOIN', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'EXISTS',
    'DISTINCT', 'CAST', 'COALESCE', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL',
    'CROSS', 'ASC', 'DESC', 'IF', 'OVER', 'PARTITION', 'ROWS', 'RANGE',
    'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW', 'FILTER', 'PROJECT',
    'SCAN', 'SORT', 'AGGREGATE', 'EXCHANGE', 'BROADCAST', 'HASH',
  ];

  var SQL_KEYWORD_SET = {};
  SQL_KEYWORDS.forEach(function (kw) { SQL_KEYWORD_SET[kw] = true; });

  function tokenizeSql(text) {
    var tokens = [];
    var i = 0;
    var len = text.length;

    while (i < len) {
      // Whitespace
      if (/\s/.test(text[i])) {
        var start = i;
        while (i < len && /\s/.test(text[i])) i++;
        tokens.push({ type: 'ws', value: text.substring(start, i) });
        continue;
      }

      // Single-quoted string
      if (text[i] === "'") {
        var start = i;
        i++;
        while (i < len && text[i] !== "'") {
          if (text[i] === '\\') i++;
          i++;
        }
        if (i < len) i++; // closing quote
        tokens.push({ type: 'string', value: text.substring(start, i) });
        continue;
      }

      // Multi-char operators
      if (i + 1 < len) {
        var two = text[i] + text[i + 1];
        if (two === '<=' || two === '>=' || two === '!=' || two === '<>') {
          tokens.push({ type: 'operator', value: two });
          i += 2;
          continue;
        }
      }

      // Single-char operators
      if ('=<>+-*/'.indexOf(text[i]) !== -1) {
        tokens.push({ type: 'operator', value: text[i] });
        i++;
        continue;
      }

      // Numbers (only when not preceded by letter/underscore)
      if (/\d/.test(text[i]) && (i === 0 || !/[a-zA-Z_#]/.test(text[i - 1]))) {
        var start = i;
        while (i < len && /[\d.]/.test(text[i])) i++;
        if (i < len && /[eE]/.test(text[i])) {
          i++;
          if (i < len && /[+-]/.test(text[i])) i++;
          while (i < len && /\d/.test(text[i])) i++;
        }
        // Suffix like L for long
        if (i < len && /[lLdDfF]/.test(text[i])) i++;
        tokens.push({ type: 'number', value: text.substring(start, i) });
        continue;
      }

      // Identifiers and keywords (include # for Spark column refs like col#23)
      if (/[a-zA-Z_]/.test(text[i])) {
        var start = i;
        while (i < len && /[a-zA-Z0-9_#.]/.test(text[i])) i++;
        var word = text.substring(start, i);

        // Check if followed by ( → function call
        var peek = i;
        while (peek < len && text[peek] === ' ') peek++;
        if (peek < len && text[peek] === '(') {
          if (SQL_KEYWORD_SET[word.toUpperCase()]) {
            tokens.push({ type: 'keyword', value: word });
          } else {
            tokens.push({ type: 'function', value: word });
          }
        } else if (SQL_KEYWORD_SET[word.toUpperCase()]) {
          tokens.push({ type: 'keyword', value: word });
        } else {
          tokens.push({ type: 'identifier', value: word });
        }
        continue;
      }

      // Everything else (parens, commas, brackets, etc.)
      tokens.push({ type: 'punct', value: text[i] });
      i++;
    }

    return tokens;
  }

  function renderSqlHighlighted(text) {
    var tokens = tokenizeSql(text);
    var html = '';
    tokens.forEach(function (token) {
      var esc = escapeHtml(token.value);
      switch (token.type) {
        case 'keyword':
          html += '<span class="kindling-sql-keyword">' + esc + '</span>';
          break;
        case 'function':
          html += '<span class="kindling-sql-function">' + esc + '</span>';
          break;
        case 'string':
          html += '<span class="kindling-sql-string">' + esc + '</span>';
          break;
        case 'number':
          html += '<span class="kindling-sql-number">' + esc + '</span>';
          break;
        case 'operator':
          html += '<span class="kindling-sql-operator">' + esc + '</span>';
          break;
        default:
          html += esc;
      }
    });
    return html;
  }

  function setupSqlHighlighting() {
    var planContainer = document.getElementById('physical-plan-details');
    var planPre = planContainer ? planContainer.querySelector('pre') : null;
    if (!planPre) return;

    // Find expression spans within the plan text. Expressions typically appear
    // after node names like Filter, Project, etc. We look for lines with
    // parenthesised expressions containing SQL-like content.
    var exprPattern = /(\+- (?:Filter|Project|Aggregate|SortMergeJoin|BroadcastHashJoin|BroadcastNestedLoopJoin|HashAggregate|Sort|Window|Expand|Generate)\s+)(.*)/;

    // We operate on the already-rendered innerHTML (may contain highlight spans)
    // Instead, work with original text for detection, then annotate
    var originalText = savedOriginals['plan-pre']
      ? savedOriginals['plan-pre'].text
      : (planPre.textContent || '');

    var lines = originalText.split('\n');
    var expressionLines = [];
    lines.forEach(function (line, idx) {
      var match = line.match(exprPattern);
      if (match && match[2] && match[2].length > 20) {
        expressionLines.push({ lineIdx: idx, prefix: match[1], expr: match[2] });
      }
    });

    if (expressionLines.length === 0) return;

    // Create hoverable regions over the pre element by wrapping expression
    // portions. Since the pre's innerHTML may already have been modified by
    // checkJoinStrategies, we work with the current innerHTML.
    var currentHtml = planPre.innerHTML;
    var currentLines = currentHtml.split('\n');

    expressionLines.forEach(function (entry) {
      if (entry.lineIdx >= currentLines.length) return;
      var lineHtml = currentLines[entry.lineIdx];

      // Wrap the line in a hoverable span (only if not already wrapped)
      if (lineHtml.indexOf('kindling-sql-expr') === -1) {
        currentLines[entry.lineIdx] =
          '<span class="kindling-sql-expr" data-kindling-sql="' +
          escapeHtml(entry.expr).replace(/"/g, '&quot;') + '">' +
          lineHtml + '</span>';
      }
    });

    planPre.innerHTML = currentLines.join('\n');

    // Attach hover handlers
    planPre.querySelectorAll('.kindling-sql-expr').forEach(function (span) {
      span.addEventListener('mouseenter', function (e) {
        var existing = document.querySelector('.kindling-sql-tooltip');
        if (existing) existing.remove();

        var rawExpr = span.getAttribute('data-kindling-sql');
        if (!rawExpr) return;

        var tooltip = document.createElement('div');
        tooltip.className = 'kindling-sql-tooltip';
        tooltip.innerHTML = renderSqlHighlighted(rawExpr);

        document.body.appendChild(tooltip);

        var rect = span.getBoundingClientRect();
        tooltip.style.top = (rect.bottom + window.scrollY + 4) + 'px';
        tooltip.style.left = (rect.left + window.scrollX) + 'px';

        // Keep tooltip on screen
        var tooltipRect = tooltip.getBoundingClientRect();
        if (tooltipRect.right > window.innerWidth - 10) {
          tooltip.style.left = (window.innerWidth - tooltipRect.width - 10) + 'px';
        }
      });

      span.addEventListener('mouseleave', function (e) {
        // Delay removal so user can move to tooltip
        setTimeout(function () {
          var tooltip = document.querySelector('.kindling-sql-tooltip');
          if (tooltip && !tooltip.matches(':hover')) {
            tooltip.remove();
          }
        }, 200);
      });
    });
  }

  // --------------------------------------------------------------------------
  // Feature 2 — Long Filter Condition Detection
  // --------------------------------------------------------------------------

  function checkLongFilters() {
    var planContainer = document.getElementById('physical-plan-details');
    var planPre = planContainer ? planContainer.querySelector('pre') : null;
    if (!planPre) return;

    var planText = savedOriginals['plan-pre']
      ? savedOriginals['plan-pre'].text
      : (planPre.textContent || '');
    if (!planText.trim()) return;

    // Match Filter nodes and extract the condition expression
    var filterPattern = /\+- Filter\s+(.*)/g;
    var match;

    while ((match = filterPattern.exec(planText)) !== null) {
      var condition = match[1];
      if (!condition) continue;

      var charLen = condition.length;

      // Count AND/OR predicates
      var predicateCount = 0;
      var predMatch = condition.match(/\b(?:AND|OR)\b/gi);
      if (predMatch) predicateCount = predMatch.length;

      var isLong = charLen > config.longFilterCharThreshold ||
                   predicateCount > config.longFilterPredicateThreshold;
      if (!isLong) continue;

      var severity;
      if (charLen > 1000 || predicateCount > 20) {
        severity = SEVERITY.WARNING;
      } else {
        severity = SEVERITY.INFO;
      }

      addIssue(severity, 'Long Filter',
        'Long filter condition detected (' + predicateCount + ' predicates, ' +
        charLen + ' characters). Very long filter expressions can cause code generation ' +
        'issues and slow evaluation. Consider simplifying or breaking into stages.');
    }
  }

  // --------------------------------------------------------------------------
  // Feature 3 — Failed Query Error Handling
  // --------------------------------------------------------------------------

  function checkFailedQueries() {
    var pageType = getPageType();

    if (pageType === 'sql-list') {
      // On the SQL list page, scan for queries marked as failed
      var tables = document.querySelectorAll('table');
      tables.forEach(function (table) {
        var statusCol = findColumnIndex(table, 'status');
        if (statusCol === -1) {
          // Also check for visual indicators of failure
          var rows = getDataRows(table);
          rows.forEach(function (row) {
            var text = cellText(row).toLowerCase();
            if (text.indexOf('failed') !== -1) {
              highlightRow(row, SEVERITY.CRITICAL,
                'This query failed. Click to see error details.');
              addIssue(SEVERITY.CRITICAL, 'Failed Query',
                'Failed query detected in SQL list.', row);
            }
          });
          return;
        }

        var rows = getDataRows(table);
        rows.forEach(function (row) {
          var cells = row.querySelectorAll('td');
          if (statusCol >= cells.length) return;
          var status = cellText(cells[statusCol]).toLowerCase();
          if (status.indexOf('failed') !== -1) {
            highlightRow(row, SEVERITY.CRITICAL,
              'This query failed. Click to see error details.');
            addIssue(SEVERITY.CRITICAL, 'Failed Query',
              'Failed query detected in SQL list.', row);
          }
        });
      });

      // Also scan for any elements with failure styling
      document.querySelectorAll('.failed, .FAILED, [class*="fail"]').forEach(function (el) {
        var row = el.closest('tr');
        if (row && !row.classList.contains('kindling-highlight-critical')) {
          highlightRow(row, SEVERITY.CRITICAL,
            'This query failed. Click to see error details.');
          addIssue(SEVERITY.CRITICAL, 'Failed Query',
            'Failed query detected in SQL list.', row);
        }
      });
    }

    if (pageType === 'sql-detail') {
      // On a SQL detail page, check if this query has failed and extract error
      var bodyText = document.body.innerText;

      // Look for error/exception text patterns
      var errorPatterns = [
        /(?:Error|Exception|FAILED)[:\s]+([\s\S]{1,500})/i,
        /Status:\s*FAILED[\s\S]*?(?:Error|Exception)[:\s]+([\s\S]{1,500})/i,
      ];

      // Check for specific failure indicators
      var failedIndicators = document.querySelectorAll(
        '.alert-danger, .alert-error, .error-message, [class*="error"], [class*="fail"]'
      );

      failedIndicators.forEach(function (el) {
        var errorText = cellText(el);
        if (errorText && errorText.length > 10) {
          var shortError = errorText.length > 200 ? errorText.substring(0, 200) + '...' : errorText;
          var fullTip = errorText.length > 200 ? errorText : null;

          addIssue(SEVERITY.CRITICAL, 'Failed Query',
            'Query failed: ' + shortError, el);
          if (fullTip) {
            highlightElement(el, SEVERITY.CRITICAL, fullTip);
          } else {
            highlightElement(el, SEVERITY.CRITICAL, shortError);
          }
        }
      });

      // Also check page title/header for "FAILED" status
      var headers = document.querySelectorAll('h3, h4, .title, .page-title');
      headers.forEach(function (h) {
        if (/failed/i.test(cellText(h))) {
          // Try to find the error message nearby
          var nextSibling = h.nextElementSibling;
          var errorMsg = '';
          if (nextSibling) {
            errorMsg = cellText(nextSibling);
          }
          if (!errorMsg) {
            // Search for pre/code blocks that might contain the stack trace
            var pre = document.querySelector('pre.stacktrace, pre.error, .error pre');
            if (pre) errorMsg = cellText(pre);
          }

          if (errorMsg) {
            var shortError = errorMsg.length > 200 ? errorMsg.substring(0, 200) + '...' : errorMsg;
            addIssue(SEVERITY.CRITICAL, 'Failed Query',
              'Query failed: ' + shortError, h);
          } else {
            addIssue(SEVERITY.CRITICAL, 'Failed Query',
              'This query has failed. Check the Spark UI for error details.', h);
          }
        }
      });
    }
  }

  // --------------------------------------------------------------------------
  // Feature 6 — Memory Over-Utilisation Detection (Executors page)
  // --------------------------------------------------------------------------

  function checkMemoryUtilisation() {
    var table = document.getElementById('active-executors-table');
    if (!table) return;

    var memCol = findColumnIndex(table, 'storage memory');
    if (memCol === -1) memCol = findColumnIndex(table, 'memory used');
    if (memCol === -1) return;

    var rows = getDataRows(table);
    rows.forEach(function (row) {
      var cells = row.querySelectorAll('td');
      if (memCol >= cells.length) return;

      // Skip driver row
      if (cells[0] && cellText(cells[0]).toLowerCase() === 'driver') return;

      var memText = cellText(cells[memCol]);
      // Storage Memory column format: "used / total" e.g. "2.5 GB / 2.7 GB"
      var parts = memText.split('/');
      if (parts.length < 2) return;

      var used = parseBytes(parts[0].trim());
      var total = parseBytes(parts[1].trim());
      if (isNaN(used) || isNaN(total) || total === 0) return;

      var utilisation = used / total;
      var executorId = cells[0] ? cellText(cells[0]) : 'unknown';
      var pct = (utilisation * 100).toFixed(1);

      if (utilisation >= config.memoryUtilCritical) {
        highlightCell(cells[memCol], SEVERITY.CRITICAL,
          'Memory utilisation: ' + pct + '%. Risk of OOM.');
        highlightRow(row, SEVERITY.CRITICAL,
          'Executor ' + executorId + ' memory at ' + pct + '%.\n' +
          'Risk of spill or OOM. Increase executor memory or reduce partition sizes.');
        addIssue(SEVERITY.CRITICAL, 'Memory',
          'Executor ' + executorId + ' memory utilisation at ' + pct + '%. ' +
          'Risk of spill or OOM. Consider increasing executor memory or reducing partition sizes.',
          row);
      } else if (utilisation >= config.memoryUtilWarning) {
        highlightCell(cells[memCol], SEVERITY.WARNING,
          'Memory utilisation: ' + pct + '%.');
        highlightRow(row, SEVERITY.WARNING,
          'Executor ' + executorId + ' memory at ' + pct + '%.\n' +
          'Approaching capacity. Monitor for spill.');
        addIssue(SEVERITY.WARNING, 'Memory',
          'Executor ' + executorId + ' memory utilisation at ' + pct + '%. ' +
          'Risk of spill or OOM. Consider increasing executor memory or reducing partition sizes.',
          row);
      }
    });
  }

  // --------------------------------------------------------------------------
  // Feature 7 — Small Files Reading Detection (SQL detail page)
  // --------------------------------------------------------------------------

  function checkSmallFiles() {
    var planContainer = document.getElementById('physical-plan-details');
    if (!planContainer) return;

    // Look for scan node metric tables within the plan details
    // Scan nodes are typically displayed as expandable sections with metrics
    var planText = savedOriginals['plan-pre']
      ? savedOriginals['plan-pre'].text
      : '';

    // Also check metric tables/sections that appear when nodes are expanded
    var allText = planContainer.textContent || '';

    // Pattern 1: Look for metrics in expanded node details
    // "number of files read: N" and "size of files read: X MB"
    var filesReadMatch = allText.match(/number of files read[:\s]+(\d[\d,]*)/i);
    var sizeReadMatch = allText.match(/size of files read[:\s]+([\d.]+\s*(?:B|KiB|MiB|GiB|TiB|KB|MB|GB|TB))/i);

    if (!filesReadMatch && !sizeReadMatch) {
      // Also check the node details sections
      var detailSections = planContainer.querySelectorAll(
        '.node-detail, .metrics, [class*="metric"], table'
      );
      detailSections.forEach(function (section) {
        var text = cellText(section);
        if (!filesReadMatch) {
          var fm = text.match(/number of files(?:\s+read)?[:\s]+(\d[\d,]*)/i);
          if (fm) filesReadMatch = fm;
        }
        if (!sizeReadMatch) {
          var sm = text.match(/size of files(?:\s+read)?[:\s]+([\d.]+\s*(?:B|KiB|MiB|GiB|TiB|KB|MB|GB|TB))/i);
          if (sm) sizeReadMatch = sm;
        }
      });
    }

    // Also scan the plan text itself for FileScan metrics
    if (!filesReadMatch) {
      var fm = planText.match(/files\s*(?:read|scanned)[:\s]+(\d[\d,]*)/i) ||
               allText.match(/(?:files|numFiles)[:\s]+(\d[\d,]*)/i);
      if (fm) filesReadMatch = fm;
    }
    if (!sizeReadMatch) {
      var sm = planText.match(/(?:size|bytes)\s*(?:read|scanned)[:\s]+([\d.]+\s*(?:B|KiB|MiB|GiB|TiB|KB|MB|GB|TB))/i) ||
               allText.match(/(?:data\s*size|totalSize)[:\s]+([\d.]+\s*(?:B|KiB|MiB|GiB|TiB|KB|MB|GB|TB))/i);
      if (sm) sizeReadMatch = sm;
    }

    if (!filesReadMatch || !sizeReadMatch) return;

    var numFiles = parseInt(filesReadMatch[1].replace(/,/g, ''), 10);
    var totalSize = parseBytes(sizeReadMatch[1]);

    if (isNaN(numFiles) || isNaN(totalSize) || numFiles === 0) return;
    if (numFiles < config.smallFileMinCount) return;

    var avgSize = totalSize / numFiles;
    var avgSizeMb = avgSize / 1048576;

    if (avgSizeMb < config.smallFileAvgSizeWarningMb) {
      var severity = avgSizeMb < config.smallFileAvgSizeCriticalMb ? SEVERITY.WARNING : SEVERITY.INFO;
      var avgStr = formatBytesHuman(avgSize);

      addIssue(severity, 'Small Files',
        'Scan reading ' + numFiles.toLocaleString() + ' files averaging ' + avgStr +
        ' per file. Small files cause excessive task overhead. Consider running OPTIMIZE ' +
        'to compact files, or adjusting spark.sql.files.maxPartitionBytes.');
    }
  }

  // --------------------------------------------------------------------------
  // Feature 8 — PII Pattern Detection in Plan Metadata
  // --------------------------------------------------------------------------

  var PII_COLUMN_PATTERNS = [
    /\bemail\b/i,
    /\bphone\b/i,
    /\bssn\b/i,
    /\bsocial_security\b/i,
    /\bnational_id\b/i,
    /\bpassport\b/i,
    /\bcredit_card\b/i,
    /\bcard_number\b/i,
    /\bcvv\b/i,
    /\bdate_of_birth\b/i,
    /\bdob\b/i,
    /\bfirst_name\b/i,
    /\blast_name\b/i,
    /\bfull_name\b/i,
    /\bcustomer_name\b/i,
    /\buser_name\b/i,
    /\baddress\b/i,
    /\bpostcode\b/i,
    /\bzip_code\b/i,
    /\bip_address\b/i,
    /\bnational_insurance\b/i,
    /\bni_number\b/i,
  ];

  var PII_LITERAL_PATTERNS = [
    { pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, label: 'email address' },
    { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: 'SSN' },
    { pattern: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, label: 'phone number' },
  ];

  function checkPiiPatterns() {
    var planContainer = document.getElementById('physical-plan-details');
    if (!planContainer) return;

    var planText = savedOriginals['plan-pre']
      ? savedOriginals['plan-pre'].text
      : (planContainer.textContent || '');
    if (!planText.trim()) return;

    var foundColumns = {};

    // Check column name patterns
    PII_COLUMN_PATTERNS.forEach(function (pattern) {
      var matches = planText.match(new RegExp(pattern.source, 'gi'));
      if (matches) {
        matches.forEach(function (match) {
          // Avoid duplicates
          var key = match.toLowerCase();
          if (!foundColumns[key]) {
            foundColumns[key] = match;
          }
        });
      }
    });

    Object.keys(foundColumns).forEach(function (key) {
      addIssue(SEVERITY.INFO, 'PII',
        'Potential PII column detected: "' + foundColumns[key] + '". ' +
        'Verify that this data is handled in compliance with your data governance policies. ' +
        'Consider column-level masking or access controls in Unity Catalog.');
    });

    // Check literal value patterns in filter expressions
    PII_LITERAL_PATTERNS.forEach(function (entry) {
      var matches = planText.match(new RegExp(entry.pattern.source, 'g'));
      if (matches) {
        // Deduplicate
        var unique = [];
        var seen = {};
        matches.forEach(function (m) {
          if (!seen[m]) {
            seen[m] = true;
            unique.push(m);
          }
        });
        unique.forEach(function (val) {
          addIssue(SEVERITY.INFO, 'PII',
            'Potential PII literal (' + entry.label + ') found in plan: "' + val + '". ' +
            'Consider whether this value should be visible in query plans/logs.');
        });
      }
    });
  }

  // --------------------------------------------------------------------------
  // Feature 9 — Estimation Error Detection (SQL detail page)
  // --------------------------------------------------------------------------

  function checkEstimationErrors() {
    var planContainer = document.getElementById('physical-plan-details');
    if (!planContainer) return;

    var allText = planContainer.textContent || '';

    // Spark UI renders estimation errors with multipliers like "(1000X)"
    // Pattern: look for row count metrics with estimation errors
    var errorPattern = /\((\d[\d,]*)X\)/g;
    var match;
    var worst = 0;
    var worstText = '';

    while ((match = errorPattern.exec(allText)) !== null) {
      var multiplier = parseInt(match[1].replace(/,/g, ''), 10);
      if (isNaN(multiplier)) continue;

      if (multiplier > worst) {
        worst = multiplier;
        worstText = match[0];
      }

      if (multiplier >= config.estimationErrorCritical) {
        addIssue(SEVERITY.CRITICAL, 'Estimation Error',
          'Row estimation error of ' + multiplier.toLocaleString() + 'x detected. ' +
          'This suggests table/column statistics are stale or missing. ' +
          'Run ANALYZE TABLE to update statistics. Poor estimates can cause ' +
          'the optimizer to choose suboptimal join strategies.');
      } else if (multiplier >= config.estimationErrorWarning) {
        addIssue(SEVERITY.WARNING, 'Estimation Error',
          'Row estimation error of ' + multiplier.toLocaleString() + 'x detected. ' +
          'This suggests table/column statistics are stale or missing. ' +
          'Run ANALYZE TABLE to update statistics. Poor estimates can cause ' +
          'the optimizer to choose suboptimal join strategies.');
      }
    }

    // Also look for nodes with metrics showing estimated vs actual
    var metricTables = planContainer.querySelectorAll('table');
    metricTables.forEach(function (table) {
      var rows = getDataRows(table);
      rows.forEach(function (row) {
        var text = cellText(row);
        var em = text.match(/\((\d[\d,]*)X\)/);
        if (em) {
          var mult = parseInt(em[1].replace(/,/g, ''), 10);
          if (!isNaN(mult) && mult >= config.estimationErrorWarning) {
            highlightRow(row, mult >= config.estimationErrorCritical ? SEVERITY.CRITICAL : SEVERITY.WARNING,
              'Estimation error: ' + mult.toLocaleString() + 'x off.\n' +
              'Run ANALYZE TABLE to update statistics.');
          }
        }
      });
    });
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
  // Feature 4 — Export Diagnostic Report
  // --------------------------------------------------------------------------

  function getQueryIdFromUrl() {
    var match = window.location.href.match(/[?&]id=(\d+)/);
    return match ? match[1] : null;
  }

  function getQueryDuration() {
    // Try to extract duration from the page
    var text = document.body.innerText;
    var match = text.match(/Duration[:\s]+([\d.]+\s*(?:ms|s|min|h))/i);
    return match ? match[1] : null;
  }

  function buildExportData() {
    var pageType = getPageType();
    var queryId = getQueryIdFromUrl();
    var duration = getQueryDuration();

    var criticals = issues.filter(function (i) { return i.severity === SEVERITY.CRITICAL; });
    var warnings  = issues.filter(function (i) { return i.severity === SEVERITY.WARNING; });
    var infos     = issues.filter(function (i) { return i.severity === SEVERITY.INFO; });

    return {
      kindling_version: '2.0.0',
      timestamp: new Date().toISOString(),
      page_url: window.location.href,
      page_type: pageType,
      query_id: queryId,
      duration: duration,
      summary: {
        critical: criticals.length,
        warning: warnings.length,
        info: infos.length,
      },
      findings: issues.map(function (issue) {
        return {
          severity: issue.severity,
          category: issue.category,
          message: issue.message,
          recommendation: issue.message, // message already contains recommendation
        };
      }),
    };
  }

  function exportJson() {
    var data = buildExportData();
    var json = JSON.stringify(data, null, 2);
    var queryId = data.query_id || 'page';
    var ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    var filename = 'kindling-report-' + queryId + '-' + ts + '.json';
    downloadFile(json, filename, 'application/json');
  }

  function exportMarkdown() {
    var data = buildExportData();
    var md = '';

    md += '# Kindling Diagnostic Report\n\n';
    md += '- **Version:** ' + data.kindling_version + '\n';
    md += '- **Timestamp:** ' + data.timestamp + '\n';
    md += '- **Page URL:** ' + data.page_url + '\n';
    md += '- **Page Type:** ' + data.page_type + '\n';
    if (data.query_id) md += '- **Query ID:** ' + data.query_id + '\n';
    if (data.duration) md += '- **Duration:** ' + data.duration + '\n';
    md += '\n';

    md += '## Summary\n\n';
    md += '| Severity | Count |\n';
    md += '|----------|-------|\n';
    md += '| Critical | ' + data.summary.critical + ' |\n';
    md += '| Warning  | ' + data.summary.warning + ' |\n';
    md += '| Info     | ' + data.summary.info + ' |\n';
    md += '\n';

    if (data.findings.length === 0) {
      md += 'No issues detected.\n';
    } else {
      var severityOrder = ['critical', 'warning', 'info'];
      severityOrder.forEach(function (sev) {
        var items = data.findings.filter(function (f) { return f.severity === sev; });
        if (items.length === 0) return;

        md += '## ' + sev.charAt(0).toUpperCase() + sev.slice(1) + ' (' + items.length + ')\n\n';
        items.forEach(function (item) {
          md += '- **[' + item.category + ']** ' + item.message + '\n';
        });
        md += '\n';
      });
    }

    var queryId = data.query_id || 'page';
    var ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    var filename = 'kindling-report-' + queryId + '-' + ts + '.md';
    downloadFile(md, filename, 'text/markdown');
  }

  function downloadFile(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
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
          '<div class="kindling-export-bar">' +
            '<button class="kindling-export-btn" data-export="json">Export JSON</button>' +
            '<button class="kindling-export-btn" data-export="md">Export Markdown</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(panel);
      setupPanelToggle(panel);
      setupExportButtons(panel);
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
        var badgeClass = item.severity;
        // PII findings get a distinct purple badge
        if (item.category === 'PII') {
          badgeClass = 'pii';
        }
        body += '<div class="kindling-issue">' +
          '<span class="kindling-badge ' + badgeClass + '">' + escapeHtml(item.category) + '</span> ' +
          escapeHtml(item.message) +
          '</div>';
      });
      body += '</div>';
    });

    // Export buttons
    body += '<div class="kindling-export-bar">' +
      '<button class="kindling-export-btn" data-export="json">Export JSON</button>' +
      '<button class="kindling-export-btn" data-export="md">Export Markdown</button>' +
      '</div>';

    panel.innerHTML =
      '<div id="kindling-panel-header">' +
        '<span id="kindling-panel-title">Kindling ' + badges + '</span>' +
        '<span id="kindling-panel-toggle">&#x25BC;</span>' +
      '</div>' +
      '<div id="kindling-panel-body">' + body + '</div>';

    document.body.appendChild(panel);
    setupPanelToggle(panel);
    setupExportButtons(panel);

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

  function setupExportButtons(panel) {
    panel.querySelectorAll('.kindling-export-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var format = btn.getAttribute('data-export');
        if (format === 'json') {
          exportJson();
        } else if (format === 'md') {
          exportMarkdown();
        }
      });
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
          checkLongFilters();
          checkSmallFiles();
          checkPiiPatterns();
          checkEstimationErrors();
          setupSqlHighlighting();
          checkFailedQueries();
          break;
        }
        case 'sql-list': {
          checkFailedQueries();
          break;
        }
        case 'jobs-list':
        case 'job-detail': {
          checkLongRunningStages();
          break;
        }
        case 'executors': {
          checkExecutorBalance();
          checkMemoryUtilisation();
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
})();
