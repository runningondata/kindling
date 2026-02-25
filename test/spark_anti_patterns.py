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
# MAGIC | 13 | Long Filter Condition | SQL detail |
# MAGIC | 14 | Small Files | SQL detail |
# MAGIC | 15 | PII Column Names | SQL detail |
# MAGIC | 16 | Estimation Error | SQL detail |
# MAGIC | 17 | Memory Utilisation | Executors page |
# MAGIC | 18 | Failed Query | SQL list / SQL detail |
# MAGIC | 19 | Shuffle Write | Stage detail |
# MAGIC | 20 | Python UDF | SQL detail |
# MAGIC | 21 | Column Usage / Wide Schema | SQL detail |
# MAGIC | 22 | Failed Stage | Job detail |
# MAGIC
# MAGIC ### Notes
# MAGIC - Cell 12 (stragglers) sleeps for 120 s — check the active stage detail page while it runs
# MAGIC - Cell 18 (failed query) and Cell 22 (failed stage) intentionally throw errors
# MAGIC - Cell 20 (Python UDF) uses `.collect()` not `.count()` — count() lets Catalyst optimise away the UDF
# MAGIC - Some checks depend on cluster sizing; thresholds may need adjustment on large clusters

# COMMAND ----------

from pyspark.sql import functions as F
from pyspark.sql.types import DoubleType, StructType, StructField, StringType, IntegerType
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
# MAGIC ## Cell 13 — Long Filter Condition
# MAGIC A filter with many OR predicates. Kindling flags filters exceeding 500 characters
# MAGIC or 10 predicates (configurable thresholds).

# COMMAND ----------

long_filter_df = spark.range(1_000_000).withColumn("category", (F.col("id") % 100).cast("int"))
long_filter_df.write.mode("overwrite").parquet(f"{TEMP_PATH}/long_filter_test")

conditions = " OR ".join([f"(category = {i} AND id > {i * 1000})" for i in range(25)])
spark.read.parquet(f"{TEMP_PATH}/long_filter_test").filter(conditions).count()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 14 — Small Files
# MAGIC Write 500 tiny parquet files then read them back. Kindling flags scans where
# MAGIC average file size < 32 MB with 100+ files.

# COMMAND ----------

small_files_df = spark.range(5000).withColumn("key", (F.col("id") % 500).cast("int"))
small_files_df.repartition(500).write.mode("overwrite").parquet(f"{TEMP_PATH}/small_files_test")

spark.read.parquet(f"{TEMP_PATH}/small_files_test").filter("id > 100").count()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 15 — PII Column Names
# MAGIC Uses column names like `email`, `phone`, `ssn` that Kindling flags as potential PII
# MAGIC in the SQL physical plan text.

# COMMAND ----------

schema = StructType([
    StructField("customer_id", IntegerType()),
    StructField("email", StringType()),
    StructField("phone", StringType()),
    StructField("ssn", StringType()),
    StructField("first_name", StringType()),
    StructField("last_name", StringType()),
    StructField("address", StringType()),
])
pii_df = spark.createDataFrame([
    (1, "user@example.com", "555-123-4567", "123-45-6789", "Jane", "Doe", "123 Main St"),
    (2, "other@test.com", "555-987-6543", "987-65-4321", "John", "Smith", "456 Oak Ave"),
], schema)
pii_df.write.mode("overwrite").parquet(f"{TEMP_PATH}/pii_test")

spark.read.parquet(f"{TEMP_PATH}/pii_test").filter("customer_id > 0").count()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 16 — Estimation Error
# MAGIC Deliberately creates stale statistics by writing new data after ANALYZE TABLE.
# MAGIC The physical plan should show a large estimation multiplier (e.g. `(100X)`).
# MAGIC
# MAGIC **Note:** This may not always trigger depending on DBR version and whether
# MAGIC the Spark UI shows estimation error multipliers in the plan text.

# COMMAND ----------

est_df = spark.range(100).withColumn("key", F.lit(1))
est_df.write.mode("overwrite").saveAsTable("kindling_est_test")
spark.sql("ANALYZE TABLE kindling_est_test COMPUTE STATISTICS FOR ALL COLUMNS")

spark.range(1_000_000).withColumn("key", F.lit(1)).write.mode("append").saveAsTable("kindling_est_test")

