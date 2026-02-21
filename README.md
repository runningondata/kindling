# Kindling

A Chrome extension that analyses Apache Spark Web UI pages and overlays visual diagnostics highlighting performance problems. Click the extension icon, hit Analyze, and see issues inline — no cluster config changes, no Spark plugins, no server-side dependencies.

Think of it as a client-side performance linter for your Spark jobs.

## What it detects

| # | Check | Page | Severity |
|---|-------|------|----------|
| 1 | **Data skew** — Max duration vs p75/median in Summary Metrics | Stage detail | Critical / Warning |
| 2 | **Shuffle spill** — Non-zero memory or disk spill | Stage detail | Critical / Warning |
| 3 | **GC pressure** — GC time exceeding threshold of task duration | Stage detail | Critical / Warning |
| 4 | **Straggler tasks** — Individual tasks far slower than the median | Stage detail | Warning |
| 5 | **Too many small tasks** — Low median duration + high task count | Stage detail | Info |
| 6 | **Join strategy flags** — CartesianProduct, BroadcastNestedLoopJoin, SortMergeJoin | SQL detail | Critical / Warning / Info |
| 7 | **Missing predicate pushdown** — Empty PushedFilters with Filter operators present | SQL detail | Warning |
| 8 | **Shuffle indicators** — Exchange nodes highlighted in the physical plan | SQL detail | Info |
| 9 | **Dominant stages** — A single stage consuming most of job time | Jobs / Job detail | Warning |
| 10 | **Executor imbalance** — Large spread in shuffle read across executors | Executors | Warning |

## Installation

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `extension/` directory
5. The flame icon appears in your toolbar

## Usage

1. Navigate to any Spark Web UI page (standalone, History Server, or Databricks driver proxy)
2. Click the Kindling icon in the toolbar
3. Click **Analyze**
4. Issues appear both in the popup summary and as inline highlights on the page
5. Hover highlighted cells for details. Click issues in the floating panel to scroll to them.
6. Click **Clear** to remove all overlays

The extension badge shows the issue count coloured by worst severity (red = critical, amber = warning, grey = info).

## Supported environments

Kindling detects the Spark UI by DOM structure, not URL patterns, so it works anywhere the Spark UI is rendered:

- `localhost:4040` (live application)
- `localhost:18080` (History Server)
- Databricks driver proxy pages
- Any host running the Spark Web UI

Compatible with Spark 3.x and 4.x.

## Configuration

Click the **Options** link in the popup (or right-click the extension icon and select Options) to adjust thresholds:

| Setting | Default | Description |
|---------|---------|-------------|
| Skew threshold | 1.5 | Max/p75 duration ratio to flag skew |
| Severe skew threshold | 3.0 | Max/median duration ratio for severe skew |
| Straggler multiple | 5.0 | Task duration vs median to flag as straggler |
| GC pressure threshold | 0.10 | GC time as fraction of task duration (10%) |
| Small task duration | 50 ms | Below this median = small task |
| Small task count min | 1000 | Minimum tasks before flagging |
| Executor skew ratio | 3.0 | Max/min executor shuffle read ratio |
| Stage time dominance | 0.80 | Stage time as fraction of total job time |

Settings are stored in `chrome.storage.sync` and persist across devices.

## Repository structure

```
kindling/
  extension/                 Load this directory as an unpacked Chrome extension
    manifest.json            Chrome extension manifest (Manifest V3)
    background/
      service-worker.js      Badge updates
    content/
      kindling.js            Detection + analysis + overlay logic
      kindling.css           Injected styles for highlights and panel
    popup/
      popup.html             Popup UI
      popup.js               Injection and result display
      popup.css              Popup styling
    options/
      options.html           Threshold configuration page
      options.js             Load/save config
    icons/
      icon-{16,32,48,128}.png
  test/
    spark_anti_patterns.py   Databricks notebook generating anti-patterns for every check
    verify_diagnostics.js    Playwright MCP injection script for automated verification
```

## How it works

1. User clicks the toolbar icon — the popup opens
2. Popup injects `content/kindling.js` + `content/kindling.css` into the active tab via `chrome.scripting`
3. Content script checks the DOM for Spark UI elements (nav tabs, table IDs, navbar brand)
4. If found, it determines the page type and runs the relevant heuristic checkers
5. Checkers parse rendered tables (Summary Metrics, task table, executor table) and plan text
6. Issues are highlighted inline with colour-coded backgrounds and hover tooltips
7. A floating panel summarises all issues, clickable to scroll to each one
8. Results are sent back to the popup and badge is updated

The content script only runs when you click Analyze — it never auto-injects.

## Development

No build tools required. Edit the files directly and reload the extension:

1. Make changes to any file
2. Go to `chrome://extensions/`
3. Click the reload button on the Kindling card
4. Click the icon on a Spark UI page to test
