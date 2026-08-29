# Looker Studio dashboard — build specification

Six pages. Every chart answers a management question; nothing decorative.

---

## 1. Create the data sources

<https://lookerstudio.google.com> → **Create → Data source → Google Sheets** →
your `Department Reports DB` → tick **Use first row as headers**.

Create these seven sources (one per tab). Naming them exactly like this keeps
the rest of the document unambiguous.

| Data source name | Sheet tab | Used by |
|---|---|---|
| `DS_Daily` | `Daily_Summary` | Pages 1, 2 |
| `DS_Weekly` | `Weekly_Summary` | Pages 2, 6 |
| `DS_Monthly` | `Monthly_Summary` | Page 6 |
| `DS_Dept` | `Department_Summary` | Pages 1, 2 |
| `DS_Emp` | `Employee_Summary` | Page 3 |
| `DS_Slow` | `Slow_Tasks` | Page 4 |
| `DS_Repeat` | `Repeated_Tasks` | Page 5 |
| `DS_Tasks` | `Tasks` | Page 3 detail table, Page 2 drill-down |

## 2. Fix the field types (do this before building anything)

Looker guesses types from the first rows and gets dates wrong often enough to
matter. In each data source, click **Edit** and set:

- `Date`, `Week_Start`, `Week_End`, `Month_Start`, `First_Date`, `Last_Date`,
  `First_Report_Date`, `Last_Report_Date` → type **Date (YYYYMMDD)**
- `Completion_Rate`, `Pending_Rate`, `Prev_Completion_Rate`,
  `Last_7d_Completion_Rate`, `Prev_7d_Completion_Rate`, `Variance_Pct`
  → **Number**, aggregation **Average** (never Sum — summing rates is meaningless)
- `Completion_Rate_PP_Change`, `WoW_PP_Change` → **Number**, aggregation **Average**
- All count columns (`Total_Tasks`, `Completed`, …) → **Number**, aggregation **Sum**
- `Department`, `Employee_Name`, `Task_Status`, `Classification` → **Text**

### Calculated fields to add in `DS_Daily`

```
Open Tasks           = Pending + In_Progress + Blocked + Not_Started
Completion Rate %    = SUM(Completed) / NULLIF(SUM(Total_Tasks),0) * 100
```

Use `Completion Rate %` (recomputed from sums) whenever a chart aggregates
several rows. Use the stored `Completion_Rate` only when a single row is shown.
Averaging stored rates across departments of different sizes gives a wrong
number; this is the single most common Looker mistake in this kind of dashboard.

### The `ALL` row — important

Every summary tab contains both per-department rows **and** a
`Department = 'ALL'` roll-up row. So:

- KPI scorecards → filter `Department = ALL`
- Department comparison charts → filter `Department != ALL`

Set this as a **chart-level filter**, not a page filter, or your totals will
double-count.

---

## 3. PAGE 1 — Executive overview

**Data source:** `DS_Daily` (KPIs, trend), `DS_Dept` (comparison)
**Page filter:** Date range control on `Date`, default *Last 28 days*

### KPI row — 8 scorecards, one line, filter `Department = ALL`

| # | Metric | Field | Aggregation |
|---|---|---|---|
| 1 | Total Tasks | `Total_Tasks` | Sum |
| 2 | Completed | `Completed` | Sum |
| 3 | Pending | `Pending` | Sum |
| 4 | In Progress | `In_Progress` | Sum |
| 5 | Completion Rate | `Completion Rate %` (calculated) | — |
| 6 | Slow Tasks | `Slow_Tasks` | Sum |
| 7 | Repeated Tasks | `Repeated_Tasks` | Sum |
| 8 | Departments Reporting | `Department` from `DS_Dept` | Count distinct |

Enable **comparison → previous period** on scorecards 1 and 5. Looker labels the
delta with an arrow; for #5 relabel it "pp" in the title
(`Completion Rate (Δ in percentage points)`) so nobody reads 5 points as 5 %.

