import { parseCellValue, cellText } from './parsers.js';

export function findColumnIndex(table, headerText) {
  if (!table) return -1;
  const headers = table.querySelectorAll('thead th');
  const search = headerText.toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if (cellText(headers[i]).toLowerCase().indexOf(search) !== -1) return i;
  }
  return -1;
}

export function getDataRows(table) {
  if (!table) return [];
  const tbody = table.querySelector('tbody');
  if (!tbody) return [];
  return Array.from(tbody.querySelectorAll('tr'));
}

export function findTable(idOrPartial) {
  let table = document.getElementById(idOrPartial);
  if (table && table.tagName === 'TABLE') return table;

  try {
    table = document.querySelector('table#' + CSS.escape(idOrPartial));
    if (table) return table;
  } catch (_) { /* CSS.escape may not exist in very old browsers */ }

  const tables = document.querySelectorAll('table[id]');
  for (let i = 0; i < tables.length; i++) {
    if (tables[i].id.indexOf(idOrPartial) !== -1) return tables[i];
  }
  return null;
}

/**
 * The Summary Metrics table is rendered client-side by stagepage.js as a
 * DataTable with id="summary-metrics-table".
 *
 * Columns: Metric | Min | 25th percentile | Median | 75th percentile | Max
 */
export function parseSummaryMetrics() {
  const table = document.getElementById('summary-metrics-table');
  if (!table) return null;

  const metrics = {};
  const rows = getDataRows(table);

  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 6) return;

    const metricName = cellText(cells[0]);
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
