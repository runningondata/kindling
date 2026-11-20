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

function consumeWhitespace(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  return { type: 'ws', value: text.substring(start, i), end: i };
}

function consumeString(text, start) {
  let i = start + 1;
  while (i < text.length && text[i] !== "'") {
    if (text[i] === '\\') i++;
    i++;
  }
  if (i < text.length) i++;
  return { type: 'string', value: text.substring(start, i), end: i };
}

function consumeTwoCharOperator(text, i) {
  if (i + 1 >= text.length) return null;
  const two = text[i] + text[i + 1];
  if (two === '<=' || two === '>=' || two === '!=' || two === '<>') {
    return { type: 'operator', value: two, end: i + 2 };
  }
  return null;
}

function consumeNumber(text, start) {
  let i = start;
  while (i < text.length && /[\d.]/.test(text[i])) i++;
  if (i < text.length && /[eE]/.test(text[i])) {
    i++;
    if (i < text.length && /[+-]/.test(text[i])) i++;
    while (i < text.length && /\d/.test(text[i])) i++;
  }
  if (i < text.length && /[lLdDfF]/.test(text[i])) i++;
  return { type: 'number', value: text.substring(start, i), end: i };
}

function classifyWord(word, text, endPos) {
  let peek = endPos;
  while (peek < text.length && text[peek] === ' ') peek++;
  const isFollowedByParen = peek < text.length && text[peek] === '(';

  if (isFollowedByParen && !SQL_KEYWORD_SET[word.toUpperCase()]) {
    return 'function';
  }
  if (SQL_KEYWORD_SET[word.toUpperCase()]) {
    return 'keyword';
  }
  return 'identifier';
}

function consumeIdentifier(text, start) {
  let i = start;
  while (i < text.length && /[a-zA-Z0-9_#.]/.test(text[i])) i++;
  const word = text.substring(start, i);
  const type = classifyWord(word, text, i);
  return { type, value: word, end: i };
}

export function tokenizeSql(text) {
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      const result = consumeWhitespace(text, i);
      tokens.push({ type: result.type, value: result.value });
      i = result.end;
    } else if (ch === "'") {
      const result = consumeString(text, i);
      tokens.push({ type: result.type, value: result.value });
      i = result.end;
    } else if (consumeTwoCharOperator(text, i)) {
      const result = consumeTwoCharOperator(text, i);
      tokens.push({ type: result.type, value: result.value });
      i = result.end;
    } else if ('=<>+-*/'.includes(ch)) {
      tokens.push({ type: 'operator', value: ch });
      i++;
    } else if (/\d/.test(ch) && (i === 0 || !/[a-zA-Z_#]/.test(text[i - 1]))) {
      const result = consumeNumber(text, i);
      tokens.push({ type: result.type, value: result.value });
      i = result.end;
    } else if (/[a-zA-Z_]/.test(ch)) {
      const result = consumeIdentifier(text, i);
      tokens.push({ type: result.type, value: result.value });
      i = result.end;
    } else {
      tokens.push({ type: 'punct', value: ch });
      i++;
    }
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
    const match = EXPR_PATTERN.exec(line);
    if (match?.[2]?.length > 20) {
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
    if (!lineHtml.includes('kindling-sql-expr')) {
      currentLines[entry.lineIdx] =
        '<span class="kindling-sql-expr" data-kindling-sql="' +
        escapeHtml(entry.expr).replaceAll('"', '&quot;') + '">' +
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

      const rawExpr = span.dataset.kindlingSql;
      if (!rawExpr) return;

      const tooltip = document.createElement('div');
      tooltip.className = 'kindling-sql-tooltip';
      tooltip.innerHTML = renderSqlHighlighted(rawExpr);

      document.body.appendChild(tooltip);

      const rect = span.getBoundingClientRect();
      tooltip.style.top = (rect.bottom + globalThis.scrollY + 4) + 'px';
      tooltip.style.left = (rect.left + globalThis.scrollX) + 'px';

      const tooltipRect = tooltip.getBoundingClientRect();
      if (tooltipRect.right > globalThis.innerWidth - 10) {
        tooltip.style.left = (globalThis.innerWidth - tooltipRect.width - 10) + 'px';
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
