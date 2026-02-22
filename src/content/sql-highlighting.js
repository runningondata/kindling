import { escapeHtml } from './utils.js';

export const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'IS', 'NULL', 'TRUE', 'FALSE',
  'JOIN', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'EXISTS',
  'DISTINCT', 'CAST', 'COALESCE', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL',
  'CROSS', 'ASC', 'DESC', 'IF', 'OVER', 'PARTITION', 'ROWS', 'RANGE',
  'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW', 'FILTER', 'PROJECT',
  'SCAN', 'SORT', 'AGGREGATE', 'EXCHANGE', 'BROADCAST', 'HASH',
];

const SQL_KEYWORD_SET = {};
SQL_KEYWORDS.forEach(kw => { SQL_KEYWORD_SET[kw] = true; });

export function tokenizeSql(text) {
  const tokens = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    if (/\s/.test(text[i])) {
      const start = i;
      while (i < len && /\s/.test(text[i])) i++;
      tokens.push({ type: 'ws', value: text.substring(start, i) });
      continue;
    }

    if (text[i] === "'") {
      const start = i;
      i++;
      while (i < len && text[i] !== "'") {
        if (text[i] === '\\') i++;
        i++;
      }
      if (i < len) i++;
      tokens.push({ type: 'string', value: text.substring(start, i) });
      continue;
    }

    if (i + 1 < len) {
      const two = text[i] + text[i + 1];
      if (two === '<=' || two === '>=' || two === '!=' || two === '<>') {
        tokens.push({ type: 'operator', value: two });
        i += 2;
        continue;
      }
    }

    if ('=<>+-*/'.indexOf(text[i]) !== -1) {
      tokens.push({ type: 'operator', value: text[i] });
      i++;
      continue;
    }

    // Numbers (only when not preceded by letter/underscore)
    if (/\d/.test(text[i]) && (i === 0 || !/[a-zA-Z_#]/.test(text[i - 1]))) {
      const start = i;
      while (i < len && /[\d.]/.test(text[i])) i++;
      if (i < len && /[eE]/.test(text[i])) {
        i++;
        if (i < len && /[+-]/.test(text[i])) i++;
        while (i < len && /\d/.test(text[i])) i++;
      }
      if (i < len && /[lLdDfF]/.test(text[i])) i++;
      tokens.push({ type: 'number', value: text.substring(start, i) });
      continue;
    }

    // Identifiers and keywords (include # for Spark column refs like col#23)
    if (/[a-zA-Z_]/.test(text[i])) {
      const start = i;
      while (i < len && /[a-zA-Z0-9_#.]/.test(text[i])) i++;
      const word = text.substring(start, i);

      let peek = i;
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

    tokens.push({ type: 'punct', value: text[i] });
    i++;
  }

  return tokens;
}

export function renderSqlHighlighted(text) {
  const tokens = tokenizeSql(text);
  let html = '';
  tokens.forEach(token => {
    const esc = escapeHtml(token.value);
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

const EXPR_PATTERN = /(\+- (?:Filter|Project|Aggregate|SortMergeJoin|BroadcastHashJoin|BroadcastNestedLoopJoin|HashAggregate|Sort|Window|Expand|Generate)\s+)(.*)/;

function findExpressionLines(originalText) {
  const lines = originalText.split('\n');
  const expressionLines = [];
  lines.forEach((line, idx) => {
    const match = line.match(EXPR_PATTERN);
    if (match && match[2] && match[2].length > 20) {
      expressionLines.push({ lineIdx: idx, prefix: match[1], expr: match[2] });
    }
  });
  return expressionLines;
}

function wrapExpressionLines(planPre, expressionLines) {
  const currentLines = planPre.innerHTML.split('\n');
  expressionLines.forEach(entry => {
    if (entry.lineIdx >= currentLines.length) return;
    const lineHtml = currentLines[entry.lineIdx];
    if (lineHtml.indexOf('kindling-sql-expr') === -1) {
      currentLines[entry.lineIdx] =
        '<span class="kindling-sql-expr" data-kindling-sql="' +
        escapeHtml(entry.expr).replace(/"/g, '&quot;') + '">' +
        lineHtml + '</span>';
    }
  });
  planPre.innerHTML = currentLines.join('\n');
}

function attachTooltipHandlers(planPre) {
  planPre.querySelectorAll('.kindling-sql-expr').forEach(span => {
    span.addEventListener('mouseenter', () => {
      const existing = document.querySelector('.kindling-sql-tooltip');
      if (existing) existing.remove();

      const rawExpr = span.getAttribute('data-kindling-sql');
      if (!rawExpr) return;

      const tooltip = document.createElement('div');
      tooltip.className = 'kindling-sql-tooltip';
      tooltip.innerHTML = renderSqlHighlighted(rawExpr);

      document.body.appendChild(tooltip);

      const rect = span.getBoundingClientRect();
      tooltip.style.top = (rect.bottom + window.scrollY + 4) + 'px';
      tooltip.style.left = (rect.left + window.scrollX) + 'px';

      const tooltipRect = tooltip.getBoundingClientRect();
      if (tooltipRect.right > window.innerWidth - 10) {
        tooltip.style.left = (window.innerWidth - tooltipRect.width - 10) + 'px';
      }
    });

    span.addEventListener('mouseleave', () => {
      setTimeout(() => {
        const tooltip = document.querySelector('.kindling-sql-tooltip');
        if (tooltip && !tooltip.matches(':hover')) {
          tooltip.remove();
        }
      }, 200);
    });
  });
}

export function setupSqlHighlighting(savedOriginals) {
  const planContainer = document.getElementById('physical-plan-details');
  const planPre = planContainer ? planContainer.querySelector('pre') : null;
  if (!planPre) return;

  const originalText = savedOriginals['plan-pre']
    ? savedOriginals['plan-pre'].text
    : (planPre.textContent || '');

  const expressionLines = findExpressionLines(originalText);
  if (expressionLines.length === 0) return;

  wrapExpressionLines(planPre, expressionLines);
  attachTooltipHandlers(planPre);
}
