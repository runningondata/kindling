import { DEFAULT_CONFIG, SEVERITY } from './config.js';
import { detectSparkUI, getPageType } from './detection.js';
import { parseSummaryMetrics } from './tables.js';
import { clearHighlights } from './dom.js';
import { checkSkew, checkSpill, checkGCPressure, checkStragglers, checkSmallTasks } from './checkers/stage.js';
import { checkJoinStrategies, checkPredicatePushdown, checkLongFilters, checkSmallFiles, checkPiiPatterns, checkEstimationErrors, checkFailedQueries } from './checkers/sql.js';
import { checkLongRunningStages, addStageBadges } from './checkers/jobs.js';
import { checkExecutorBalance, checkMemoryUtilisation } from './checkers/executors.js';
import { setupSqlHighlighting } from './sql-highlighting.js';
import { buildPanel } from './panel.js';

if (!window.__kindlingSetup) {
  window.__kindlingSetup = true;

  let config = { ...DEFAULT_CONFIG };
  const issues = [];
  const savedOriginals = {};

  function addIssue(severity, category, message, element) {
    issues.push({ severity, category, message, element });
  }

  function runDiagnostics() {
    issues.length = 0;
    clearHighlights(savedOriginals);

    const sparkDetected = detectSparkUI();
    if (!sparkDetected) {
      return {
        sparkDetected: false,
        pageType: 'unknown',
        issues: [],
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
      };
    }

    const pageType = getPageType();

    try {
      switch (pageType) {
        case 'stage-detail': {
          const metrics = parseSummaryMetrics();
          checkSkew(metrics, config, addIssue);
          checkSpill(metrics, config, addIssue);
          checkGCPressure(metrics, config, addIssue);
          checkStragglers(config, addIssue);
          checkSmallTasks(metrics, config, addIssue);
          break;
        }
        case 'stages-list': {
          addStageBadges(config);
          break;
        }
        case 'sql-detail': {
          checkJoinStrategies(savedOriginals, addIssue);
          checkPredicatePushdown(savedOriginals, addIssue);
          checkLongFilters(savedOriginals, config, addIssue);
          checkSmallFiles(savedOriginals, config, addIssue);
          checkPiiPatterns(savedOriginals, addIssue);
          checkEstimationErrors(config, addIssue);
          setupSqlHighlighting(savedOriginals);
          checkFailedQueries(pageType, addIssue);
          break;
        }
        case 'sql-list': {
          checkFailedQueries(pageType, addIssue);
          break;
        }
        case 'jobs-list':
        case 'job-detail': {
          checkLongRunningStages(config, addIssue);
          break;
        }
        case 'executors': {
          checkExecutorBalance(config, addIssue);
          checkMemoryUtilisation(config, addIssue);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.warn('[Kindling] Error during analysis:', err);
    }

    buildPanel(issues);

    const criticalCount = issues.filter(i => i.severity === SEVERITY.CRITICAL).length;
    const warningCount  = issues.filter(i => i.severity === SEVERITY.WARNING).length;
    const infoCount     = issues.filter(i => i.severity === SEVERITY.INFO).length;

    try {
      chrome.runtime.sendMessage({
        type: 'kindling-badge-update',
        criticalCount,
        warningCount,
        infoCount,
      });
    } catch (_) { /* popup / service worker may not be listening */ }

    return {
      sparkDetected: true,
      pageType,
      issues: issues.map(i => ({
        severity: i.severity,
        category: i.category,
        message: i.message,
      })),
      criticalCount,
      warningCount,
      infoCount,
    };
  }

  function clearDiagnostics() {
    issues.length = 0;
    clearHighlights(savedOriginals);
    const panel = document.getElementById('kindling-panel');
    if (panel) panel.remove();

    try {
      chrome.runtime.sendMessage({
        type: 'kindling-badge-update',
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
      });
    } catch (_) { /* ignore */ }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'kindling-analyze') {
      chrome.storage.sync.get('config', result => {
        config = Object.assign({}, DEFAULT_CONFIG, result.config || {});
        const results = runDiagnostics();
        sendResponse(results);
      });
      return true;
    }

    if (message.type === 'kindling-clear') {
      clearDiagnostics();
      sendResponse({ cleared: true });
      return false;
    }

    if (message.type === 'kindling-status') {
      sendResponse({
        sparkDetected: detectSparkUI(),
        pageType: getPageType(),
        issueCount: issues.length,
      });
      return false;
    }
  });
}
