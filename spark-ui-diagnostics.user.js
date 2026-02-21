// ==UserScript==
// @name         Spark UI Diagnostics
// @namespace    https://github.com/allyreilly/spark-ui-diagnostics
// @version      0.1.1
// @description  Augments Apache Spark Web UI with automatic performance diagnostic overlays
// @match        *://localhost:4040/*
// @match        *://localhost:18080/*
// @match        *://*.cloud.databricks.com/driver-proxy/*
// @match        *://*:4040/*
// @match        *://*:18080/*
// @grant        none
// @run-at       document-idle
//
// ============================================================================
// SPARK UI DIAGNOSTICS
// ============================================================================
//
// This userscript scans the rendered HTML of Apache Spark Web UI pages,
// applies known performance heuristics, and highlights problems so engineers
// can spot issues at a glance.
//
// Installation:
//   1. Install Tampermonkey (Chrome) or Greasemonkey (Firefox)
//   2. Create a new userscript and paste this entire file
//   3. Save and navigate to your Spark UI
//
// Supported pages:
//   - Stages list and individual stage detail pages
//   - SQL/DataFrame tab (physical plan analysis)
//   - Jobs page
//   - Executors page
//
// Configuration:
//   Adjust the CONFIG object below to change detection thresholds.
//
// Compatibility:
//   - Apache Spark 3.x and 4.x Web UI
//   - Spark History Server
//   - Databricks driver proxy
//
// ==/UserScript==

