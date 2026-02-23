import { SEVERITY, ONE_GIB } from '../config.js';
import { parseDuration, cellText } from '../parsers.js';
import { highlightRow, highlightCell } from '../dom.js';
import { findColumnIndex, getDataRows } from '../tables.js';

export function checkSkew(metrics, config, addIssue) {
  if (!metrics) return;
  const d = metrics['Duration'];
  if (!d) return;

  const median = d.median, p75 = d.p75, max = d.max;
  if (isNaN(max) || isNaN(p75) || isNaN(median)) return;
  if (max === 0 || p75 === 0 || median === 0) return;

  const maxP75 = max / p75;
  const maxMed = max / median;

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

export function checkSpill(metrics, config, addIssue) {
  if (!metrics) return;

  const memSpill  = metrics['Spill (Memory)']  || metrics['Shuffle Spill (Memory)'];
  const diskSpill = metrics['Spill (Disk)']    || metrics['Shuffle Spill (Disk)'];

  function check(metric, label) {
    if (!metric) return;
    const max = metric.max;
    if (isNaN(max) || max === 0) return;

    let severity = SEVERITY.WARNING;
    let tip = label + ' detected (max: ' + cellText(metric.cells[5]) + ').\n' +
      'Fix: Increase executor memory, reduce partition size, or optimise queries.';

    if (max > ONE_GIB) {
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

export function checkGCPressure(metrics, config, addIssue) {
  if (!metrics) return;

  const dur = metrics['Duration'];
  const gc  = metrics['GC Time'];
  if (!dur || !gc) return;

  const keys   = ['min', 'p25', 'median', 'p75', 'max'];
  const labels = ['Min', '25th pctl', 'Median', '75th pctl', 'Max'];
  const idx    = [1, 2, 3, 4, 5];

  let worstRatio = 0;
  let worstLabel = '';

  for (let i = 0; i < keys.length; i++) {
    const d = dur[keys[i]], g = gc[keys[i]];
    if (isNaN(d) || isNaN(g) || d === 0) continue;
    const ratio = g / d;
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstLabel = labels[i];
    }
  }

  if (worstRatio > config.gcPressureThreshold) {
    const pct = (worstRatio * 100).toFixed(1);
    const severity = worstRatio > 0.25 ? SEVERITY.CRITICAL : SEVERITY.WARNING;

    highlightRow(gc.row, severity,
      'GC pressure: ' + pct + '% of task time in GC (' + worstLabel + ').\n' +
      'Fix: Increase executor memory or tune GC settings.');

    for (let j = 0; j < keys.length; j++) {
      const d2 = dur[keys[j]], g2 = gc[keys[j]];
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

export function checkStragglers(config, addIssue) {
  const table = document.getElementById('active-tasks-table');
  if (!table) return;

  const durationCol = findColumnIndex(table, 'duration');
  if (durationCol === -1) return;

  const rows = getDataRows(table);
  const durations = [];

  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (durationCol >= cells.length) return;
    const dur = parseDuration(cellText(cells[durationCol]));
    if (!isNaN(dur)) {
      durations.push({ dur, row, cell: cells[durationCol] });
    }
  });

  if (durations.length < 2) return;

  const sorted = durations.slice().sort((a, b) => a.dur - b.dur);
  const medianDur = sorted[Math.floor(sorted.length / 2)].dur;
  if (medianDur === 0) return;

  let count = 0;
  durations.forEach(item => {
    const ratio = item.dur / medianDur;
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

export function checkShuffleWrite(metrics, config, addIssue) {
  if (!metrics) return;

  const sw = metrics['Shuffle Write Size'] || metrics['Shuffle Write'] ||
             metrics['Shuffle Bytes Written'];
  if (!sw) return;

  const max = sw.max;
  if (isNaN(max) || max === 0) return;

  const thresholdBytes = config.shuffleWriteWarningGib * ONE_GIB;
  if (max > thresholdBytes) {
    const maxText = cellText(sw.cells[5]);
    highlightRow(sw.row, SEVERITY.WARNING,
      'Heavy shuffle write (max: ' + maxText + ').\n' +
      'Large shuffles move data across the network and can bottleneck stages.\n' +
      'Fix: Reduce partition count, use broadcast joins, or pre-partition data.');
    highlightCell(sw.cells[5], SEVERITY.WARNING,
      'Shuffle write: ' + maxText);
    addIssue(SEVERITY.WARNING, 'Shuffle Write',
      'Heavy shuffle write detected — max: ' + maxText +
      '. Large shuffles move data across the network and can bottleneck stages. ' +
      'Consider broadcast joins, pre-partitioning, or reducing shuffle partitions.',
      sw.row);
  }
}

export function checkSmallTasks(metrics, config, addIssue) {
  if (!metrics) return;
  const d = metrics['Duration'];
  if (!d || isNaN(d.median)) return;

  let taskCount = 0;
  const bodyText = document.body.innerText || document.body.textContent || '';
  const m = bodyText.match(/Total Tasks[:\s]+(\d[\d,]*)/i) ||
            bodyText.match(/(\d[\d,]*)\s+Completed\s+Tasks/i) ||
            bodyText.match(/(\d[\d,]*)\s+tasks?/i);
  if (m) taskCount = parseInt(m[1].replace(/,/g, ''), 10);

  if (taskCount === 0) {
    const info = document.querySelector('.dataTables_info');
    if (info) {
      const im = cellText(info).match(/of\s+([\d,]+)\s+entries/i);
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
