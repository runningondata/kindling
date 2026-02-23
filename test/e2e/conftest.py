"""Pytest fixtures and helpers for Kindling E2E tests.

Launches a local PySpark session with Spark UI, a headless Chromium browser,
and provides helpers to inject Kindling into any page.
"""

import json
from pathlib import Path
from urllib.request import urlopen

import pytest
from playwright.sync_api import sync_playwright
from pyspark.sql import SparkSession

ROOT = Path(__file__).resolve().parents[2]
EXTENSION_DIR = ROOT / "extension" / "content"
KINDLING_JS = EXTENSION_DIR / "kindling.js"
KINDLING_CSS = EXTENSION_DIR / "kindling.css"

CHROME_STUBS_JS = """
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) {
    window.chrome.runtime = {
        onMessage: {
            addListener: function (fn) { window.__kindlingListener = fn; }
        },
        sendMessage: function () {}
    };
}
if (!window.chrome.storage) {
    window.chrome.storage = {
        sync: {
            get: function (_key, cb) { cb({}); }
        }
    };
}
delete window.__kindlingSetup;
"""


@pytest.fixture(scope="session")
def spark():
    assert KINDLING_JS.exists(), (
        f"Built extension not found at {KINDLING_JS}. Run 'npm run build' first."
    )
    session = (
        SparkSession.builder.master("local[4]")
        .appName("kindling-e2e")
        .config("spark.ui.enabled", "true")
        .config("spark.ui.port", "4040")
        .config("spark.driver.memory", "2g")
        # AQE coalesces shuffle partitions, hiding anti-patterns like skew
        .config("spark.sql.adaptive.enabled", "false")
        .getOrCreate()
    )
    yield session
    session.stop()


@pytest.fixture(scope="session")
def spark_ui_url(spark):
    url = spark.sparkContext.uiWebUrl
    assert url, "Spark UI URL not available"
    return url


@pytest.fixture(scope="session")
def browser():
    pw = sync_playwright().start()
    b = pw.chromium.launch(headless=True)
    yield b
    b.close()
    pw.stop()


@pytest.fixture()
def page(browser):
    p = browser.new_page()
    yield p
    p.close()


def inject_kindling(page):
    """Inject chrome stubs + Kindling CSS + JS into the current page."""
    page.evaluate(CHROME_STUBS_JS)
    page.add_style_tag(path=str(KINDLING_CSS))
    page.add_script_tag(path=str(KINDLING_JS))


def run_analysis(page) -> dict:
    """Trigger Kindling analysis and return the results dict."""
    return page.evaluate(
        """() => new Promise(resolve => {
            window.__kindlingListener(
                { type: 'kindling-analyze' },
                {},
                result => resolve(result)
            );
        })"""
    )


# ---------------------------------------------------------------------------
# REST API helpers
# ---------------------------------------------------------------------------

def _api_get(url: str):
    with urlopen(url, timeout=10) as resp:
        return json.loads(resp.read().decode())


def _app_id(spark_ui_url: str) -> str:
    apps = _api_get(f"{spark_ui_url}/api/v1/applications")
    return apps[0]["id"]


def _latest_job_stages(spark_ui_url: str) -> list:
    """Return completed stages for the most recent job, sorted by task count."""
    aid = _app_id(spark_ui_url)
    jobs = _api_get(f"{spark_ui_url}/api/v1/applications/{aid}/jobs")
    jobs.sort(key=lambda j: j["submissionTime"], reverse=True)
    stage_ids = jobs[0]["stageIds"]

    stages = _api_get(f"{spark_ui_url}/api/v1/applications/{aid}/stages")
    job_stages = [
        s for s in stages
        if s["stageId"] in stage_ids and s["status"] == "COMPLETE"
    ]
    job_stages.sort(key=lambda s: s["numCompleteTasks"], reverse=True)
    return job_stages


def get_busiest_stage_for_latest_job(spark_ui_url: str) -> int:
    """Return the stage with the most tasks from the most recent job."""
    return _latest_job_stages(spark_ui_url)[0]["stageId"]