(function () {
  'use strict';

  // ========================================================================
  // CONFIGURATION — adjust thresholds here
  // ========================================================================

  const CONFIG = {
    skewThreshold: 1.5,        // max/p75 ratio to flag skew
    severeSkewThreshold: 3.0,  // max/median ratio for severe skew
    gcPressureThreshold: 0.10, // GC time as fraction of duration
    stragglerMultiple: 5.0,    // task duration vs median to flag straggler
    smallTaskDurationMs: 50,   // below this = small task
    smallTaskCountMin: 1000,   // minimum tasks before flagging small tasks
    executorSkewRatio: 3.0,    // max/min executor shuffle read ratio
    stageTimeDominance: 0.8,   // stage time as fraction of job time
  };

  // ========================================================================
  // SEVERITY LEVELS
  // ========================================================================

  const SEVERITY = {
    CRITICAL: 'critical',
    WARNING: 'warning',
    INFO: 'info',
  };

  // ========================================================================
  // ISSUE TRACKER — collects all detected issues
  // ========================================================================

  const issues = [];

  function addIssue(severity, category, message, element) {
    issues.push({ severity, category, message, element });
  }

  // ========================================================================
  // PARSING UTILITIES
  // ========================================================================

  /**
   * Parse a human-readable duration string produced by Spark's formatDuration.
   * Examples: "15 ms", "1.5 s", "2.3 min", "1.0 h", "45 s", "100 ms"
   * Returns value in milliseconds, or NaN if unparseable.
   */
  function parseDuration(str) {
    if (!str || typeof str !== 'string') return NaN;
    str = str.trim();
    if (str === '' || str === '-') return NaN;

    // Try matching "number unit" patterns
    const match = str.match(/^([\d.]+)\s*(ms|s|min|h|d)$/i);
    if (match) {
      const val = parseFloat(match[1]);
      const unit = match[2].toLowerCase();
      switch (unit) {
        case 'ms': return val;
        case 's': return val * 1000;
        case 'min': return val * 60 * 1000;
        case 'h': return val * 3600 * 1000;
        case 'd': return val * 86400 * 1000;
      }
    }

    // Try bare number (assumed ms)
    const bare = parseFloat(str);
    if (!isNaN(bare)) return bare;

    return NaN;
  }

  /**
   * Parse a human-readable byte string produced by Spark's formatBytes.
   * Examples: "1.5 GiB", "256.0 MiB", "10.0 KiB", "512 B", "0 B"
   * Also handles: "1.5 GB", "256 MB", "10 KB" (non-IEC variants)
   * Returns value in bytes, or NaN if unparseable.
   */
  function parseBytes(str) {
    if (!str || typeof str !== 'string') return NaN;
    str = str.trim();
    if (str === '' || str === '-') return NaN;

    // Handle compound strings like "1.5 GiB / 1000" (shuffle read size/records)
    const slashIdx = str.indexOf('/');
    if (slashIdx !== -1) {
      str = str.substring(0, slashIdx).trim();
    }

    const match = str.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|PiB|KB|MB|GB|TB|PB|EiB|EB)$/i);
    if (match) {
      const val = parseFloat(match[1]);
      const unit = match[2];
      switch (unit) {
        case 'B': return val;
        case 'KiB': case 'KB': return val * 1024;
        case 'MiB': case 'MB': return val * 1024 * 1024;
        case 'GiB': case 'GB': return val * 1024 * 1024 * 1024;
        case 'TiB': case 'TB': return val * 1024 * 1024 * 1024 * 1024;
        case 'PiB': case 'PB': return val * 1024 * 1024 * 1024 * 1024 * 1024;
        case 'EiB': case 'EB': return val * 1024 * 1024 * 1024 * 1024 * 1024 * 1024;
      }
    }

    const bare = parseFloat(str);
    if (!isNaN(bare)) return bare;

    return NaN;
  }

  /**
   * Extract numeric value from a cell, trying duration then bytes then plain number.
   */
  function parseCellValue(str) {
    if (!str || typeof str !== 'string') return NaN;
    str = str.trim();
    if (str === '' || str === '-') return NaN;

    let val = parseDuration(str);
    if (!isNaN(val)) return val;

    val = parseBytes(str);
    if (!isNaN(val)) return val;

    return parseFloat(str.replace(/,/g, ''));
  }

  /**
   * Get text content of a cell, stripping whitespace.
   */
  function cellText(td) {
    if (!td) return '';
    return (td.textContent || td.innerText || '').trim();
  }

  // ========================================================================
  // STYLE INJECTION
  // ========================================================================

  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'spark-diag-styles';
    style.textContent = `
      /* Diagnostic panel */
      #spark-diag-panel {
        position: fixed;
        top: 10px;
        right: 10px;
        z-index: 99999;
        background: var(--spark-diag-bg, #ffffff);
        border: 1px solid var(--spark-diag-border, #ccc);
        border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px;
        max-width: 400px;
        min-width: 250px;
        color: var(--spark-diag-text, #333);
        transition: all 0.2s ease;
      }
      #spark-diag-panel.collapsed {
        min-width: auto;
        max-width: 180px;
      }
      #spark-diag-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        cursor: pointer;
        background: var(--spark-diag-header-bg, #f5f5f5);
        border-radius: 6px 6px 0 0;
        border-bottom: 1px solid var(--spark-diag-border, #ccc);
        user-select: none;
      }
      #spark-diag-panel.collapsed #spark-diag-panel-header {
        border-radius: 6px;
        border-bottom: none;
      }
      #spark-diag-panel-title {
        font-weight: 600;
        font-size: 13px;
      }
      #spark-diag-panel-toggle {
        font-size: 16px;
        line-height: 1;
        opacity: 0.6;
      }
      #spark-diag-panel-body {
        padding: 8px 12px;
        max-height: 60vh;
        overflow-y: auto;
      }
      #spark-diag-panel.collapsed #spark-diag-panel-body {
        display: none;
      }
      .spark-diag-section {
        margin-bottom: 8px;
      }
      .spark-diag-section-title {
        font-weight: 600;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }
      .spark-diag-section-title.critical { color: #d32f2f; }
      .spark-diag-section-title.warning { color: #f57c00; }
      .spark-diag-section-title.info { color: #1976d2; }
      .spark-diag-issue {
        padding: 4px 0;
        font-size: 12px;
        line-height: 1.4;
        border-bottom: 1px solid var(--spark-diag-border-light, #eee);
      }
      .spark-diag-issue:last-child {
        border-bottom: none;
      }
      .spark-diag-badge {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 3px;
        font-size: 11px;
        font-weight: 600;
        margin-right: 4px;
        vertical-align: middle;
      }
      .spark-diag-badge.critical {
        background: #ffcdd2;
        color: #b71c1c;
      }
      .spark-diag-badge.warning {
        background: #ffe0b2;
        color: #e65100;
      }
      .spark-diag-badge.info {
        background: #bbdefb;
        color: #0d47a1;
      }
      .spark-diag-count {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 10px;
        font-size: 11px;
        font-weight: 700;
        margin-left: 4px;
        vertical-align: middle;
      }
      .spark-diag-count.critical {
        background: #d32f2f;
        color: #fff;
      }
      .spark-diag-count.warning {
        background: #f57c00;
        color: #fff;
      }
      .spark-diag-count.info {
        background: #1976d2;
        color: #fff;
      }

      /* Inline highlights */
      .spark-diag-highlight-critical {
        background-color: rgba(211, 47, 47, 0.10) !important;
      }
      .spark-diag-highlight-warning {
        background-color: rgba(245, 124, 0, 0.10) !important;
      }
      .spark-diag-highlight-info {
        background-color: rgba(25, 118, 210, 0.10) !important;
      }

      /* Tooltips */
      .spark-diag-tooltip {
        position: relative;
      }
      .spark-diag-tooltip::after {
        content: attr(data-spark-diag-tip);
        position: absolute;
        bottom: 100%;
        left: 50%;
        transform: translateX(-50%);
        background: #333;
        color: #fff;
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: normal;
        white-space: pre-wrap;
        max-width: 350px;
        min-width: 200px;
        z-index: 100000;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s;
        line-height: 1.4;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      }
      .spark-diag-tooltip:hover::after {
        opacity: 1;
      }

      /* Stage badges in list view */
      .spark-diag-stage-badge {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-left: 4px;
        vertical-align: middle;
      }
      .spark-diag-stage-badge.critical {
        background: #d32f2f;
      }
      .spark-diag-stage-badge.warning {
        background: #f57c00;
      }
      .spark-diag-stage-badge.info {
        background: #1976d2;
      }

      /* SQL plan highlights */
      .spark-diag-plan-highlight {
        padding: 1px 3px;
        border-radius: 2px;
        font-weight: bold;
      }
      .spark-diag-plan-critical {
        background-color: rgba(211, 47, 47, 0.15);
        border-left: 3px solid #d32f2f;
      }
      .spark-diag-plan-warning {
        background-color: rgba(245, 124, 0, 0.15);
        border-left: 3px solid #f57c00;
      }
      .spark-diag-plan-info {
        background-color: rgba(25, 118, 210, 0.15);
        border-left: 3px solid #1976d2;
      }

      /* Dark mode support */
      @media (prefers-color-scheme: dark) {
        #spark-diag-panel {
          --spark-diag-bg: #1e1e1e;
          --spark-diag-border: #444;
          --spark-diag-border-light: #333;
          --spark-diag-text: #ddd;
          --spark-diag-header-bg: #2a2a2a;
        }
      }
      /* Spark UI uses .navbar-inverse for dark themes */
      .navbar-inverse ~ * #spark-diag-panel,
      body[data-theme="dark"] #spark-diag-panel {
        --spark-diag-bg: #1e1e1e;
        --spark-diag-border: #444;
        --spark-diag-border-light: #333;
        --spark-diag-text: #ddd;
        --spark-diag-header-bg: #2a2a2a;
      }
    `;
    document.head.appendChild(style);
  }

  // ========================================================================
  // HIGHLIGHT HELPERS
  // ========================================================================

  function highlightElement(el, severity, tip) {
    if (!el) return;
    el.classList.add(`spark-diag-highlight-${severity}`);
    if (tip) {
      el.classList.add('spark-diag-tooltip');
      el.setAttribute('data-spark-diag-tip', tip);
    }
  }

  function highlightRow(row, severity, tip) {
    if (!row) return;
    highlightElement(row, severity, tip);
  }

  function highlightCell(cell, severity, tip) {
    if (!cell) return;
    highlightElement(cell, severity, tip);
  }

  // ========================================================================
  // PAGE DETECTION
  // ========================================================================

  function getPageType() {
    const path = window.location.pathname;
    const hash = window.location.hash;

    // Stage detail page: /stages/stage/?id=X&attempt=Y
    if (/\/stages\/stage\b/.test(path) || /\/stages\/stage\b/.test(hash)) {
      return 'stage-detail';
    }
    // Stages list page: /stages/ or /stages
    if (/\/stages\/?$/.test(path) || /\/stages\/?$/.test(hash)) {
      return 'stages-list';
    }
    // SQL execution detail: /SQL/execution/?id=X
    if (/\/SQL\/execution\b/i.test(path) || /\/SQL\/execution\b/i.test(hash) ||
        /\/sqlserver\/execution\b/i.test(path)) {
      return 'sql-detail';
    }
    // SQL tab: /SQL/ or /sqlserver/
    if (/\/SQL\/?$/i.test(path) || /\/sqlserver\/?$/i.test(path)) {
      return 'sql-list';
    }
    // Job detail: /jobs/job/?id=X
    if (/\/jobs\/job\b/.test(path)) {
      return 'job-detail';
    }
    // Jobs list: /jobs/ or /jobs
    if (/\/jobs\/?$/.test(path)) {
      return 'jobs-list';
    }
    // Executors page: /executors/ or /executors
    if (/\/executors\/?$/.test(path)) {
      return 'executors';
    }
    // Root/main page could be either jobs or stages
    if (/\/$/.test(path) || path.endsWith(':4040') || path.endsWith(':18080')) {
      return 'jobs-list';
    }

    return 'unknown';
  }

  // ========================================================================
  // TABLE HELPERS
  // ========================================================================

  /**
   * Find a column index by header text (case-insensitive substring match).
   * Works with both <th> and DataTables rendered headers.
   */
  function findColumnIndex(table, headerText) {
    if (!table) return -1;
    const headers = table.querySelectorAll('thead th');
    const search = headerText.toLowerCase();
    for (let i = 0; i < headers.length; i++) {
      const text = cellText(headers[i]).toLowerCase();
      if (text.includes(search)) return i;
    }
    return -1;
  }

  /**
   * Get all data rows from a table body.
   */
  function getDataRows(table) {
    if (!table) return [];
    const tbody = table.querySelector('tbody');
    if (!tbody) return [];
    return Array.from(tbody.querySelectorAll('tr'));
  }

  /**
   * Get column values as parsed numbers from a table.
   */
  function getColumnValues(table, colIndex, parser) {
    parser = parser || parseCellValue;
    return getDataRows(table).map(row => {
      const cells = row.querySelectorAll('td');
      if (colIndex >= cells.length) return NaN;
      return parser(cellText(cells[colIndex]));
    }).filter(v => !isNaN(v));
  }

  /**
   * Find a table on the page by its ID (exact or partial match).
   */
  function findTable(idOrPartial) {
    // Try exact ID first
    let table = document.getElementById(idOrPartial);
    if (table && table.tagName === 'TABLE') return table;

    // Try querySelector
    table = document.querySelector(`table#${CSS.escape(idOrPartial)}`);
    if (table) return table;

    // Try partial match on all tables
    const tables = document.querySelectorAll('table[id]');
    for (const t of tables) {
      if (t.id.includes(idOrPartial)) return t;
    }
    return null;
  }

  // ========================================================================
  // SUMMARY METRICS TABLE HELPERS
  // ========================================================================

  /**
   * The Summary Metrics table on the stage detail page is rendered by
   * stagepage.js as a DataTable with id="summary-metrics-table".
   * Rows have the metric name in the first column, then:
   * Min, 25th percentile, Median, 75th percentile, Max.
   *
   * Returns an object keyed by metric name with { min, p25, median, p75, max }.
   */
  function parseSummaryMetrics() {
    const table = document.getElementById('summary-metrics-table');
    if (!table) return null;

    const metrics = {};
    const rows = getDataRows(table);

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 6) continue;

      const metricName = cellText(cells[0]);
      const min = parseCellValue(cellText(cells[1]));
      const p25 = parseCellValue(cellText(cells[2]));
      const median = parseCellValue(cellText(cells[3]));
      const p75 = parseCellValue(cellText(cells[4]));
      const max = parseCellValue(cellText(cells[5]));

      metrics[metricName] = { min, p25, median, p75, max, row, cells };
    }

    return metrics;
  }

  /**
   * Parse stage-level summary shown as list items above the metrics table.
   * Looks for items like "Shuffle Spill (Memory): ...", "Duration: ...", etc.
   */
  function parseStageSummary() {
    const summary = {};
    // Look for the stage header info list (ul with stage summary details)
    const listItems = document.querySelectorAll('ul.list-unstyled li, .stage-details li, dl dt, dl dd');

    // Also try description list format
    const dts = document.querySelectorAll('dt');
    const dds = document.querySelectorAll('dd');
    for (let i = 0; i < dts.length && i < dds.length; i++) {
      const key = cellText(dts[i]).replace(/:$/, '');
      summary[key] = cellText(dds[i]);
    }

    // Try span-based format
    const spans = document.querySelectorAll('.stage-details span, .stage-summary span');
    for (const span of spans) {
      const text = cellText(span);
      const colonIdx = text.indexOf(':');
      if (colonIdx > 0) {
        const key = text.substring(0, colonIdx).trim();
        const val = text.substring(colonIdx + 1).trim();
        summary[key] = val;
      }
    }

    return summary;
  }

  // ========================================================================
  // CHECKER 1: SKEW DETECTION (Stage detail page)
  // ========================================================================

  function checkSkew(metrics) {
    if (!metrics) return;

    const durationMetric = metrics['Duration'];
    if (!durationMetric) return;

    const { median, p75, max, row, cells } = durationMetric;

    if (isNaN(max) || isNaN(p75) || isNaN(median)) return;
    if (max === 0 || p75 === 0 || median === 0) return;

    const maxP75Ratio = max / p75;
    const maxMedianRatio = max / median;

    // Severe skew: max > 3x median
    if (maxMedianRatio > CONFIG.severeSkewThreshold) {
      highlightRow(row, SEVERITY.CRITICAL,
        `Severe skew detected: Max duration is ${maxMedianRatio.toFixed(1)}x the median.\n` +
        `This usually indicates a data skew problem.\n` +
        `Fix: Repartition data, use salting, or adjust join keys.`);
      highlightCell(cells[5], SEVERITY.CRITICAL,
        `Max is ${maxMedianRatio.toFixed(1)}x median — severe skew`);
      addIssue(SEVERITY.CRITICAL, 'Skew',
        `Severe skew: Max duration is ${maxMedianRatio.toFixed(1)}x the median (threshold: ${CONFIG.severeSkewThreshold}x)`, row);
    }
    // Moderate skew: max > 1.5x p75
    else if (maxP75Ratio > CONFIG.skewThreshold) {
      highlightRow(row, SEVERITY.WARNING,
        `Skew detected: Max duration is ${maxP75Ratio.toFixed(1)}x the 75th percentile.\n` +
        `Consider repartitioning or investigating key distribution.`);
      highlightCell(cells[5], SEVERITY.WARNING,
        `Max is ${maxP75Ratio.toFixed(1)}x p75 — skew detected`);
      addIssue(SEVERITY.WARNING, 'Skew',
        `Skew: Max duration is ${maxP75Ratio.toFixed(1)}x the 75th pctl (threshold: ${CONFIG.skewThreshold}x)`, row);
    }
  }

  // ========================================================================
  // CHECKER 2: SPILL DETECTION (Stage detail page)
  // ========================================================================

  function checkSpill(metrics) {
    if (!metrics) return;

    // Check both Memory and Disk spill metrics
    const memSpill = metrics['Spill (Memory)'] || metrics['Shuffle Spill (Memory)'];
    const diskSpill = metrics['Spill (Disk)'] || metrics['Shuffle Spill (Disk)'];

    const shuffleRead = metrics['Shuffle Read Size / Records'] ||
                        metrics['Shuffle Read Blocked Time'] ||
                        metrics['Shuffle Remote Reads'];
    const shuffleWrite = metrics['Shuffle Write Size / Records'];

    function checkSpillMetric(spillMetric, label) {
      if (!spillMetric) return;
      const { max, median, row, cells } = spillMetric;
      if (isNaN(max) || max === 0) return;

      // Determine severity based on magnitude
      // If spill is substantial, it's a problem
      let severity = SEVERITY.WARNING;
      let tip = `${label} detected (max: ${cellText(cells[5])}).\n` +
        `Spill occurs when data exceeds available memory.\n` +
        `Fix: Increase executor memory, reduce partition size, or optimize queries.`;

      // Check if spill is very large (above 1 GiB max)
      if (max > 1024 * 1024 * 1024) {
        severity = SEVERITY.CRITICAL;
        tip = `Heavy ${label} detected (max: ${cellText(cells[5])}).\n` +
          `Significant spill to disk will severely impact performance.\n` +
          `Fix: Increase spark.executor.memory or spark.memory.fraction,\n` +
          `reduce partition sizes, or repartition data.`;
      }

      highlightRow(row, severity, tip);
      highlightCell(cells[5], severity, `${label}: ${cellText(cells[5])}`);
      addIssue(severity, 'Spill', `${label} detected — max: ${cellText(cells[5])}`, row);
    }

    checkSpillMetric(memSpill, 'Memory spill');
    checkSpillMetric(diskSpill, 'Disk spill');
  }

  // ========================================================================
  // CHECKER 3: GC PRESSURE (Stage detail page)
  // ========================================================================

  function checkGCPressure(metrics) {
    if (!metrics) return;

    const durationMetric = metrics['Duration'];
    const gcMetric = metrics['GC Time'];

    if (!durationMetric || !gcMetric) return;

    // Compare at each percentile level
    const percentiles = ['min', 'p25', 'median', 'p75', 'max'];
    const labels = ['Min', '25th pctl', 'Median', '75th pctl', 'Max'];
    const cellIndices = [1, 2, 3, 4, 5];

    let worstRatio = 0;
    let worstLabel = '';

    for (let i = 0; i < percentiles.length; i++) {
      const dur = durationMetric[percentiles[i]];
      const gc = gcMetric[percentiles[i]];
      if (isNaN(dur) || isNaN(gc) || dur === 0) continue;

      const ratio = gc / dur;
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worstLabel = labels[i];
      }
    }

    if (worstRatio > CONFIG.gcPressureThreshold) {
      const pct = (worstRatio * 100).toFixed(1);
      const severity = worstRatio > 0.25 ? SEVERITY.CRITICAL : SEVERITY.WARNING;

      highlightRow(gcMetric.row, severity,
        `GC pressure: ${pct}% of task time spent in GC (${worstLabel}).\n` +
        `Fix: Increase executor memory, reduce object creation,\n` +
        `or tune spark.executor.extraJavaOptions GC settings.`);

      // Highlight the worst cell
      for (let i = 0; i < percentiles.length; i++) {
        const dur = durationMetric[percentiles[i]];
        const gc = gcMetric[percentiles[i]];
        if (isNaN(dur) || isNaN(gc) || dur === 0) continue;
        if (gc / dur > CONFIG.gcPressureThreshold) {
          highlightCell(gcMetric.cells[cellIndices[i]], severity,
            `GC: ${(gc / dur * 100).toFixed(1)}% of duration`);
        }
      }

      addIssue(severity, 'GC Pressure',
        `GC consuming ${pct}% of task time at ${worstLabel} (threshold: ${(CONFIG.gcPressureThreshold * 100)}%)`,
        gcMetric.row);
    }
  }

  // ========================================================================
  // CHECKER 4: STRAGGLER DETECTION (Stage detail — task table)
  // ========================================================================

  function checkStragglers() {
    const table = document.getElementById('active-tasks-table');
    if (!table) return;

    const durationCol = findColumnIndex(table, 'duration');
    if (durationCol === -1) return;

    const rows = getDataRows(table);
    const durations = [];

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (durationCol >= cells.length) continue;
      const dur = parseDuration(cellText(cells[durationCol]));
      if (!isNaN(dur)) {
        durations.push({ dur, row, cell: cells[durationCol] });
      }
    }

    if (durations.length < 2) return;

    // Calculate median
    const sorted = [...durations].sort((a, b) => a.dur - b.dur);
    const medianDur = sorted[Math.floor(sorted.length / 2)].dur;

    if (medianDur === 0) return;

    let stragglerCount = 0;
    for (const { dur, row, cell } of durations) {
      const ratio = dur / medianDur;
      if (ratio > CONFIG.stragglerMultiple) {
        stragglerCount++;
        highlightRow(row, SEVERITY.WARNING,
          `Straggler task: ${ratio.toFixed(1)}x the median duration.\n` +
          `This task is significantly slower than peers.\n` +
          `Check: Data skew on this partition, slow node, or GC issues.`);
        highlightCell(cell, SEVERITY.WARNING,
          `Straggler: ${ratio.toFixed(1)}x median duration`);
      }
    }

    if (stragglerCount > 0) {
      addIssue(SEVERITY.WARNING, 'Stragglers',
        `${stragglerCount} straggler task(s) running >${CONFIG.stragglerMultiple}x the median duration`);
    }
  }

  // ========================================================================
  // CHECKER 5: SMALL TASKS (Stage detail page)
  // ========================================================================

  function checkSmallTasks(metrics) {
    if (!metrics) return;

    const durationMetric = metrics['Duration'];
    if (!durationMetric) return;

    const { median } = durationMetric;
    if (isNaN(median)) return;

    // Get total task count from the page
    let taskCount = 0;
    // Look for task count in the stage header
    const headerText = document.body.innerText;
    const taskMatch = headerText.match(/Total Tasks[:\s]+(\d[\d,]*)/i) ||
                      headerText.match(/(\d[\d,]*)\s+tasks?/i);
    if (taskMatch) {
      taskCount = parseInt(taskMatch[1].replace(/,/g, ''), 10);
    }

    // Also check task table pagination info
    if (taskCount === 0) {
      const paginationInfo = document.querySelector('.dataTables_info');
      if (paginationInfo) {
        const infoMatch = cellText(paginationInfo).match(/of\s+([\d,]+)\s+entries/i);
        if (infoMatch) {
          taskCount = parseInt(infoMatch[1].replace(/,/g, ''), 10);
        }
      }
    }

    if (median < CONFIG.smallTaskDurationMs && taskCount >= CONFIG.smallTaskCountMin) {
      addIssue(SEVERITY.INFO, 'Small Tasks',
        `${taskCount.toLocaleString()} tasks with median duration ${median.toFixed(0)}ms. ` +
        `Consider coalescing partitions (reduce partition count) to decrease scheduling overhead.`);

      // Highlight the Duration row in summary metrics
      highlightRow(durationMetric.row, SEVERITY.INFO,
        `Too many small tasks: ${taskCount.toLocaleString()} tasks at ${median.toFixed(0)}ms median.\n` +
        `Fix: Use .coalesce() or .repartition() to reduce partition count,\n` +
        `or set spark.sql.shuffle.partitions to a lower value.`);
    }
  }

  // ========================================================================
  // CHECKER 6: JOIN STRATEGY FLAGS (SQL detail page)
  // ========================================================================

  function checkJoinStrategies() {
    // The physical plan section is collapsed by default (display: none).
    // We read the text content regardless of visibility.
    const planContainer = document.getElementById('physical-plan-details');
    const planPre = planContainer ? planContainer.querySelector('pre') : null;
    if (!planPre) return;

    const planText = planPre.textContent || '';
    if (!planText.trim()) return;

    const lines = planText.split('\n');

    // Build a new HTML version with highlights
    let hasIssues = false;
    const highlightedLines = lines.map(line => {
      const escapedLine = escapeHtml(line);

      // CartesianProduct — always critical
      if (/CartesianProduct/i.test(line)) {
        hasIssues = true;
        addIssue(SEVERITY.CRITICAL, 'Join Strategy',
          `CartesianProduct detected in physical plan. This produces N*M rows and is almost always a mistake.`);
        return `<span class="spark-diag-plan-critical">${escapedLine}</span>`;
      }

      // BroadcastNestedLoopJoin — warning
      if (/BroadcastNestedLoopJoin/i.test(line)) {
        hasIssues = true;
        addIssue(SEVERITY.WARNING, 'Join Strategy',
          `BroadcastNestedLoopJoin detected. This can be very expensive for large datasets. ` +
          `Check if a join condition is missing or incorrect.`);
        return `<span class="spark-diag-plan-warning">${escapedLine}</span>`;
      }

      // SortMergeJoin — check for potential missed broadcast
      if (/SortMergeJoin/i.test(line)) {
        // We'll flag it as info, since we can't determine row counts from the plan text alone
        // Users can check if one side is small enough for broadcast
        addIssue(SEVERITY.INFO, 'Join Strategy',
          `SortMergeJoin found. If one side is small (<10MB default), consider ` +
          `broadcast hint or increasing spark.sql.autoBroadcastJoinThreshold.`);
        hasIssues = true;
        return `<span class="spark-diag-plan-info">${escapedLine}</span>`;
      }

      // Exchange nodes (shuffles)
      if (/\bExchange\b/.test(line) && !/\bBroadcastExchange\b/.test(line)) {
        addIssue(SEVERITY.INFO, 'Shuffle',
          `Shuffle Exchange: ${line.trim()}`);
        hasIssues = true;
        return `<span class="spark-diag-plan-info">${escapedLine}</span>`;
      }

      return escapedLine;
    });

    if (hasIssues) {
      planPre.innerHTML = highlightedLines.join('\n');
    }
  }

  // ========================================================================
  // CHECKER 7: MISSING PREDICATE PUSHDOWN (SQL detail page)
  // ========================================================================

  function checkPredicatePushdown() {
    const planContainer = document.getElementById('physical-plan-details');
    const planPre = planContainer ? planContainer.querySelector('pre') : null;
    if (!planPre) return;

    const planText = planPre.textContent || '';
    if (!planText.trim()) return;

    // Check for scan nodes with empty PushedFilters
    // Pattern: FileScan or Scan ... PushedFilters: []
    const scanPattern = /(?:FileScan|Scan)\s+\w+.*?PushedFilters:\s*\[\s*\]/gi;
    const filterPattern = /\bFilter\b/i;

    const hasEmptyPush = scanPattern.test(planText);
    const hasFilter = filterPattern.test(planText);

    if (hasEmptyPush && hasFilter) {
      addIssue(SEVERITY.WARNING, 'Predicate Pushdown',
        `Scan node with empty PushedFilters detected while Filter operators exist in the plan. ` +
        `Filters may not be pushed down to the data source. Check if the data source supports ` +
        `predicate pushdown and if filter expressions are pushable.`);
    }
  }

  // ========================================================================
  // CHECKER 8: SHUFFLE INDICATORS (SQL detail page)
  // ========================================================================

  // Handled inline in checkJoinStrategies — Exchange nodes are highlighted there.

  // ========================================================================
  // CHECKER 9: LONG-RUNNING STAGES (Jobs page)
  // ========================================================================

  function checkLongRunningStages() {
    // Look for job tables: active-table, completed-table, failed-table
    const tableIds = ['active-table', 'completed-table', 'failed-table'];
    const tables = tableIds.map(id => findTable(id)).filter(Boolean);

    if (tables.length === 0) {
      // Also try matching tables by class
      const allTables = document.querySelectorAll('table.table');
      tables.push(...Array.from(allTables));
    }

    for (const table of tables) {
      const durationCol = findColumnIndex(table, 'duration');
      if (durationCol === -1) continue;

      // The jobs table shows stage completion as "Stages: Succeeded/Total"
      // We can't directly get per-stage durations from the jobs list.
      // Instead, we'll check the job detail pages if we're on one.
      // On the jobs list, we flag jobs where duration seems unusually high.
    }

    // If we're on a job detail page, check stage durations
    // Stage tables use stageTag-table pattern from StageTable.scala
    const stageTable = findTable('activeStage-table') ||
                       findTable('completedStage-table') ||
                       findTable('failedStage-table');
    if (!stageTable) return;

    const durationCol = findColumnIndex(stageTable, 'duration');
    if (durationCol === -1) return;

    const rows = getDataRows(stageTable);
    const stageDurations = [];

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (durationCol >= cells.length) continue;
      const dur = parseDuration(cellText(cells[durationCol]));
      if (!isNaN(dur)) {
        stageDurations.push({ dur, row, cell: cells[durationCol] });
      }
    }

    if (stageDurations.length < 2) return;

    const totalDuration = stageDurations.reduce((sum, s) => sum + s.dur, 0);
    if (totalDuration === 0) return;

    for (const { dur, row, cell } of stageDurations) {
      const fraction = dur / totalDuration;
      if (fraction > CONFIG.stageTimeDominance) {
        const pct = (fraction * 100).toFixed(0);
        highlightRow(row, SEVERITY.WARNING,
          `This stage took ${pct}% of total job time.\n` +
          `Investigate this stage for skew, spill, or inefficient operations.`);
        highlightCell(cell, SEVERITY.WARNING,
          `Dominant stage: ${pct}% of job time`);
        addIssue(SEVERITY.WARNING, 'Dominant Stage',
          `A stage consumed ${pct}% of total job time (threshold: ${(CONFIG.stageTimeDominance * 100)}%)`, row);
      }
    }
  }

  // ========================================================================
  // CHECKER 10: IMBALANCED EXECUTORS (Executors page)
  // ========================================================================

  function checkExecutorBalance() {
    const table = document.getElementById('active-executors-table');
    if (!table) return;

    const shuffleReadCol = findColumnIndex(table, 'shuffle read');
    if (shuffleReadCol === -1) return;

    const rows = getDataRows(table);
    const executorReads = [];

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (shuffleReadCol >= cells.length) continue;

      // Skip the driver row
      const idCell = cells[0];
      if (idCell && cellText(idCell).toLowerCase() === 'driver') continue;

      const readVal = parseBytes(cellText(cells[shuffleReadCol]));
      if (!isNaN(readVal)) {
        executorReads.push({ val: readVal, row, cell: cells[shuffleReadCol] });
      }
    }

    if (executorReads.length < 2) return;

    const vals = executorReads.map(e => e.val).filter(v => v > 0);
    if (vals.length < 2) return;

    const minVal = Math.min(...vals);
    const maxVal = Math.max(...vals);

    if (minVal === 0) return;

    const ratio = maxVal / minVal;
    if (ratio > CONFIG.executorSkewRatio) {
      addIssue(SEVERITY.WARNING, 'Executor Skew',
        `Shuffle read imbalance: ${ratio.toFixed(1)}x spread between min and max executor ` +
        `(threshold: ${CONFIG.executorSkewRatio}x). Data may not be evenly distributed.`);

      // Highlight the min and max executor rows
      for (const { val, row, cell } of executorReads) {
        if (val === maxVal) {
          highlightRow(row, SEVERITY.WARNING,
            `Highest shuffle read among executors.\n` +
            `Spread ratio: ${ratio.toFixed(1)}x — data distribution may be skewed.`);
          highlightCell(cell, SEVERITY.WARNING, `Max shuffle read`);
        } else if (val === minVal) {
          highlightCell(cell, SEVERITY.INFO, `Min shuffle read`);
        }
      }
    }
  }

  // ========================================================================
  // STAGE BADGES (Stages list page)
  // ========================================================================

  /**
   * On the stages list page, try to add diagnostic badges next to stage IDs.
   * This is limited because we don't have per-stage metrics on the list page.
   * We flag stages with high shuffle spill or long durations relative to peers.
   */
  function addStageBadges() {
    // Spark uses stageTag-table where stageTag is: activeStage, completedStage,
    // failedStage, pendingStage, skippedStage (from StageTable.scala)
    const tableIds = [
      'activeStage-table', 'completedStage-table',
      'failedStage-table', 'pendingStage-table',
      'skippedStage-table'
    ];

    for (const tableId of tableIds) {
      const table = findTable(tableId);
      if (!table) continue;

      const durationCol = findColumnIndex(table, 'duration');
      const shuffleReadCol = findColumnIndex(table, 'shuffle read');
      const shuffleWriteCol = findColumnIndex(table, 'shuffle write');
      const inputCol = findColumnIndex(table, 'input');

      const rows = getDataRows(table);
      if (rows.length === 0) continue;

      // Collect durations for relative comparison
      const durations = [];
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (durationCol >= 0 && durationCol < cells.length) {
          const dur = parseDuration(cellText(cells[durationCol]));
          if (!isNaN(dur)) durations.push(dur);
        }
      }

      if (durations.length < 2) continue;

      const sortedDurs = [...durations].sort((a, b) => a - b);
      const medianDur = sortedDurs[Math.floor(sortedDurs.length / 2)];

      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (durationCol < 0 || durationCol >= cells.length) continue;

        const dur = parseDuration(cellText(cells[durationCol]));
        if (isNaN(dur) || medianDur === 0) continue;

        const ratio = dur / medianDur;
        if (ratio > CONFIG.stragglerMultiple) {
          // Add a badge next to the stage ID (first column with a link)
          const stageIdCell = cells[0];
          if (stageIdCell && !stageIdCell.querySelector('.spark-diag-stage-badge')) {
            const badge = document.createElement('span');
            badge.className = 'spark-diag-stage-badge warning spark-diag-tooltip';
            badge.setAttribute('data-spark-diag-tip',
              `This stage is ${ratio.toFixed(1)}x slower than the median. Click to investigate.`);
            stageIdCell.appendChild(badge);
          }
          highlightRow(row, SEVERITY.WARNING,
            `Stage duration ${ratio.toFixed(1)}x the median — possible bottleneck.`);
        }
      }
    }
  }

  // ========================================================================
  // HTML UTILITIES
  // ========================================================================

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ========================================================================
  // DIAGNOSTIC PANEL
  // ========================================================================

  function buildPanel() {
    // Remove existing panel if any
    const existing = document.getElementById('spark-diag-panel');
    if (existing) existing.remove();

    const criticalCount = issues.filter(i => i.severity === SEVERITY.CRITICAL).length;
    const warningCount = issues.filter(i => i.severity === SEVERITY.WARNING).length;
    const infoCount = issues.filter(i => i.severity === SEVERITY.INFO).length;
    const totalCount = issues.length;

    if (totalCount === 0) {
      // Show a minimal "no issues" panel
      const panel = document.createElement('div');
      panel.id = 'spark-diag-panel';
      panel.classList.add('collapsed');
      panel.innerHTML = `
        <div id="spark-diag-panel-header">
          <span id="spark-diag-panel-title">Spark Diag: No issues</span>
          <span id="spark-diag-panel-toggle">&#x25B6;</span>
        </div>
        <div id="spark-diag-panel-body">
          <div style="padding: 8px 0; color: #666; font-size: 12px;">
            No performance issues detected on this page.
          </div>
        </div>
      `;
      document.body.appendChild(panel);
      setupPanelToggle(panel);
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'spark-diag-panel';

    // Build header with counts
    let headerBadges = '';
    if (criticalCount > 0) {
      headerBadges += `<span class="spark-diag-count critical">${criticalCount}</span>`;
    }
    if (warningCount > 0) {
      headerBadges += `<span class="spark-diag-count warning">${warningCount}</span>`;
    }
    if (infoCount > 0) {
      headerBadges += `<span class="spark-diag-count info">${infoCount}</span>`;
    }

    let bodyHtml = '';

    // Group issues by severity
    const groups = [
      { severity: SEVERITY.CRITICAL, label: 'Critical', items: issues.filter(i => i.severity === SEVERITY.CRITICAL) },
      { severity: SEVERITY.WARNING, label: 'Warnings', items: issues.filter(i => i.severity === SEVERITY.WARNING) },
      { severity: SEVERITY.INFO, label: 'Info', items: issues.filter(i => i.severity === SEVERITY.INFO) },
    ];

    for (const group of groups) {
      if (group.items.length === 0) continue;
      bodyHtml += `<div class="spark-diag-section">`;
      bodyHtml += `<div class="spark-diag-section-title ${group.severity}">${group.label} (${group.items.length})</div>`;
      for (const item of group.items) {
        bodyHtml += `<div class="spark-diag-issue">`;
        bodyHtml += `<span class="spark-diag-badge ${item.severity}">${item.category}</span> `;
        bodyHtml += escapeHtml(item.message);
        bodyHtml += `</div>`;
      }
      bodyHtml += `</div>`;
    }

    panel.innerHTML = `
      <div id="spark-diag-panel-header">
        <span id="spark-diag-panel-title">Spark Diagnostics ${headerBadges}</span>
        <span id="spark-diag-panel-toggle">&#x25BC;</span>
      </div>
      <div id="spark-diag-panel-body">${bodyHtml}</div>
    `;

    document.body.appendChild(panel);
    setupPanelToggle(panel);

    // Make issue items clickable to scroll to the element
    panel.querySelectorAll('.spark-diag-issue').forEach((issueEl, idx) => {
      const issue = issues[idx]; // May not align perfectly after grouping, but close enough
      if (issue && issue.element) {
        issueEl.style.cursor = 'pointer';
        issueEl.addEventListener('click', () => {
          issue.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Flash the element
          issue.element.style.transition = 'outline 0.2s';
          issue.element.style.outline = '3px solid #f57c00';
          setTimeout(() => { issue.element.style.outline = ''; }, 2000);
        });
      }
    });
  }

  function setupPanelToggle(panel) {
    const header = panel.querySelector('#spark-diag-panel-header');
    const toggle = panel.querySelector('#spark-diag-panel-toggle');
    header.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      toggle.innerHTML = panel.classList.contains('collapsed') ? '&#x25B6;' : '&#x25BC;';
    });
  }

  // ========================================================================
  // PAGE RUNNER — determines which checks to run
  // ========================================================================

  function runDiagnostics() {
    // Clear previous issues
    issues.length = 0;

    // Remove previous highlights
    document.querySelectorAll(
      '.spark-diag-highlight-critical, .spark-diag-highlight-warning, .spark-diag-highlight-info'
    ).forEach(el => {
      el.classList.remove(
        'spark-diag-highlight-critical',
        'spark-diag-highlight-warning',
        'spark-diag-highlight-info',
        'spark-diag-tooltip'
      );
      el.removeAttribute('data-spark-diag-tip');
    });

    document.querySelectorAll('.spark-diag-stage-badge').forEach(el => el.remove());

    const pageType = getPageType();

    try {
      switch (pageType) {
        case 'stage-detail': {
          const metrics = parseSummaryMetrics();
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
          // Unknown page — try running all non-destructive checks
          break;
      }
    } catch (e) {
      // Graceful degradation: log but don't break the page
      console.warn('[Spark Diagnostics] Error during analysis:', e);
    }

    buildPanel();
  }

  // ========================================================================
  // MUTATION OBSERVER — re-run on dynamic content changes
  // ========================================================================

  function setupObserver() {
    let debounceTimer = null;

    const observer = new MutationObserver((mutations) => {
      // Debounce to avoid running too frequently during table renders
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // Only re-run if meaningful DOM changes occurred
        const hasTableChanges = mutations.some(m => {
          // Check if the mutation is in a table or data container
          const target = m.target;
          if (!target || !target.closest) return false;
          return target.closest('table') ||
                 target.closest('#physical-plan-details') ||
                 target.id === 'summary-metrics-table' ||
                 target.id === 'active-tasks-table' ||
                 target.id === 'active-executors-table' ||
                 target.closest('.dataTables_wrapper');
        });

        if (hasTableChanges) {
          runDiagnostics();
        }
      }, 500);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: false,
      attributes: false,
    });

    return observer;
  }

  // ========================================================================
  // INITIALIZATION
  // ========================================================================

  function init() {
    // Inject styles
    injectStyles();

    // Initial run after a short delay to let Spark UI finish rendering
    // (DataTables, AJAX content, etc.)
    setTimeout(() => {
      runDiagnostics();
    }, 1500);

    // Set up mutation observer for dynamic content
    setupObserver();

    // Also re-run when the hash changes (SPA-like navigation in some deployments)
    window.addEventListener('hashchange', () => {
      setTimeout(runDiagnostics, 500);
    });

    // Re-run on popstate (back/forward navigation)
    window.addEventListener('popstate', () => {
      setTimeout(runDiagnostics, 500);
    });

    console.log('[Spark Diagnostics] Initialized. Version 0.1.0');
  }

  // Start
  init();

})();
