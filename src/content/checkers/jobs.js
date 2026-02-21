import { SEVERITY } from '../config.js';
import { parseDuration, cellText } from '../parsers.js';
import { highlightRow, highlightCell } from '../dom.js';
import { findColumnIndex, getDataRows, findTable } from '../tables.js';

export function checkLongRunningStages(config, addIssue) {
  const stageTable =
    findTable('activeStage-table') ||
    findTable('completedStage-table') ||
    findTable('failedStage-table');
  if (!stageTable) return;

  const durationCol = findColumnIndex(stageTable, 'duration');
  if (durationCol === -1) return;

  const rows = getDataRows(stageTable);
  const items = [];

  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (durationCol >= cells.length) return;
    const dur = parseDuration(cellText(cells[durationCol]));
    if (!isNaN(dur)) items.push({ dur, row, cell: cells[durationCol] });
  });

  if (items.length < 2) return;

  const total = items.reduce((s, i) => s + i.dur, 0);
  if (total === 0) return;

  items.forEach(item => {
    const frac = item.dur / total;
    if (frac > config.stageTimeDominance) {
      const pct = (frac * 100).toFixed(0);
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

export function addStageBadges(config) {
  const tableIds = [
    'activeStage-table', 'completedStage-table',
    'failedStage-table', 'pendingStage-table',
    'skippedStage-table',
  ];

  tableIds.forEach(tableId => {
    const table = findTable(tableId);
    if (!table) return;

    const durationCol = findColumnIndex(table, 'duration');
    const rows = getDataRows(table);
    if (rows.length === 0 || durationCol < 0) return;

    const durations = [];
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (durationCol < cells.length) {
        const dur = parseDuration(cellText(cells[durationCol]));
        if (!isNaN(dur)) durations.push(dur);
      }
    });

    if (durations.length < 2) return;
    const sorted = durations.slice().sort((a, b) => a - b);
    const medianDur = sorted[Math.floor(sorted.length / 2)];

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (durationCol >= cells.length) return;
      const dur = parseDuration(cellText(cells[durationCol]));
      if (isNaN(dur) || medianDur === 0) return;

      const ratio = dur / medianDur;
      if (ratio > config.stragglerMultiple) {
        const idCell = cells[0];
        if (idCell && !idCell.querySelector('.kindling-stage-badge')) {
          const badge = document.createElement('span');
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
