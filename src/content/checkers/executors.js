import { SEVERITY } from '../config.js';
import { parseBytes, cellText } from '../parsers.js';
import { highlightRow, highlightCell } from '../dom.js';
import { findColumnIndex, getDataRows } from '../tables.js';

export function checkMemoryUtilisation(config, addIssue) {
  const table = document.getElementById('active-executors-table');
  if (!table) return;

  let memCol = findColumnIndex(table, 'storage memory');
  if (memCol === -1) memCol = findColumnIndex(table, 'memory used');
  if (memCol === -1) return;

  const rows = getDataRows(table);
  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (memCol >= cells.length) return;

    if (cells[0] && cellText(cells[0]).toLowerCase() === 'driver') return;

    const memText = cellText(cells[memCol]);
    const parts = memText.split('/');
    if (parts.length < 2) return;

    const used = parseBytes(parts[0].trim());
    const total = parseBytes(parts[1].trim());
    if (isNaN(used) || isNaN(total) || total === 0) return;

    const utilisation = used / total;
    const executorId = cells[0] ? cellText(cells[0]) : 'unknown';
    const pct = (utilisation * 100).toFixed(1);

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

export function checkExecutorBalance(config, addIssue) {
  const table = document.getElementById('active-executors-table');
  if (!table) return;

  const shuffleReadCol = findColumnIndex(table, 'shuffle read');
  if (shuffleReadCol === -1) return;

  const rows = getDataRows(table);
  const items = [];

  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (shuffleReadCol >= cells.length) return;
    if (cells[0] && cellText(cells[0]).toLowerCase() === 'driver') return;

    const val = parseBytes(cellText(cells[shuffleReadCol]));
    if (!isNaN(val)) items.push({ val, row, cell: cells[shuffleReadCol] });
  });

  if (items.length < 2) return;

  const vals = items.map(i => i.val).filter(v => v > 0);
  if (vals.length < 2) return;

  const minVal = Math.min.apply(null, vals);
  const maxVal = Math.max.apply(null, vals);
  if (minVal === 0) return;

  const ratio = maxVal / minVal;
  if (ratio > config.executorSkewRatio) {
    addIssue(SEVERITY.WARNING, 'Executor Skew',
      'Shuffle read imbalance: ' + ratio.toFixed(1) + 'x spread between min and max executor ' +
      '(threshold: ' + config.executorSkewRatio + 'x).');

    items.forEach(item => {
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