### Charts

1. **Daily task volume** — time series. Dim `Date`; metric `Total_Tasks`;
   filter `Department = ALL`.
2. **Completion trend** — time series. Dim `Date`; metric `Completion Rate %`;
   filter `Department = ALL`; reference line at your target (e.g. 80).
3. **Department comparison** — horizontal bar. Dim `Department`;
   metrics `Total_Tasks`, `Completed`; source `DS_Dept`; filter `Department != ALL`;
   sort by `Total_Tasks` desc.
4. **Status distribution** — donut. Source `DS_Tasks`, dim `Task_Status`,
   metric `Record Count`. (Donut here because there are only six mutually
   exclusive slices; use it nowhere else.)
5. **Top slow-task categories** — bar. Source `DS_Slow`; dim `Task_Category`;
   metric `Record Count`; sort desc; limit 10.
6. **Repeated-task trend** — time series. Source `DS_Daily`; dim `Date`;
   metric `Repeated_Tasks`; filter `Department = ALL`.

---

## 4. PAGE 2 — Department performance

**Filters (page level):** Date range on `Date`; drop-downs for `Department`
(from `DS_Daily`), `Task_Status` and `Employee_Name` (from `DS_Tasks`).

| Chart | Type | Source | Dimension | Metric |
|---|---|---|---|---|
| Tasks by department | Column | `DS_Dept` (`Department != ALL`) | `Department` | `Total_Tasks` |
| Completion rate by department | Bar | `DS_Dept` (`Department != ALL`) | `Department` | `Completion Rate %` |
| Weekly trend by department | Time series, one line per dept | `DS_Weekly` (`Department != ALL`) | `Week_Start`, breakdown `Department` | `Total_Tasks` |
| Monthly trend by department | Time series | `DS_Monthly` (`Department != ALL`) | `Month_Start`, breakdown `Department` | `Completion Rate %` |
| Pending & blocked | Stacked column | `DS_Daily` (`Department != ALL`) | `Department` | `Pending`, `Blocked` |
| Slow tasks by department | Bar | `DS_Slow` | `Department` | `Record Count` |
| Week-over-week movement | Table with heatmap | `DS_Dept` | `Department` | `Last_7d_Tasks`, `Prev_7d_Tasks`, `Last_7d_Completion_Rate`, `WoW_PP_Change` |

Rename the last column **"WoW change (percentage points)"**. Conditional
formatting: red below −5, green above +5.

---

## 5. PAGE 3 — Employee performance

Header text box, verbatim:

> These figures show **reported activity**, not productivity or value. Task
> counts do not reflect complexity. Rows marked *Insufficient — do not rank*
> have too little data to compare.

**Filters:** `Employee_Name`, `Department`, date range.

| Chart | Type | Source | Detail |
|---|---|---|---|
| Tasks by employee | Bar | `DS_Emp` | dim `Employee_Name`, metric `Total_Tasks`, sorted desc |
| Completion rate by employee | Bar | `DS_Emp` | metric `Completion Rate %`; **filter `Data_Sufficiency != "Insufficient — do not rank"`** |
| Status mix per employee | Stacked bar | `DS_Emp` | metrics `Completed`, `In_Progress`, `Pending`, `Blocked`, `Not_Started` |
| Weekly trend | Time series | `DS_Weekly` | dim `Week_Start`, metric `Total_Tasks`, breakdown by employee via a `DS_Tasks` equivalent chart if you need per-person weeks |
| Employee detail table | Table | `DS_Emp` | `Employee_Name`, `Department`, `Total_Tasks`, `Completed`, `Completion_Rate`, `Slow_Tasks`, `Repeated_Tasks`, `Distinct_Days_Reported`, `Data_Sufficiency` |
| Recurring patterns | Table | `DS_Repeat` | `Employee_Name`, `Sample_Task`, `Occurrences`, `Classification` |

