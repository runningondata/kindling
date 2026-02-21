// ============================================================================
// Kindling — Service Worker
// ============================================================================
// Handles badge updates from the content script.
// ============================================================================

chrome.runtime.onMessage.addListener(function (message, sender) {
  if (message.type !== 'kindling-badge-update') return;

  var tabId = sender.tab ? sender.tab.id : undefined;
  if (!tabId) return;

  var total = message.criticalCount + message.warningCount + message.infoCount;

  if (total === 0) {
    chrome.action.setBadgeText({ text: '', tabId: tabId });
    return;
  }

  chrome.action.setBadgeText({ text: String(total), tabId: tabId });

  if (message.criticalCount > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#d32f2f', tabId: tabId });
  } else if (message.warningCount > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#f57c00', tabId: tabId });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: '#757575', tabId: tabId });
  }
});