def get_stage_with_shuffle_read(spark_ui_url: str) -> int:
    """Return a stage from the latest job that has shuffle reads (reduce stage)."""
    aid = _app_id(spark_ui_url)
    for s in _latest_job_stages(spark_ui_url):
        detail = _api_get(
            f"{spark_ui_url}/api/v1/applications/{aid}/stages/{s['stageId']}/0"
        )
        if detail.get("shuffleReadBytes", 0) > 0:
            return s["stageId"]
    # Fallback to busiest
    return _latest_job_stages(spark_ui_url)[0]["stageId"]


def get_stage_with_shuffle_write(spark_ui_url: str) -> int:
    """Return a stage from the latest job that has shuffle writes."""
    aid = _app_id(spark_ui_url)
    for s in _latest_job_stages(spark_ui_url):
        detail = _api_get(
            f"{spark_ui_url}/api/v1/applications/{aid}/stages/{s['stageId']}/0"
        )
        if detail.get("shuffleWriteBytes", 0) > 0:
            return s["stageId"]
    return _latest_job_stages(spark_ui_url)[0]["stageId"]


def get_latest_failed_job_id(spark_ui_url: str):
    """Return the ID of the most recent failed job, or None if no failures."""
    aid = _app_id(spark_ui_url)
    jobs = _api_get(f"{spark_ui_url}/api/v1/applications/{aid}/jobs")
    failed = [j for j in jobs if j.get("status") == "FAILED"]
    if not failed:
        return None
    failed.sort(key=lambda j: j["submissionTime"], reverse=True)
    return failed[0]["jobId"]


def get_latest_sql_id(spark_ui_url: str) -> int:
    """Return the ID of the most recent SQL execution."""
    aid = _app_id(spark_ui_url)
    sqls = _api_get(f"{spark_ui_url}/api/v1/applications/{aid}/sql")
    sqls.sort(key=lambda s: s["submissionTime"], reverse=True)
    return sqls[0]["id"]


def get_latest_job_id(spark_ui_url: str) -> int:
    """Return the ID of the most recent job."""
    aid = _app_id(spark_ui_url)
    jobs = _api_get(f"{spark_ui_url}/api/v1/applications/{aid}/jobs")
    jobs.sort(key=lambda s: s["submissionTime"], reverse=True)
    return jobs[0]["jobId"]


# ---------------------------------------------------------------------------
# Page navigation helpers
# ---------------------------------------------------------------------------

def goto_stage_detail(page, spark_ui_url: str, stage_id: int | None = None):
    """Navigate to a stage detail page and wait for metrics."""
    if stage_id is None:
        stage_id = get_busiest_stage_for_latest_job(spark_ui_url)
    page.goto(f"{spark_ui_url}/stages/stage/?id={stage_id}&attempt=0")
    # DataTables loads rows asynchronously — wait for actual data
    page.wait_for_selector("#summary-metrics-table tbody tr")


def goto_sql_detail(page, spark_ui_url: str):
    """Navigate to the latest SQL execution and expand the physical plan."""
    sql_id = get_latest_sql_id(spark_ui_url)
    page.goto(f"{spark_ui_url}/SQL/execution/?id={sql_id}")
    page.wait_for_selector("#physical-plan-details", state="attached")
    # The plan details section is collapsed by default — expand it
    arrow = page.query_selector("#physical-plan-details-arrow")
    if arrow:
        is_hidden = page.evaluate("""() => {
            const el = document.getElementById('physical-plan-details');
            return el && (el.style.display === 'none' || el.offsetHeight === 0);
        }""")
        if is_hidden:
            arrow.click()
            page.wait_for_selector(
                "#physical-plan-details pre", state="visible"
            )


def goto_job_detail(page, spark_ui_url: str, job_id: int | None = None):
    """Navigate to a job detail page and wait for stage tables."""
    if job_id is None:
        job_id = get_latest_job_id(spark_ui_url)
    page.goto(f"{spark_ui_url}/jobs/job/?id={job_id}")
    # Wait for either completed or failed stage tables
    page.wait_for_selector(
        "#completedStage-table tbody tr, #failedStage-table tbody tr"
    )
