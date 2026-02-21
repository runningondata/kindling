export function highlightElement(el, severity, tip) {
  if (!el) return;
  el.classList.add('kindling-highlight-' + severity);
  if (tip) {
    el.classList.add('kindling-tooltip');
    el.setAttribute('data-kindling-tip', tip);
  }
}

export function highlightRow(row, severity, tip) {
  highlightElement(row, severity, tip);
}

export function highlightCell(cell, severity, tip) {
  highlightElement(cell, severity, tip);
}

export function clearHighlights(savedOriginals) {
  document.querySelectorAll(
    '.kindling-highlight-critical,' +
    '.kindling-highlight-warning,' +
    '.kindling-highlight-info'
  ).forEach(el => {
    el.classList.remove(
      'kindling-highlight-critical',
      'kindling-highlight-warning',
      'kindling-highlight-info',
      'kindling-tooltip'
    );
    el.removeAttribute('data-kindling-tip');
  });

  document.querySelectorAll('.kindling-stage-badge').forEach(el => {
    el.remove();
  });

  // Reset any coloured plan-viz SVG nodes
  document.querySelectorAll('#plan-viz-graph .node rect[data-kindling-original-fill]').forEach(rect => {
    rect.style.fill = rect.getAttribute('data-kindling-original-fill');
    rect.style.stroke = rect.getAttribute('data-kindling-original-stroke') || '';
    rect.removeAttribute('data-kindling-original-fill');
    rect.removeAttribute('data-kindling-original-stroke');
  });

  // Remove SQL syntax highlighting tooltips
  document.querySelectorAll('.kindling-sql-tooltip').forEach(el => {
    el.remove();
  });

  // Restore any original DOM content we replaced
  for (const key of Object.keys(savedOriginals)) {
    const entry = savedOriginals[key];
    if (entry.element && entry.element.parentNode) {
      entry.element.textContent = entry.text;
    }
    delete savedOriginals[key];
  }
}
