# Databricks notebook source

# MAGIC %md
# MAGIC # Kindling Test Notebook — Spark Anti-Patterns
# MAGIC
# MAGIC Generates workloads that trigger every Kindling diagnostic check.
# MAGIC Run each cell sequentially and verify the corresponding Spark UI page.
# MAGIC
# MAGIC ### Cluster Requirements
# MAGIC - **2+ worker nodes** (executor imbalance needs multiple executors)
# MAGIC - DBR 13.x+
# MAGIC - Default executor memory is fine (4–8 GB)
# MAGIC
# MAGIC ### Cells → Checks → Verify On
# MAGIC | Cell | Check | Verify On |
# MAGIC |------|-------|-----------|
# MAGIC | 2 | Data Skew | Stage detail |
# MAGIC | 3 | Shuffle Spill | Stage detail |
# MAGIC | 4 | GC Pressure | Stage detail |
# MAGIC | 5 | Small Tasks | Stage detail |
# MAGIC | 6 | CartesianProduct | SQL detail |
# MAGIC | 7 | BroadcastNestedLoopJoin | SQL detail |
# MAGIC | 8 | SortMergeJoin + Exchange | SQL detail |
# MAGIC | 9 | Missing Pushdown | SQL detail |
# MAGIC | 10 | Dominant Stage | Jobs page |
# MAGIC | 11 | Executor Imbalance | Executors page |
# MAGIC | 12 | Straggler Tasks | Stage detail (while running) |
# MAGIC
# MAGIC ### Notes
# MAGIC - Cell 12 (stragglers) sleeps for 120 s — check the active stage detail page while it runs
# MAGIC - Some checks depend on cluster sizing; thresholds may need adjustment on large clusters

# COMMAND ----------

from pyspark.sql import functions as F
from pyspark.sql.types import DoubleType
import time

original_shuffle_partitions = spark.conf.get("spark.sql.shuffle.partitions")
original_broadcast_threshold = spark.conf.get("spark.sql.autoBroadcastJoinThreshold")

TEMP_PATH = "/tmp/kindling_test"

