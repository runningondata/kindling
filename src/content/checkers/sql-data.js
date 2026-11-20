import { SEVERITY } from '../config.js';
import { parseBytes, cellText, formatBytesHuman } from '../parsers.js';

// ---- Small files reading detection (SQL detail page) ----

function findFilesReadMatch(planContainer, allText, planText) {
  let filesReadMatch = /number of files read[:\s]+(\d[\d,]*)/i.exec(allText);

  if (!filesReadMatch) {
    const detailSections = planContainer.querySelectorAll(
      '.node-detail, .metrics, [class*="metric"], table'
    );
    for (const section of detailSections) {
      const text = cellText(section);
      const fm = /number of files(?:\s+read)?[:\s]+(\d[\d,]*)/i.exec(text);
      if (fm) { filesReadMatch = fm; break; }
    }
  }

  if (!filesReadMatch) {
    filesReadMatch =
      /files\s*(?:read|scanned)[:\s]+(\d[\d,]*)/i.exec(planText) ||
      /(?:files|numFiles)[:\s]+(\d[\d,]*)/i.exec(allText);
  }

  return filesReadMatch;
}

function findSizeReadMatch(planContainer, allText, planText) {
  const byteSuffix = '(?:B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)';
  let sizeReadMatch = new RegExp('size of files read[:\\s]+([\\d.]+\\s*' + byteSuffix + ')', 'i').exec(allText);

  if (!sizeReadMatch) {
    const detailSections = planContainer.querySelectorAll(
      '.node-detail, .metrics, [class*="metric"], table'
    );
    for (const section of detailSections) {
      const text = cellText(section);
      const sm = new RegExp('size of files(?:\\s+read)?[:\\s]+([\\d.]+\\s*' + byteSuffix + ')', 'i').exec(text);
      if (sm) { sizeReadMatch = sm; break; }
    }
  }

  if (!sizeReadMatch) {
    sizeReadMatch =
      new RegExp('(?:size|bytes)\\s*(?:read|scanned)[:\\s]+([\\d.]+\\s*' + byteSuffix + ')', 'i').exec(planText) ||
      new RegExp('(?:data\\s*size|totalSize)[:\\s]+([\\d.]+\\s*' + byteSuffix + ')', 'i').exec(allText);
  }

  return sizeReadMatch;
}

export function checkSmallFiles(savedOriginals, config, addIssue) {
  const planContainer = document.getElementById('physical-plan-details');
  if (!planContainer) return;

  const planText = savedOriginals['plan-pre']
    ? savedOriginals['plan-pre'].text
    : '';

  const allText = planContainer.textContent || '';

  const filesReadMatch = findFilesReadMatch(planContainer, allText, planText);
  const sizeReadMatch = findSizeReadMatch(planContainer, allText, planText);

  if (!filesReadMatch || !sizeReadMatch) return;

  const numFiles = Number.parseInt(filesReadMatch[1].replaceAll(',', ''), 10);
  const totalSize = parseBytes(sizeReadMatch[1]);

  if (Number.isNaN(numFiles) || Number.isNaN(totalSize) || numFiles === 0) return;
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

// ---- Column usage / wide schema detection (SQL detail page) ----

function countSchemaFields(schemaBody) {
  let depth = 0;
  let fieldCount = 1;
  for (const ch of schemaBody) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if (ch === ',' && depth === 0) fieldCount++;
  }
  return fieldCount;
}

function checkReadSchemas(planText, config, addIssue) {
  const schemaPattern = /ReadSchema:\s*struct<([^>]+)>/g;
  let match;
  while ((match = schemaPattern.exec(planText)) !== null) {
    const fieldCount = countSchemaFields(match[1]);
    if (fieldCount >= config.wideSchemaColumnThreshold) {
      addIssue(SEVERITY.INFO, 'Column Usage',
        'Scan reading ' + fieldCount + ' columns (threshold: ' +
        config.wideSchemaColumnThreshold + '). ' +
        'Wide schemas increase I/O and memory usage. Consider selecting only the columns ' +
        'you need instead of SELECT *.');
    }
  }
}

function checkScanColumns(planText, config, addIssue) {
  const scanColPattern = /(?:FileScan|Scan)\s+\w+[^[]*\[([^\]]+)\]/g;
  let match;
  while ((match = scanColPattern.exec(planText)) !== null) {
    const cols = match[1].split(',');
    if (cols.length >= config.wideSchemaColumnThreshold) {
      if (!planText.includes('ReadSchema:')) {
        addIssue(SEVERITY.INFO, 'Column Usage',
          'Scan outputs ' + cols.length + ' columns. ' +
          'Wide output suggests a possible SELECT *. Consider explicit column selection.');
      }
    }
  }
}

export function checkColumnUsage(savedOriginals, config, addIssue) {
  const planContainer = document.getElementById('physical-plan-details');
  if (!planContainer) return;

  const planText = savedOriginals['plan-pre']
    ? savedOriginals['plan-pre'].text
    : (planContainer.textContent || '');
  if (!planText.trim()) return;

  checkReadSchemas(planText, config, addIssue);
  checkScanColumns(planText, config, addIssue);
}

// ---- Python UDF detection (SQL detail page) ----

const PYTHON_UDF_PATTERNS = [
  { pattern: /\bBatchEvalPython\b/, label: 'Python UDF (BatchEvalPython)', tip: 'Regular Python UDFs serialise data row-by-row between JVM and Python. Consider replacing with Spark built-in functions or Pandas UDFs for better performance.' },
  { pattern: /\bArrowEvalPython\b/, label: 'Pandas UDF (ArrowEvalPython)', tip: 'Pandas UDFs use Arrow for vectorised transfer but still cross the JVM/Python boundary. Consider replacing with native Spark functions if possible.' },
  { pattern: /\bFlatMapGroupsInPandas\b/, label: 'Pandas grouped map UDF', tip: 'groupBy().applyInPandas() requires full group materialisation in Python. Watch for memory pressure on large groups.' },
  { pattern: /\bMapInPandas\b/, label: 'mapInPandas UDF', tip: 'mapInPandas processes batches in Python. Consider native Spark functions for better performance.' },
  { pattern: /\bFlatMapCoGroupsInPandas\b/, label: 'Pandas cogroup UDF', tip: 'CoGrouped Pandas operations materialise both sides in Python. Watch for memory pressure.' },
];

export function checkPythonUDFs(savedOriginals, addIssue) {
  const planContainer = document.getElementById('physical-plan-details');
  if (!planContainer) return;

  const planText = savedOriginals['plan-pre']
    ? savedOriginals['plan-pre'].text
    : (planContainer.textContent || '');
  if (!planText.trim()) return;

  PYTHON_UDF_PATTERNS.forEach(entry => {
    if (entry.pattern.test(planText)) {
      addIssue(SEVERITY.WARNING, 'Python UDF',
        entry.label + ' detected in query plan. ' + entry.tip);
    }
  });
}
