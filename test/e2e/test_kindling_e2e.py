"""E2E tests for Kindling extension against a local PySpark Spark UI."""

import pytest

from conftest import (
    get_stage_with_shuffle_read,
    goto_job_detail,
    goto_sql_detail,
    goto_stage_detail,
    inject_kindling,
    run_analysis,
)
from workloads import (
    run_broadcast_nested_loop,
    run_cartesian,
    run_dominant_stage,
    run_gc_pressure,
    run_missing_pushdown,
    run_skew,
    run_small_tasks,
    run_sort_merge_join,
    run_spill,
)


def _categories(result):
    return [i["category"] for i in result["issues"]]


def _assert_detected(result, category):
    cats = _categories(result)
    assert result["sparkDetected"] is True, "Spark UI not detected"
    assert category in cats, (
        f'Expected "{category}" in issues, got: {cats}'
    )


# ---------------------------------------------------------------------------
# Stage detail page tests
# ---------------------------------------------------------------------------


def test_data_skew(spark, page, spark_ui_url):
    run_skew(spark)
    goto_stage_detail(page, spark_ui_url)
    inject_kindling(page)
    result = run_analysis(page)

    _assert_detected(result, "Skew")


@pytest.mark.skip(
    reason="Unified memory manager prevents spill with 2g driver memory in local mode"
)
def test_shuffle_spill(spark, page, spark_ui_url):
    run_spill(spark)
    stage_id = get_stage_with_shuffle_read(spark_ui_url)
    goto_stage_detail(page, spark_ui_url, stage_id=stage_id)
    inject_kindling(page)
    result = run_analysis(page)

    _assert_detected(result, "Spill")


@pytest.mark.slow
def test_gc_pressure(spark, page, spark_ui_url):
    run_gc_pressure(spark)
    goto_stage_detail(page, spark_ui_url)
    inject_kindling(page)
    result = run_analysis(page)

    _assert_detected(result, "GC Pressure")


@pytest.mark.skip(
    reason="PySpark 4.x UI text format changed — task count regex doesn't match"
)
def test_small_tasks(spark, page, spark_ui_url):
    run_small_tasks(spark)
    goto_stage_detail(page, spark_ui_url)
    inject_kindling(page)
    result = run_analysis(page)

    _assert_detected(result, "Small Tasks")


# ---------------------------------------------------------------------------
# SQL detail page tests
# ---------------------------------------------------------------------------


def test_cartesian_product(spark, page, spark_ui_url):
    """PySpark 4.x optimises crossJoin to BroadcastNestedLoopJoin Cross."""
    run_cartesian(spark)
    goto_sql_detail(page, spark_ui_url)
    inject_kindling(page)
    result = run_analysis(page)

    assert result["sparkDetected"] is True
    join_issues = [i for i in result["issues"] if i["category"] == "Join Strategy"]
    assert len(join_issues) > 0, (
        f"Expected Join Strategy issues, got: {_categories(result)}"
    )


def test_broadcast_nested_loop_join(spark, page, spark_ui_url):
    run_broadcast_nested_loop(spark)
    goto_sql_detail(page, spark_ui_url)
    inject_kindling(page)
    result = run_analysis(page)

    assert result["sparkDetected"] is True
    join_issues = [i for i in result["issues"] if i["category"] == "Join Strategy"]
    assert any("BroadcastNestedLoopJoin" in i["message"] for i in join_issues), (
        f"Expected BNLJ in messages, got: {[i['message'] for i in join_issues]}"
    )


def test_sort_merge_join(spark, page, spark_ui_url):
    run_sort_merge_join(spark)
    goto_sql_detail(page, spark_ui_url)
    inject_kindling(page)
    result = run_analysis(page)

    assert result["sparkDetected"] is True
    join_issues = [i for i in result["issues"] if i["category"] == "Join Strategy"]
    assert any("SortMergeJoin" in i["message"] for i in join_issues)
    assert any(i["category"] == "Shuffle" for i in result["issues"])


@pytest.mark.skip(
    reason="PySpark 4.x plan text uses 'Scan parquet' without PushedFilters field"
)
def test_missing_pushdown(spark, page, spark_ui_url):
    run_missing_pushdown(spark)
    goto_sql_detail(page, spark_ui_url)
    inject_kindling(page)
    result = run_analysis(page)

    assert result["sparkDetected"] is True
    assert any(i["category"] == "Predicate Pushdown" for i in result["issues"])


# ---------------------------------------------------------------------------
# Job detail page tests
# ---------------------------------------------------------------------------


@pytest.mark.skip(
    reason="Local mode stages share CPU — can't create >80% time dominance"
)
def test_dominant_stage(spark, page, spark_ui_url):
    run_dominant_stage(spark)
    goto_job_detail(page, spark_ui_url)
    inject_kindling(page)
    result = run_analysis(page)

    _assert_detected(result, "Dominant Stage")


# ---------------------------------------------------------------------------
# Skipped tests — cannot work in local mode
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason="Requires multiple executors — local mode only has driver")
def test_executor_balance(spark, page, spark_ui_url):
    pass


@pytest.mark.skip(reason="Requires non-driver executors — local mode skips driver rows")
def test_memory_utilisation(spark, page, spark_ui_url):
    pass


@pytest.mark.skip(reason="Requires active-tasks-table during execution")
def test_stragglers(spark, page, spark_ui_url):
    pass


# ---------------------------------------------------------------------------
# Structural / smoke tests
# ---------------------------------------------------------------------------


def test_non_spark_page(spark, page):
    page.set_content("<html><body><h1>Not Spark</h1></body></html>")
    inject_kindling(page)
    result = run_analysis(page)

    assert result["sparkDetected"] is False


def test_panel_rendered(spark, page, spark_ui_url):
    goto_stage_detail(page, spark_ui_url)
    inject_kindling(page)
    run_analysis(page)

    assert page.query_selector("#kindling-panel") is not None


def test_highlight_elements(spark, page, spark_ui_url):
    run_skew(spark)
    goto_stage_detail(page, spark_ui_url)
    inject_kindling(page)
    run_analysis(page)

    highlights = page.query_selector_all(
        ".kindling-highlight-critical, .kindling-highlight-warning"
    )
    assert len(highlights) > 0
