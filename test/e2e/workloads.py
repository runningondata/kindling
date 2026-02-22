"""PySpark workload generators that trigger each Kindling diagnostic check.

Adapted from test/spark_anti_patterns.py for local PySpark mode.
"""

import tempfile
import os

from pyspark.sql import SparkSession, functions as F
from pyspark.sql.types import DoubleType


def run_skew(spark: SparkSession):
    """99% of rows on key=0 — triggers Skew detection on stage detail."""
    skewed = (
        spark.range(2_000_000)
        .withColumn(
            "key",
            F.when(F.rand() < 0.99, F.lit(0)).otherwise(
                F.monotonically_increasing_id() % 100
            ),
        )
        .withColumn("value", F.rand())
    )
    skewed.groupBy("key").agg(F.sum("value")).count()


def run_spill(spark: SparkSession):
    """Repartition large data into 1 partition then sort — forces spill to disk."""
    orig_partitions = spark.conf.get("spark.sql.shuffle.partitions")
    spark.conf.set("spark.sql.shuffle.partitions", "1")
    try:
        # 20M rows * ~200B per row ≈ 4GB into 1 partition, then sort —
        # exceeds execution memory and forces spill
        spill_df = (
            spark.range(20_000_000)
            .withColumn("key", F.lit(0))
            .withColumn(
                "payload",
                F.concat(F.lit("x" * 200), F.col("id").cast("string")),
            )
        )
        spill_df.repartition(1).sortWithinPartitions("payload").count()
    finally:
        spark.conf.set("spark.sql.shuffle.partitions", orig_partitions)


def run_gc_pressure(spark: SparkSession):
    """collect_list accumulates many objects — triggers GC Pressure on stage detail."""
    gc_df = (
        spark.range(2_000_000)
        .withColumn("group", (F.col("id") % 5).cast("int"))
        .withColumn(
            "text",
            F.concat(
                F.lit("gctest_"), F.col("id").cast("string"), F.lit("_padding_data")
            ),
        )
    )
    gc_df.groupBy("group").agg(F.collect_list("text")).count()


def run_small_tasks(spark: SparkSession):
    """2000 partitions with 1 row each — triggers Small Tasks on stage detail."""
    small_df = spark.range(2000).repartition(2000)
    small_df.foreach(lambda _: None)


def run_cartesian(spark: SparkSession):
    """crossJoin — PySpark 4.x uses BroadcastNestedLoopJoin Cross."""
    a = spark.range(500).toDF("a_id")
    b = spark.range(500).toDF("b_id")
    a.crossJoin(b).count()


def run_broadcast_nested_loop(spark: SparkSession):
    """Non-equi join falling back to BroadcastNestedLoopJoin."""
    left = spark.range(10_000).withColumn("value", F.rand())
    right = spark.createDataFrame([(0.5,)], ["threshold"])
    left.join(right, left.value > right.threshold).count()


def run_sort_merge_join(spark: SparkSession):
    """Equi-join with broadcast disabled — SortMergeJoin + Exchange."""
    original = spark.conf.get("spark.sql.autoBroadcastJoinThreshold")
    spark.conf.set("spark.sql.autoBroadcastJoinThreshold", "-1")
    try:
        big_left = spark.range(1_000_000).withColumn(
            "key", (F.col("id") % 1000).cast("int")
        )
        big_right = spark.range(1_000_000).withColumn(
            "key", (F.col("id") % 1000).cast("int")
        )
        big_left.join(big_right, "key").count()
    finally:
        spark.conf.set("spark.sql.autoBroadcastJoinThreshold", original)


def run_missing_pushdown(spark: SparkSession):
    """UDF filter opaque to optimiser — Missing Pushdown on SQL detail."""
    tmp_dir = tempfile.mkdtemp(prefix="kindling_pushdown_")
    parquet_path = os.path.join(tmp_dir, "pushdown_test")

    pushdown_df = spark.range(500_000).withColumn("value", F.rand())
    pushdown_df.write.mode("overwrite").parquet(parquet_path)

    add_one = F.udf(lambda x: x + 1, DoubleType())
    spark.read.parquet(parquet_path).filter(add_one("value") > 0.5).count()


def run_dominant_stage(spark: SparkSession):
    """Lightweight scan + heavy shuffle agg — Dominant Stage on jobs page."""
    dominant_df = (
        spark.range(10_000_000)
        .withColumn("key", (F.col("id") % 5).cast("int"))
        .withColumn(
            "payload",
            F.concat(F.lit("data_"), F.col("id").cast("string"), F.lit("_" * 100)),
        )
    )
    dominant_df.groupBy("key").agg(
        F.count("*").alias("cnt"),
        F.collect_list("payload").alias("payloads"),
    ).count()