print(f"shuffle.partitions = {original_shuffle_partitions}")
print(f"autoBroadcastJoinThreshold = {original_broadcast_threshold}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 2 — Data Skew
# MAGIC 99 % of rows land on key = 0. The stage detail summary metrics will show
# MAGIC max duration ≫ median, triggering the severe skew check (max/median > 3×).

# COMMAND ----------

skewed = (
    spark.range(10_000_000)
    .withColumn("key", F.when(F.rand() < 0.99, F.lit(0)).otherwise(F.monotonically_increasing_id() % 100))
    .withColumn("value", F.rand())
)
skewed.groupBy("key").agg(F.sum("value")).count()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 3 — Shuffle Spill
# MAGIC Large payloads shuffled into only 2 partitions. Each partition receives ≈ 10 M
# MAGIC rows × 200 B ≈ 2 GB, exceeding the execution-memory budget and forcing spill.

# COMMAND ----------

spark.conf.set("spark.sql.shuffle.partitions", "2")

spill_df = (
    spark.range(20_000_000)
    .withColumn("key", (F.col("id") % 2).cast("int"))
    .withColumn("payload", F.concat(F.lit("x" * 200), F.col("id").cast("string")))
)
spill_df.groupBy("key").agg(F.max("payload")).count()

spark.conf.set("spark.sql.shuffle.partitions", original_shuffle_partitions)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 4 — GC Pressure
# MAGIC `collect_list` accumulates 1 M String objects per group, churning through the
# MAGIC young generation and pushing GC time above the 10 % threshold.

# COMMAND ----------

gc_df = (
    spark.range(5_000_000)
    .withColumn("group", (F.col("id") % 5).cast("int"))
    .withColumn("text", F.concat(F.lit("gctest_"), F.col("id").cast("string"), F.lit("_padding_data")))
)
gc_df.groupBy("group").agg(F.collect_list("text")).count()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 5 — Small Tasks
# MAGIC 2 000 partitions each containing a single row. Median task duration will be
# MAGIC well under 50 ms with ≥ 1 000 tasks, triggering the "too many small tasks" info.

# COMMAND ----------

small_df = spark.range(2000).repartition(2000)
small_df.foreach(lambda _: None)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 6 — CartesianProduct
# MAGIC `crossJoin` produces a CartesianProduct in the physical plan (critical).

# COMMAND ----------

a = spark.range(500).toDF("a_id")
b = spark.range(500).toDF("b_id")
a.crossJoin(b).count()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 7 — BroadcastNestedLoopJoin
# MAGIC Non-equi join condition (`value > threshold`) prevents hash/sort-merge,
# MAGIC falling back to BroadcastNestedLoopJoin (warning).

# COMMAND ----------

left = spark.range(10000).withColumn("value", F.rand())
right = spark.createDataFrame([(0.5,)], ["threshold"])
left.join(right, left.value > right.threshold).count()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 8 — SortMergeJoin + Exchange
# MAGIC Equi-join with broadcast disabled. The physical plan will contain
# MAGIC `SortMergeJoin` and `Exchange` (shuffle) nodes (info).

# COMMAND ----------

spark.conf.set("spark.sql.autoBroadcastJoinThreshold", "-1")

big_left = spark.range(5_000_000).withColumn("key", (F.col("id") % 1000).cast("int"))
big_right = spark.range(5_000_000).withColumn("key", (F.col("id") % 1000).cast("int"))
big_left.join(big_right, "key").count()

spark.conf.set("spark.sql.autoBroadcastJoinThreshold", original_broadcast_threshold)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 9 — Missing Predicate Pushdown
# MAGIC A UDF in the filter is opaque to the optimiser, so `PushedFilters: []` appears
# MAGIC in the FileScan while a `Filter` operator sits above it (warning).

# COMMAND ----------

pushdown_df = spark.range(1_000_000).withColumn("value", F.rand())
pushdown_df.write.mode("overwrite").parquet(f"{TEMP_PATH}/pushdown_test")

add_one = F.udf(lambda x: x + 1, DoubleType())
spark.read.parquet(f"{TEMP_PATH}/pushdown_test").filter(add_one("value") > 0.5).count()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 10 — Dominant Stage
# MAGIC A fast scan stage followed by a heavy shuffle aggregation. The aggregation
# MAGIC stage should consume > 80 % of total job time.

# COMMAND ----------

dominant_df = (
    spark.range(20_000_000)
    .withColumn("key", (F.col("id") % 5).cast("int"))
    .withColumn("payload", F.concat(F.lit("data_"), F.col("id").cast("string"), F.lit("_" * 50)))
)
dominant_df.groupBy("key").agg(
    F.count("*").alias("cnt"),
    F.max("payload").alias("max_payload"),
).count()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 11 — Executor Imbalance
# MAGIC 95 % of shuffle data routes to key = 0 (one partition → one executor).
# MAGIC Repeated 5× to accumulate visible skew in the Executors page shuffle-read column.

# COMMAND ----------

for i in range(5):
    imb = (
        spark.range(5_000_000)
        .withColumn("key", F.when(F.rand() < 0.95, F.lit(0)).otherwise((F.rand() * 100).cast("int")))
        .withColumn("val", F.rand())
    )
    imb.groupBy("key").agg(F.sum("val")).count()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 12 — Straggler Tasks ⚠️ Run Last
# MAGIC Partition 0 sleeps for 120 s while all other partitions finish instantly.
# MAGIC **Navigate to the active stage detail page while this cell is running** to see
# MAGIC the straggler in the active-tasks table.

# COMMAND ----------

def straggler_fn(idx, iterator):
    if idx == 0:
        time.sleep(120)
    return iterator

straggler_rdd = spark.range(100).repartition(10).rdd
straggler_rdd.mapPartitionsWithIndex(straggler_fn).count()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cleanup

# COMMAND ----------

dbutils.fs.rm(TEMP_PATH, recurse=True)
spark.conf.set("spark.sql.shuffle.partitions", original_shuffle_partitions)
spark.conf.set("spark.sql.autoBroadcastJoinThreshold", original_broadcast_threshold)
print("Cleanup complete.")