spark.conf.set("spark.sql.autoBroadcastJoinThreshold", "-1")
spark.table("kindling_est_test").join(
    spark.table("kindling_est_test").withColumnRenamed("id", "id2"), "key"
).count()
spark.conf.set("spark.sql.autoBroadcastJoinThreshold", original_broadcast_threshold)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 17 — Memory Utilisation
# MAGIC Caches a large DataFrame to push executor storage memory usage up.
# MAGIC Check the Executors page for the memory utilisation column.

# COMMAND ----------

mem_df = (
    spark.range(10_000_000)
    .withColumn("payload", F.concat(F.lit("cached_"), F.col("id").cast("string"), F.lit("_" * 100)))
)
mem_df.cache()
mem_df.count()

# Check executors page, then unpersist
print("Check the Executors page now. Run the next cell to unpersist.")

# COMMAND ----------

mem_df.unpersist()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 18 — Failed Query
# MAGIC Intentionally runs a query that will fail. Check the SQL list page for the
# MAGIC failed query row, and the SQL detail page for the error message.

# COMMAND ----------

try:
    spark.sql("SELECT * FROM nonexistent_table_kindling_test").count()
except Exception as e:
    print(f"Expected failure: {e}")
    print("Check the SQL / DataFrame tab for the failed query entry.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 19 — Shuffle Write
# MAGIC Large equi-join with broadcast disabled. Each executor writes significant shuffle
# MAGIC data. Check the stage detail summary metrics for the "Shuffle Write" row —
# MAGIC Kindling flags max shuffle write exceeding `shuffleWriteWarningGib` (default 1 GiB).

# COMMAND ----------

spark.conf.set("spark.sql.autoBroadcastJoinThreshold", "-1")

sw_left = spark.range(10_000_000).withColumn("key", (F.col("id") % 500).cast("int")).withColumn("payload", F.concat(F.lit("L_"), F.col("id").cast("string"), F.lit("_" * 50)))
sw_right = spark.range(10_000_000).withColumn("key", (F.col("id") % 500).cast("int")).withColumn("payload", F.concat(F.lit("R_"), F.col("id").cast("string"), F.lit("_" * 50)))
sw_left.join(sw_right, "key").count()

spark.conf.set("spark.sql.autoBroadcastJoinThreshold", original_broadcast_threshold)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 20 — Python UDF
# MAGIC A regular Python UDF appears as `BatchEvalPython` in the physical plan.
# MAGIC Kindling flags this as a warning because row-by-row JVM↔Python serialisation
# MAGIC is a common performance bottleneck.

# COMMAND ----------

@F.udf(DoubleType())
def slow_multiply(x):
    return x * 2.0 if x is not None else 0.0

udf_df = spark.range(100_000).withColumn("value", F.rand()).withColumn("doubled", slow_multiply(F.col("value")))
udf_df.agg(F.sum("doubled")).collect()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 21 — Column Usage / Wide Schema
# MAGIC Writes a 30-column parquet table then reads all columns back (SELECT *).
# MAGIC Kindling flags scans reading ≥ `wideSchemaColumnThreshold` columns (default 20)
# MAGIC as an info-level finding suggesting explicit column selection.

# COMMAND ----------

wide_df = spark.range(10_000)
for i in range(30):
    wide_df = wide_df.withColumn(f"col_{i}", (F.col("id") + i).cast("string"))
wide_df.write.mode("overwrite").parquet(f"{TEMP_PATH}/wide_schema_test")

spark.read.parquet(f"{TEMP_PATH}/wide_schema_test").select(
    *[F.col(f"col_{i}") for i in range(30)]
).limit(10).collect()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cell 22 — Failed Stage
# MAGIC A UDF that unconditionally raises an error. The job will fail and the failed
# MAGIC stage will appear in the job detail page. Kindling highlights failed stage rows
# MAGIC as critical findings.

# COMMAND ----------

@F.udf(StringType())
def fail_udf(x):
    raise RuntimeError("intentional failure for kindling test")

try:
    spark.range(100).withColumn("boom", fail_udf(F.col("id"))).collect()
except Exception as e:
    print(f"Expected failure: {e}")
    print("Check the Jobs page for the failed job, then click into the job detail.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cleanup

# COMMAND ----------

dbutils.fs.rm(TEMP_PATH, recurse=True)
spark.sql("DROP TABLE IF EXISTS kindling_est_test")
spark.conf.set("spark.sql.shuffle.partitions", original_shuffle_partitions)
spark.conf.set("spark.sql.autoBroadcastJoinThreshold", original_broadcast_threshold)
print("Cleanup complete.")
