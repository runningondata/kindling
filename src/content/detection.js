export function detectSparkUI() {
  // 1. Check for Spark navigation tabs
  const navLinks = document.querySelectorAll(
    '.nav-item a, .nav a, .navbar-nav a, ul.nav li a'
  );
  const sparkTabs = ['Jobs', 'Stages', 'Storage', 'Environment', 'Executors', 'SQL'];
  let tabMatches = 0;
  navLinks.forEach(link => {
    const text = link.textContent.trim();
    for (let i = 0; i < sparkTabs.length; i++) {
      if (text === sparkTabs[i]) { tabMatches++; break; }
    }
  });
  if (tabMatches >= 3) return true;

  // 2. Check for Spark version header
  const brand = document.querySelector('.navbar-brand, .navbar-header');
  if (brand && /spark/i.test(brand.textContent)) return true;

  // 3. Check for characteristic Spark table IDs
  const sparkTableIds = [
    'activeJob-table', 'completedJob-table', 'failedJob-table',
    'activeStage-table', 'completedStage-table', 'failedStage-table',
    'active-tasks-table', 'summary-metrics-table',
    'active-executors-table', 'summary-execs-table',
    'running-table', 'completed-table', 'failed-table',
  ];
  for (let i = 0; i < sparkTableIds.length; i++) {
    if (document.getElementById(sparkTableIds[i])) return true;
  }

  // 4. Check for the Spark UI footer
  const footer = document.querySelector('.navbar-fixed-bottom, footer');
  if (footer && /spark/i.test(footer.textContent)) return true;

  return false;
}

export function getPageType() {
  const path = window.location.pathname;
  const hash = window.location.hash;

  if (/\/stages\/stage\b/.test(path) || /\/stages\/stage\b/.test(hash)) {
    return 'stage-detail';
  }
  if (/\/stages\/?$/.test(path) || /\/stages\/?$/.test(hash)) {
    return 'stages-list';
  }
  if (/\/SQL\/execution\b/i.test(path) || /\/SQL\/execution\b/i.test(hash) ||
      /\/sqlserver\/execution\b/i.test(path)) {
    return 'sql-detail';
  }
  if (/\/SQL\/?$/i.test(path) || /\/sqlserver\/?$/i.test(path)) {
    return 'sql-list';
  }
  if (/\/jobs\/job\b/.test(path)) {
    return 'job-detail';
  }
  if (/\/jobs\/?$/.test(path)) {
    return 'jobs-list';
  }
  if (/\/executors\/?$/.test(path)) {
    return 'executors';
  }
  if (/\/$/.test(path)) {
    return 'jobs-list';
  }
  return 'unknown';
}
