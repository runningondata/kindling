import { SEVERITY } from '../config.js';
import { parseBytes, cellText, formatBytesHuman } from '../parsers.js';
import { escapeHtml } from '../utils.js';
import { highlightElement, highlightRow } from '../dom.js';
import { findColumnIndex, getDataRows } from '../tables.js';

// ---- Plan visualization SVG node colouring ----

const PLAN_VIZ_COLORS = {
  critical: { fill: 'rgba(211, 47, 47, 0.25)', stroke: '#d32f2f' },
  warning:  { fill: 'rgba(245, 124, 0, 0.25)', stroke: '#f57c00' },
  info:     { fill: 'rgba(25, 118, 210, 0.18)', stroke: '#1976d2' },
};

const PLAN_VIZ_PATTERNS = [
  { pattern: /CartesianProduct/i, severity: 'critical' },
  { pattern: /BroadcastNestedLoopJoin/i, severity: 'warning' },
  { pattern: /SortMergeJoin/i, severity: 'info' },
  { pattern: /\bExchange\b(?!.*BroadcastExchange)/, severity: 'info' },
];

export function highlightPlanVizNodes() {
  const svg = document.querySelector('#plan-viz-graph svg');
  if (!svg) return;

  svg.querySelectorAll('.node').forEach(node => {
    const label = node.getAttribute('name') || '';
    for (let i = 0; i < PLAN_VIZ_PATTERNS.length; i++) {
      if (!PLAN_VIZ_PATTERNS[i].pattern.test(label)) continue;

      const rect = node.querySelector('rect');
      if (!rect) break;

      const colors = PLAN_VIZ_COLORS[PLAN_VIZ_PATTERNS[i].severity];

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

// ---- Join strategy flags (SQL detail page) ----

export function checkJoinStrategies(savedOriginals, addIssue) {
  const planContainer = document.getElementById('physical-plan-details');
  const planPre = planContainer ? planContainer.querySelector('pre') : null;
  if (!planPre) return;

  const planText = planPre.textContent || '';
  if (!planText.trim()) return;

  if (!savedOriginals['plan-pre']) {
    savedOriginals['plan-pre'] = { element: planPre, text: planText };
  }

  const lines = planText.split('\n');
  let hasIssues = false;
  const highlighted = lines.map(line => {
    const esc = escapeHtml(line);

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

// ---- Missing predicate pushdown (SQL detail page) ----

export function checkPredicatePushdown(savedOriginals, addIssue) {
  const planContainer = document.getElementById('physical-plan-details');
  const planPre = planContainer ? planContainer.querySelector('pre') : null;
  if (!planPre) return;

  const planText = savedOriginals['plan-pre']
    ? savedOriginals['plan-pre'].text
    : (planPre.textContent || '');
  if (!planText.trim()) return;

  const hasFilter = /\bFilter\b/i.test(planText);
  if (!hasFilter) return;

  // V1 scans (FileScan) include PushedFilters in metadata
  const hasEmptyPush = /FileScan\s+\w+.*?PushedFilters:\s*\[\s*\]/gi.test(planText);
  // V2 scans (Scan parquet) omit PushedFilters entirely
  const hasV2Scan = /\+- Scan\s+\w+/i.test(planText) && !/PushedFilters:/i.test(planText);

  if (hasEmptyPush || hasV2Scan) {
    addIssue(SEVERITY.WARNING, 'Predicate Pushdown',
      'Scan with empty PushedFilters while Filter operators exist. ' +
      'Filters may not be pushed to the data source.');
  }
}

// ---- Long filter condition detection ----

export function checkLongFilters(savedOriginals, config, addIssue) {
  const planContainer = document.getElementById('physical-plan-details');
  const planPre = planContainer ? planContainer.querySelector('pre') : null;
  if (!planPre) return;

  const planText = savedOriginals['plan-pre']
    ? savedOriginals['plan-pre'].text
    : (planPre.textContent || '');
  if (!planText.trim()) return;

  const filterPattern = /\+- Filter\s+(.*)/g;
  let match;

  while ((match = filterPattern.exec(planText)) !== null) {
    const condition = match[1];
    if (!condition) continue;

    const charLen = condition.length;

    let predicateCount = 0;
    const predMatch = condition.match(/\b(?:AND|OR)\b/gi);
    if (predMatch) predicateCount = predMatch.length;

    const isLong = charLen > config.longFilterCharThreshold ||
                   predicateCount > config.longFilterPredicateThreshold;
    if (!isLong) continue;

    const severity = (charLen > config.longFilterCharThreshold * 2 ||
                      predicateCount > config.longFilterPredicateThreshold * 2)
      ? SEVERITY.WARNING
      : SEVERITY.INFO;

    addIssue(severity, 'Long Filter',
      'Long filter condition detected (' + predicateCount + ' predicates, ' +
      charLen + ' characters). Very long filter expressions can cause code generation ' +
      'issues and slow evaluation. Consider simplifying or breaking into stages.');
  }
}

// ---- Failed query error handling ----

function describeFailedRow(row, table) {
  const cells = row.querySelectorAll('td');
  if (cells.length === 0) return null;

  const parts = [];

  // Try the first cell as a numeric ID (most SQL tables start with ID column)
  const firstCell = cellText(cells[0]).trim();
  if (/^\d+$/.test(firstCell)) {
    parts.push('ID ' + firstCell);
  }

  // Try the description column, or fall back to the second cell
  const descCol = findColumnIndex(table, 'description');
  const descIdx = descCol !== -1 ? descCol : 1;
  if (descIdx < cells.length) {
    const desc = cellText(cells[descIdx]).trim();
    if (desc && !/\n/.test(desc) && desc.length < 200) {
      const short = desc.length > 80 ? desc.substring(0, 80) + '...' : desc;
      parts.push('"' + short + '"');
    }
  }

  return parts.length > 0 ? parts.join(' — ') : null;
}

function checkFailedQueriesOnList(addIssue) {
  const tables = document.querySelectorAll('table');
  tables.forEach(table => {
    const statusCol = findColumnIndex(table, 'status');
    if (statusCol === -1) return;

    const rows = getDataRows(table);
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (statusCol >= cells.length) return;
      const status = cellText(cells[statusCol]).toLowerCase().trim();
      if (status === 'failed') {
        const label = describeFailedRow(row, table) || 'Unknown query';
        highlightRow(row, SEVERITY.CRITICAL,
          'This query failed. Click to see error details.');
        addIssue(SEVERITY.CRITICAL, 'Failed Query',
          'Failed query ' + label, row);
      }
    });
  });

  // Only match rows that have an explicit "FAILED" status text in a cell
  document.querySelectorAll('td.failed, td.FAILED').forEach(el => {
    const row = el.closest('tr');
    if (row && !row.classList.contains('kindling-highlight-critical')) {
      const table = row.closest('table');
      const label = table ? describeFailedRow(row, table) : null;
      highlightRow(row, SEVERITY.CRITICAL,
        'This query failed. Click to see error details.');
      addIssue(SEVERITY.CRITICAL, 'Failed Query',
        'Failed query ' + (label || 'detected in SQL list'), row);
    }
  });
}

function checkFailedQueriesOnDetail(addIssue) {
  const failedIndicators = document.querySelectorAll(
    '.alert-danger, .alert-error, .error-message, [class*="error"], [class*="fail"]'
  );

  failedIndicators.forEach(el => {
    const errorText = cellText(el);
    if (errorText && errorText.length > 10) {
      const shortError = errorText.length > 200 ? errorText.substring(0, 200) + '...' : errorText;
      const fullTip = errorText.length > 200 ? errorText : null;

      addIssue(SEVERITY.CRITICAL, 'Failed Query',
        'Query failed: ' + shortError, el);
      highlightElement(el, SEVERITY.CRITICAL, fullTip || shortError);
    }
  });

  const headers = document.querySelectorAll('h3, h4, .title, .page-title');
  headers.forEach(h => {
    if (/failed/i.test(cellText(h))) {
      const nextSibling = h.nextElementSibling;
      let errorMsg = '';
      if (nextSibling) {
        errorMsg = cellText(nextSibling);
      }
      if (!errorMsg) {
        const pre = document.querySelector('pre.stacktrace, pre.error, .error pre');
        if (pre) errorMsg = cellText(pre);
      }

      if (errorMsg) {
        const shortError = errorMsg.length > 200 ? errorMsg.substring(0, 200) + '...' : errorMsg;
        addIssue(SEVERITY.CRITICAL, 'Failed Query',
          'Query failed: ' + shortError, h);
      } else {
        addIssue(SEVERITY.CRITICAL, 'Failed Query',
          'This query has failed. Check the Spark UI for error details.', h);
      }
    }
  });
}

export function checkFailedQueries(pageType, addIssue) {
  if (pageType === 'sql-list') checkFailedQueriesOnList(addIssue);
  if (pageType === 'sql-detail') checkFailedQueriesOnDetail(addIssue);
}

// ---- Small files reading detection (SQL detail page) ----

export function checkSmallFiles(savedOriginals, config, addIssue) {
  const planContainer = document.getElementById('physical-plan-details');
  if (!planContainer) return;

  const planText = savedOriginals['plan-pre']
    ? savedOriginals['plan-pre'].text
    : '';

  const allText = planContainer.textContent || '';

  let filesReadMatch = allText.match(/number of files read[:\s]+(\d[\d,]*)/i);
  let sizeReadMatch = allText.match(/size of files read[:\s]+([\d.]+\s*(?:B|KiB|MiB|GiB|TiB|KB|MB|GB|TB))/i);

  if (!filesReadMatch && !sizeReadMatch) {
    const detailSections = planContainer.querySelectorAll(
      '.node-detail, .metrics, [class*="metric"], table'
    );
    detailSections.forEach(section => {
      const text = cellText(section);
      if (!filesReadMatch) {
        const fm = text.match(/number of files(?:\s+read)?[:\s]+(\d[\d,]*)/i);
        if (fm) filesReadMatch = fm;
      }
      if (!sizeReadMatch) {
        const sm = text.match(/size of files(?:\s+read)?[:\s]+([\d.]+\s*(?:B|KiB|MiB|GiB|TiB|KB|MB|GB|TB))/i);
        if (sm) sizeReadMatch = sm;
      }
    });
  }

  if (!filesReadMatch) {
    const fm = planText.match(/files\s*(?:read|scanned)[:\s]+(\d[\d,]*)/i) ||
             allText.match(/(?:files|numFiles)[:\s]+(\d[\d,]*)/i);
    if (fm) filesReadMatch = fm;
  }
  if (!sizeReadMatch) {
    const sm = planText.match(/(?:size|bytes)\s*(?:read|scanned)[:\s]+([\d.]+\s*(?:B|KiB|MiB|GiB|TiB|KB|MB|GB|TB))/i) ||
             allText.match(/(?:data\s*size|totalSize)[:\s]+([\d.]+\s*(?:B|KiB|MiB|GiB|TiB|KB|MB|GB|TB))/i);
    if (sm) sizeReadMatch = sm;
  }

  if (!filesReadMatch || !sizeReadMatch) return;

  const numFiles = parseInt(filesReadMatch[1].replace(/,/g, ''), 10);
  const totalSize = parseBytes(sizeReadMatch[1]);

  if (isNaN(numFiles) || isNaN(totalSize) || numFiles === 0) return;
  if (numFiles < config.smallFileMinCount) return;

  const avgSize = totalSize / numFiles;
  const avgSizeMb = avgSize / 1048576;

  if (avgSizeMb < config.smallFileAvgSizeWarningMb) {
    const severity = avgSizeMb < config.smallFileAvgSizeCriticalMb ? SEVERITY.CRITICAL : SEVERITY.WARNING;
    const avgStr = formatBytesHuman(avgSize);

    addIssue(severity, 'Small Files',
      'Scan reading ' + numFiles.toLocaleString() + ' files averaging ' + avgStr +
      ' per file. Small files cause excessive task overhead. Consider running OPTIMIZE ' +
      'to compact files, or adjusting spark.sql.files.maxPartitionBytes.');
  }
}

// ---- PII pattern detection in plan metadata ----

const PII_COLUMN_PATTERNS = [
  /\bemail\b/i, /\bphone\b/i, /\bssn\b/i, /\bsocial_security\b/i,
  /\bnational_id\b/i, /\bpassport\b/i, /\bcredit_card\b/i, /\bcard_number\b/i,
  /\bcvv\b/i, /\bdate_of_birth\b/i, /\bdob\b/i, /\bfirst_name\b/i,
  /\blast_name\b/i, /\bfull_name\b/i, /\bcustomer_name\b/i, /\buser_name\b/i,
  /\baddress\b/i, /\bpostcode\b/i, /\bzip_code\b/i, /\bip_address\b/i,
  /\bnational_insurance\b/i, /\bni_number\b/i,
];

const PII_LITERAL_PATTERNS = [
  { pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, label: 'email address' },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: 'SSN' },
  { pattern: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, label: 'phone number' },
];

export function checkPiiPatterns(savedOriginals, addIssue) {
  const planContainer = document.getElementById('physical-plan-details');
  if (!planContainer) return;

  const planText = savedOriginals['plan-pre']
    ? savedOriginals['plan-pre'].text
    : (planContainer.textContent || '');
  if (!planText.trim()) return;

  const foundColumns = {};

  PII_COLUMN_PATTERNS.forEach(pattern => {
    const matches = planText.match(new RegExp(pattern.source, 'gi'));
    if (matches) {
      matches.forEach(match => {
        const key = match.toLowerCase();
        if (!foundColumns[key]) {
          foundColumns[key] = match;
        }
      });
    }
  });

  Object.keys(foundColumns).forEach(key => {
    addIssue(SEVERITY.INFO, 'PII',
      'Potential PII column detected: "' + foundColumns[key] + '". ' +
      'Verify that this data is handled in compliance with your data governance policies. ' +
      'Consider column-level masking or access controls in Unity Catalog.');
  });

  PII_LITERAL_PATTERNS.forEach(entry => {
    const matches = planText.match(new RegExp(entry.pattern.source, 'g'));
    if (matches) {
      const seen = {};
      const unique = [];
      matches.forEach(m => {
        if (!seen[m]) {
          seen[m] = true;
          unique.push(m);
        }
      });
      unique.forEach(val => {
        addIssue(SEVERITY.INFO, 'PII',
          'Potential PII literal (' + entry.label + ') found in plan: "' + val + '". ' +
          'Consider whether this value should be visible in query plans/logs.');
      });
    }
  });
}

// ---- Estimation error detection (SQL detail page) ----

export function checkEstimationErrors(config, addIssue) {
  const planContainer = document.getElementById('physical-plan-details');
  if (!planContainer) return;

  const allText = planContainer.textContent || '';

  const errorPattern = /\((\d[\d,]*)X\)/g;
  let match;

  while ((match = errorPattern.exec(allText)) !== null) {
    const multiplier = parseInt(match[1].replace(/,/g, ''), 10);
    if (isNaN(multiplier)) continue;

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

  const metricTables = planContainer.querySelectorAll('table');
  metricTables.forEach(table => {
    const rows = getDataRows(table);
    rows.forEach(row => {
      const text = cellText(row);
      const em = text.match(/\((\d[\d,]*)X\)/);
      if (em) {
        const mult = parseInt(em[1].replace(/,/g, ''), 10);
        if (!isNaN(mult) && mult >= config.estimationErrorWarning) {
          highlightRow(row, mult >= config.estimationErrorCritical ? SEVERITY.CRITICAL : SEVERITY.WARNING,
            'Estimation error: ' + mult.toLocaleString() + 'x off.\n' +
            'Run ANALYZE TABLE to update statistics.');
        }
      }
    });
  });
}
