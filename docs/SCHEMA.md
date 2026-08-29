# Database schema — every sheet, every column

20 tabs. Created and repaired by `setupSpreadsheet()`. Column order in
`01_Schema.gs` **is** the physical column order; nothing reads a column by a
hard-coded index.

Legend: **PK** primary key · **FK** foreign key · *derived* = written by code,
do not edit by hand.

---

## 1. `Tasks` — the fact table

One row per reported task. This is what Looker Studio and the AI ultimately
measure.

| Column | Meaning |
|---|---|
| `Task_ID` | **PK**. `TSK-` + hash of email + table + row + task text. Stable across re-runs. |
| `Report_ID` | **FK** → `Reports`. Which email produced this row. |
| `Date` | Business date of the task, as a real Date value. Parsed from any of ~8 formats. |
| `Department` | Normalised. Precedence: row column → employee master → email/subject hint → `DEFAULT_DEPARTMENT`. |
| `Employee_Name` | Canonical spelling from `Employees` (aliases and first-name-only forms resolve to it). |
| `Employee_ID` | **FK** → `Employees`. |
| `Task` | Task text as reported, whitespace-cleaned only. Never rewritten. |
| `Task_Normalized` | *derived*. Lowercased, punctuation and instance-numbers stripped. Used for repeat detection and fingerprints. |
| `Task_Category` | **FK** → `Task_Categories`. From an explicit column, else keyword match, else blank. |
| `Task_Status` | One of the six canonical statuses. |
| `Priority` | High / Medium / Low, if the report supplies it. |
| `Start_Date`, `Start_Time` | Optional. Needed for duration. |
| `Completion_Date`, `Completion_Time` | Optional. Needed for duration. |
| `Expected_Duration` | Hours. From the email's own column if present, else the task category. **Blank is meaningful**: it means nobody has stated an expectation, so the task is never judged slow. |
| `Actual_Duration` | Hours. Derived from timestamps, or taken from a reported hours column. |
| `Duration_Basis` | `Reported` \| `Derived` \| `INSUFFICIENT_DATA`. The audit trail for every duration claim. |
| `Link` | First URL in the row (from an `<a href>` or bare text). |
| `Source_Email_ID` | Gmail message id. The idempotency anchor. |
| `Source_Email_Date` | When the email arrived. |
| `Imported_At` | When this row was written. |
| `Data_Quality_Status` | `OK` \| `Partial` \| `Review`. |
| `Data_Quality_Notes` | Why it is not OK, in words. |
| `Duplicate_Flag` | Reserved for rows deliberately kept despite looking duplicate. Hard duplicates never reach this sheet — they go to `Data_Quality`. |
| `Task_Fingerprint` | *derived*. `sha1(Date\|Employee\|Department\|Task_Normalized\|Status # occurrence)`, first 16 hex chars. The duplicate key. |
| `Repeated_Task_Flag` | *derived* by `07_Analysis.gs`. |
| `Repeat_Classification` | *derived*. Recurring / Legitimate · Potential Duplication · Highly Repetitive · Needs Review. |
| `Slow_Task_Flag` | *derived*. `TRUE` / `FALSE` / `INSUFFICIENT_DATA`. |
| `Slow_Variance_Hours` | *derived*. Actual − Expected. Blank when unmeasurable. |
| `Notes` | Free text from a Remarks/Notes column. |

### Why the fingerprint has an occurrence number

`Date + Employee + Department + Task + Status` alone would treat two genuine
client calls on the same day as one. So the fingerprint appends the occurrence
ordinal **within the email**: the first "Client call" is `#1`, the second `#2`.

- Same email processed twice → identical ordinals → same fingerprints → owned by
  the same `Source_Email_ID` → **skipped silently** (idempotent).
- A different email resending the same content → same fingerprints → owned by a
  *different* email id → **rejected as `DUPLICATE_ACROSS_EMAILS`**.
- Three real client calls in one email → ordinals 1, 2, 3 → **all three kept**.

---

## 2. `Reports` — one row per processed email

Answers "was this email handled, and what happened to it?"

| Column | Meaning |
|---|---|
| `Report_ID` | **PK**, `RPT-` + hash of the Gmail message id. |
| `Email_ID` | Gmail message id. |
| `Thread_ID` | Gmail thread id. |
| `Email_Subject`, `Sender`, `Sender_Domain` | Provenance. |
| `Department` | Dominant department across the rows found. |
| `Report_Date` | Latest task date in the email, else a date in the subject, else the received date. |
| `Received_At` | Gmail timestamp. |
| `Processing_Status` | `SUCCESS` · `PARTIAL` (some rows rejected) · `NO_DATA` (no report table) · `FAILED` (exception) · `IGNORED` (set by hand to skip an email forever). |
| `Tables_Found` | Report tables recognised (layout/signature tables excluded). |
| `Rows_Extracted` / `Rows_Inserted` / `Rows_Skipped_Idempotent` / `Rows_Rejected` | The row-level audit. These four reconcile: extracted = inserted + skipped + rejected. |
| `Error_Message` | Why it failed or what was rejected. |
| `Processed_At`, `Run_ID` | Ties back to `System_Log`. |