Keep `Data_Sufficiency` visible on every employee table. It is the honesty
control.

---

## 6. PAGE 4 — Slow tasks

Source `DS_Slow`. Filters: `Department`, `Employee_Name`, `Task_Category`, date.

**Table, sorted by `Variance_Hours` descending:**

`Date` · `Task` · `Employee_Name` · `Department` · `Task_Category` ·
`Expected_Duration` · `Actual_Duration` · `Variance_Hours` · `Variance_Pct` ·
`Duration_Basis` · `Task_Status` · `Link`

Conditional formatting on `Variance_Pct`: amber ≥ 50, red ≥ 100.

**Below it, a scorecard from `DS_Tasks`:**
`Record Count` filtered to `Slow_Task_Flag = "Insufficient Data"`, titled
**"Tasks with no duration data (excluded from this page)"**. Without this number
the page silently implies that everything else was measured. It was not.

Also add a bar: dim `Task_Category`, metric `Average of Variance_Hours` — that
is how you find categories whose *estimate* is wrong rather than whose *work* is
slow.

---

## 7. PAGE 5 — Repeated tasks

Source `DS_Repeat`. Filters: `Classification`, `Department`, `Employee_Name`.

**Table:** `Employee_Name` · `Department` · `Sample_Task` · `Occurrences` ·
`Distinct_Dates` · `Max_Same_Day_Count` · `First_Date` · `Last_Date` ·
`Classification` · `Classification_Reason`

Sort by `Occurrences` desc. Colour `Classification`:

| Value | Colour | Read it as |
|---|---|---|
| Recurring / Legitimate | grey | routine duty, expected |
| Highly Repetitive | blue | automation candidate |
| Potential Duplication | amber | check the source report |
| Needs Review | red | a human must confirm |

Add a bar chart: dim `Classification`, metric `Record Count`, so the split is
visible at a glance. Nothing on this page should be read as a fault.

---

## 8. PAGE 6 — Monthly review

Source `DS_Monthly`. Filter: `Month_Start` (or a year drop-down).

| Element | Type | Detail |
|---|---|---|
| Monthly volume | Column | dim `Month_Label`, metric `Total_Tasks`, filter `Department = ALL` |
| Monthly completion rate | Line | dim `Month_Start`, metric `Completion Rate %`, `Department = ALL` |
| Month-over-month movement | Table | `Month_Label`, `Total_Tasks`, `Completion_Rate`, `Prev_Completion_Rate`, `Completion_Rate_PP_Change` |
| Department comparison | Stacked column | dim `Month_Label`, breakdown `Department` (`!= ALL`), metric `Total_Tasks` |
| Slow-task count by month | Column | metric `Slow_Tasks` |
| Recurring-task count by month | Column | metric `Repeated_Tasks` |
| Key observations | Text / embedded table | latest row of `AI_Reports` — see below |

To surface the written summary, add `AI_Reports` as a data source, then a table
with dimension `Report_ID` and `Summary`, sorted by `Generated_At` desc, row
limit 1. (Looker cannot render the full multi-line `Human_Report` nicely; the
`Summary` column is sized for this.)

---

## 9. Refresh, sharing and performance

- **Data freshness:** each data source → *Edit → Data freshness → 15 minutes*
  (the minimum for Sheets). Looker caches; a "missing" row is nearly always a
  cache, not a pipeline failure. Use *Refresh data* in the top-right to confirm.
- **Why summary tabs, not `Tasks`:** charting 50,000 raw rows makes every page
  slow. The summary tabs are already aggregated, so pages render instantly.
  `DS_Tasks` is used only for the status donut and detail tables.
- **Sharing:** *Share → anyone with the link can view* keeps management out of
  the underlying sheet. Sharing the report does **not** share the spreadsheet;
  viewers see only what the charts expose.
- **Scheduled email:** *Share → Schedule delivery* sends a PDF on a cron. This
  is free and is a good alternative to `EMAIL_DAILY_REPORT`.
