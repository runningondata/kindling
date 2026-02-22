import { SEVERITY } from './config.js';
import { escapeHtml } from './utils.js';
import { getPageType } from './detection.js';

function getQueryIdFromUrl() {
  const match = window.location.href.match(/[?&]id=(\d+)/);
  return match ? match[1] : null;
}

function getQueryDuration() {
  const text = document.body.innerText;
  const match = text.match(/Duration[:\s]+([\d.]+\s*(?:ms|s|min|h))/i);
  return match ? match[1] : null;
}

export function buildExportData(issues) {
  const pageType = getPageType();
  const queryId = getQueryIdFromUrl();
  const duration = getQueryDuration();

  const criticals = issues.filter(i => i.severity === SEVERITY.CRITICAL);
  const warnings  = issues.filter(i => i.severity === SEVERITY.WARNING);
  const infos     = issues.filter(i => i.severity === SEVERITY.INFO);

  return {
    kindling_version: '2.0.0',
    timestamp: new Date().toISOString(),
    page_url: window.location.href,
    page_type: pageType,
    query_id: queryId,
    duration: duration,
    summary: {
      critical: criticals.length,
      warning: warnings.length,
      info: infos.length,
    },
    findings: issues.map(issue => ({
      severity: issue.severity,
      category: issue.category,
      message: issue.message,
      recommendation: issue.message,
    })),
  };
}

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
}

export function exportJson(issues, btn) {
  const data = buildExportData(issues);
  const json = JSON.stringify(data, null, 2);
  copyToClipboard(json, btn);
}

export function exportMarkdown(issues, btn) {
  const data = buildExportData(issues);
  let md = '';

  md += '# Kindling Diagnostic Report\n\n';
  md += '- **Version:** ' + data.kindling_version + '\n';
  md += '- **Timestamp:** ' + data.timestamp + '\n';
  md += '- **Page URL:** ' + data.page_url + '\n';
  md += '- **Page Type:** ' + data.page_type + '\n';
  if (data.query_id) md += '- **Query ID:** ' + data.query_id + '\n';
  if (data.duration) md += '- **Duration:** ' + data.duration + '\n';
  md += '\n';

  md += '## Summary\n\n';
  md += '| Severity | Count |\n';
  md += '|----------|-------|\n';
  md += '| Critical | ' + data.summary.critical + ' |\n';
  md += '| Warning  | ' + data.summary.warning + ' |\n';
  md += '| Info     | ' + data.summary.info + ' |\n';
  md += '\n';

  if (data.findings.length === 0) {
    md += 'No issues detected.\n';
  } else {
    const severityOrder = ['critical', 'warning', 'info'];
    severityOrder.forEach(sev => {
      const items = data.findings.filter(f => f.severity === sev);
      if (items.length === 0) return;

      md += '## ' + sev.charAt(0).toUpperCase() + sev.slice(1) + ' (' + items.length + ')\n\n';
      items.forEach(item => {
        md += '- **[' + item.category + ']** ' + item.message + '\n';
      });
      md += '\n';
    });
  }

  copyToClipboard(md, btn);
}

export function setupPanelToggle(panel) {
  const header = panel.querySelector('#kindling-panel-header');
  const toggle = panel.querySelector('#kindling-panel-toggle');
  header.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    toggle.innerHTML = panel.classList.contains('collapsed') ? '&#x25B6;' : '&#x25BC;';
  });
}

export function setupExportButtons(panel, issues) {
  panel.querySelectorAll('.kindling-export-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const format = btn.getAttribute('data-export');
      if (format === 'json') {
        exportJson(issues, btn);
      } else if (format === 'md') {
        exportMarkdown(issues, btn);
      }
    });
  });
}

function buildPanelHeader(total, criticals, warnings, infos) {
  if (total === 0) {
    return '<div id="kindling-panel-header">' +
      '<span id="kindling-panel-title">Kindling: No issues</span>' +
      '<span id="kindling-panel-toggle">&#x25B6;</span>' +
      '</div>';
  }

  let badges = '';
  if (criticals.length) badges += '<span class="kindling-count critical">' + criticals.length + '</span>';
  if (warnings.length)  badges += '<span class="kindling-count warning">'  + warnings.length  + '</span>';
  if (infos.length)     badges += '<span class="kindling-count info">'     + infos.length     + '</span>';

  return '<div id="kindling-panel-header">' +
    '<span id="kindling-panel-title">Kindling ' + badges + '</span>' +
    '<span id="kindling-panel-toggle">&#x25BC;</span>' +
    '</div>';
}

function buildPanelBody(issues, criticals, warnings, infos) {
  if (issues.length === 0) {
    return '<div id="kindling-panel-body">' +
      '<div style="padding:8px 0;color:#666;font-size:12px;">' +
        'No performance issues detected on this page.' +
      '</div>' +
      '<div class="kindling-export-bar">' +
        '<button class="kindling-export-btn" data-export="json">Copy JSON</button>' +
        '<button class="kindling-export-btn" data-export="md">Copy Markdown</button>' +
      '</div>' +
      '</div>';
  }

  const groups = [
    { severity: SEVERITY.CRITICAL, label: 'Critical', items: criticals },
    { severity: SEVERITY.WARNING,  label: 'Warnings', items: warnings },
    { severity: SEVERITY.INFO,     label: 'Info',     items: infos },
  ];

  let body = '';
  groups.forEach(g => {
    if (!g.items.length) return;
    body += '<div class="kindling-section">';
    body += '<div class="kindling-section-title ' + g.severity + '">' +
            g.label + ' (' + g.items.length + ')</div>';
    g.items.forEach(item => {
      let badgeClass = item.severity;
      if (item.category === 'PII') badgeClass = 'pii';
      body += '<div class="kindling-issue">' +
        '<span class="kindling-badge ' + badgeClass + '">' + escapeHtml(item.category) + '</span> ' +
        escapeHtml(item.message) +
        '</div>';
    });
    body += '</div>';
  });

  body += '<div class="kindling-export-bar">' +
    '<button class="kindling-export-btn" data-export="json">Copy JSON</button>' +
    '<button class="kindling-export-btn" data-export="md">Copy Markdown</button>' +
    '</div>';

  return '<div id="kindling-panel-body">' + body + '</div>';
}

function attachIssueClickHandlers(panel, flatIssues) {
  const issueEls = panel.querySelectorAll('.kindling-issue');
  issueEls.forEach((el, idx) => {
    const issue = flatIssues[idx];
    if (issue && issue.element) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        issue.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        issue.element.style.transition = 'outline 0.2s';
        issue.element.style.outline = '3px solid #f57c00';
        setTimeout(() => { issue.element.style.outline = ''; }, 2000);
      });
    }
  });
}

export function buildPanel(issues) {
  const existing = document.getElementById('kindling-panel');
  if (existing) existing.remove();

  const criticals = issues.filter(i => i.severity === SEVERITY.CRITICAL);
  const warnings  = issues.filter(i => i.severity === SEVERITY.WARNING);
  const infos     = issues.filter(i => i.severity === SEVERITY.INFO);
  const total     = issues.length;

  const panel = document.createElement('div');
  panel.id = 'kindling-panel';
  if (total === 0) panel.classList.add('collapsed');

  panel.innerHTML =
    buildPanelHeader(total, criticals, warnings, infos) +
    buildPanelBody(issues, criticals, warnings, infos);

  document.body.appendChild(panel);
  setupPanelToggle(panel);
  setupExportButtons(panel, issues);

  if (total > 0) {
    attachIssueClickHandlers(panel, criticals.concat(warnings, infos));
  }
}