**Only `SUCCESS`, `PARTIAL`, `NO_DATA` and `IGNORED` are terminal.** A `FAILED`
email is retried on the next run — that is the failure-recovery contract.

---

## 3. `Data_Quality` — nothing is silently dropped

| Column | Meaning |
|---|---|
| `Rejection_ID` | **PK**. |
| `Report_ID`, `Email_ID`, `Email_Subject`, `Sender` | Where it came from. |
| `Table_Index`, `Row_Index` | Exactly which row in which table (`-1` for duplicate rejections, which are detected after parsing). |
| `Rejection_Reason` | `MISSING_REQUIRED_FIELD` · `INVALID_DATE` · `UNKNOWN_STATUS` · `UNKNOWN_EMPLOYEE` · `TASK_TOO_SHORT` · `TASK_NOT_MEANINGFUL` · `DUPLICATE_ACROSS_EMAILS`. |
| `Rejection_Detail` | A sentence a non-programmer can act on, including which master sheet to edit. |
| `Raw_Date`, `Raw_Employee`, `Raw_Task`, `Raw_Status`, `Raw_Link` | The original values. |
| `Raw_Row_JSON` | Everything that was read from the row. |
| `Logged_At` | Import time. |
| `Resolution_Status` | Dropdown: Open / Fixed in source / Re-imported / Ignored. |

This is the sheet to open first when a number on the dashboard looks low: every
row that did **not** make it into `Tasks` is here, with the raw values and an
actionable reason.

---

## 4. `Employees`

| Column | Notes |
|---|---|
| `Employee_ID` | **PK**. |
| `Employee_Name` | Canonical spelling used everywhere downstream. |
| `Name_Aliases` | Comma separated. `rahul, rahul m` all resolve to `Rahul Mehta`. **This is the main tuning knob for messy name data.** |
| `Department` | Used when the email carries no department column. |
| `Active`, `Joining_Date`, `Role`, `Email` | Reference. |

If `AUTO_CREATE_EMPLOYEES=TRUE`, an unknown name is added here automatically and
the task row is marked `Partial` so you can review it. Set it to `FALSE` for a
closed roster; unknown names then land in `Data_Quality`.

## 5. `Departments`

`Department_ID`, `Department_Name`, `Name_Aliases`, `Manager`, `Manager_Email`,
`Sender_Domains` (comma separated — lets the system infer the department from
who sent the mail), `Active`.

## 6. `Task_Categories`

`Category_ID`, `Category_Name`, `Match_Keywords` (comma separated, longest match
wins), `Expected_Duration` (**hours**), `Active`, `Notes`.

`Expected_Duration` drives the entire slow-task feature. Leave it blank whenever
you do not genuinely know it — the seeded `Uncategorised` row does exactly that
on purpose.

## 7. `Statuses`

| Column | Meaning |
|---|---|
| `Status` | **PK**. The canonical value written into `Tasks.Task_Status`. |
| `Active` | Set `FALSE` to retire a status without deleting history. |
| `Counts_As_Completed` | Drives the completion-rate numerator. Only `Completed` is TRUE by default — a cancelled task is finished, but it is not completed work. |
| `Is_Terminal` | TRUE when no further movement is expected (`Completed`, `Cancelled`). |
| `Sort_Order` | Display order on the dashboard. |

Canonical set, seeded by `setupSpreadsheet()`:
Completed, In Progress, Pending, Blocked, Not Started, Cancelled.

## 8. `Status_Alias_Map`

`Alias` → `Canonical_Status`. Seeded with 50+ real-world spellings:
`done/complete/finished/closed/delivered/100%` → **Completed**;
`wip/ongoing/started/doing` → **In Progress**;
`waiting/not done/todo/on hold` → **Pending**;
`stuck/blocker/awaiting approval` → **Blocked**; and so on.

Add a row here rather than changing code when a team invents a new word.

## 9. `Header_Alias_Map`

`Alias` → canonical field. Seeded with 80+ header spellings
(`work done`, `activity`, `particulars`, `assigned to`, `team member`,
`current status`, `remarks`, `hours spent`, …). This is what makes column
reordering and renaming harmless.

## 10–12. `Daily_Summary`, `Weekly_Summary`, `Monthly_Summary`

Pre-aggregated, Looker-ready. One row per period **per department**, plus a
`Department = 'ALL'` roll-up row so a KPI card reads a single row instead of
summing a filtered range.

Common columns: period key/date, `Department`, `Total_Tasks`, the six status
counts, `Completion_Rate`, `Pending_Rate`, `Slow_Tasks`, `Repeated_Tasks`,
`Employees_Reporting`, `Prev_Completion_Rate`, `Completion_Rate_PP_Change`,
`Updated_At`.

`Completion_Rate_PP_Change` is a **percentage-point** delta. 80 → 85 is `+5`.

## 13. `Department_Summary`

All-time totals per department plus a 7-day vs previous-7-day comparison
(`Last_7d_Tasks`, `Prev_7d_Tasks`, `Last_7d_Completion_Rate`,
`Prev_7d_Completion_Rate`, `WoW_PP_Change`). Windows are anchored on the newest
task date in the data, not on "today", so backfills and demos behave correctly.

## 14. `Employee_Summary`

Same idea per person, plus `Distinct_Days_Reported`, 30-day windows, and
`Data_Sufficiency`:

- `Sufficient for trend` — ≥30 tasks over ≥10 distinct days
- `Indicative only` — ≥10 tasks
- `Insufficient — do not rank` — everything else

Put this column on the dashboard. It is the guard-rail against reading a league
table into a thin sample.

## 15. `Repeated_Tasks`

One row per (employee × normalised task) group with ≥2 occurrences.

| Column | Meaning |
|---|---|
| `Repeat_Key` | **PK**, hash of employee + normalised task. |
| `Employee`, `Department` | Who and where. |
| `Task` | Up to three real spellings seen, joined by ` \| ` — the human-readable label. |
| `Normalized_Task` | What the grouping actually matched on. |
| `Occurrence_Count` | Total rows in the group. |
| `Distinct_Dates` | How many different days it appeared on. |
| `Max_Same_Day_Count` | The largest number of occurrences on any single day. |
| `First_Date`, `Last_Date`, `Dates` | The span, and the list of dates. |
| `Completed_Count`, `Open_Count` | Status split within the group. |
| `Classification` | `Recurring / Legitimate` · `Potential Duplication` · `Highly Repetitive` · `Needs Review` |
| `Classification_Reason` | The exact rule that fired, in plain English. |

### The classification rules, in order

1. `Max_Same_Day_Count >= REPEAT_SAME_DAY_REVIEW_MIN` (default 3) → **Needs Review**.
   Could be genuine batched work or a reporting habit; the system does not guess.
2. `Occurrence_Count >= REPEAT_HIGH_MIN` (default 8) → **Highly Repetitive**.
   An automation candidate, *not* a performance judgement.
3. `Distinct_Dates >= REPEAT_RECURRING_MIN` (default 3) → **Recurring / Legitimate**.
   A routine duty.
4. `Occurrence_Count > Distinct_Dates` → **Potential Duplication**.
   Same-day repeats below the review threshold — check the source report.
5. Otherwise → **Recurring / Legitimate**.

Nothing on this table should be read as a fault.

## 16. `Slow_Tasks`

`Task_ID`, `Date`, `Department`, `Employee`, `Task`, `Task_Category`,
`Task_Status`, `Expected_Duration`, `Actual_Duration`, `Variance_Hours`,
`Variance_Pct`, `Duration_Basis`, `Link`, `Updated_At`.

Only tasks with **both** an expected and an actual duration, where
`Actual > Expected × SLOW_TASK_MULTIPLIER` (default 1.5). Sorted by largest
variance first.

Everything else carries `Tasks.Slow_Task_Flag = INSUFFICIENT_DATA` and is
excluded — with the excluded count printed on the report and on dashboard
page 4, so nobody mistakes "not measured" for "not slow".

Note the two different vocabularies, which are deliberate:
`Slow_Task_Flag` is a machine value (`TRUE` / `FALSE` / `INSUFFICIENT_DATA`);
`Duration_Basis` is a human-readable audit note
(`Reported` / `Derived` / `Insufficient Data`).

## 17. `AI_Reports` — the archive

`Report_ID`, `Report_Type`, `Period_Start`, `Period_End`, `Generated_At`,
`Generator` (`deterministic` / `ai:gemini` / `ai-manual`), `Model`, `Status`,
`Summary`, `Human_Report` (the full text), `AI_JSON` (dataset + validated AI
output), `Validation_Error`.

Upserted by `Report_ID`, so regenerating a day updates its row instead of
creating a second version. History stays accessible.

## 18. `AI_Dataset` — manual AI mode

`Generated_At`, `Report_Type`, `Period_Start`, `Period_End`,
`Prompt_For_Manual_Paste`, `Dataset_JSON`, `Paste_AI_JSON_Response_Here`,
`Import_Status`.

## 19. `System_Log`

`Timestamp`, `Run_ID`, `Level`, `Component`, `Action`, `Status`, `Message`,
`Email_ID`, `Report_ID`, `Details`. Buffered in memory and written once per run;
trimmed to `LOG_MAX_ROWS` oldest-first.

## 20. `Config`

`Key`, `Value`, `Description`. Overrides `DEFAULT_CONFIG` at runtime, so an
operator changes behaviour without touching code. Unknown keys are ignored.
Secrets are **never** stored here — they live in Script Properties.
