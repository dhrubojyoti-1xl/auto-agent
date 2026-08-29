# Test plan — how to prove the system works

Three layers: automated self-tests, fixture emails, and the end-to-end
acceptance test.

---

## 1. Automated tests (2 minutes, no email and no Google account needed)

Menu → **Department Reporting → Run Tests**, or run `runAllTests()` in the editor.

Expected: **50/50 tests passed**. Results also go to `System_Log`.

That in-sheet suite is the unit + parser + AI-validation layer. The local
harness (`npm test`) runs those same 50 plus 36 end-to-end integration checks
against a live in-memory spreadsheet — **86 in total**.

They are dry-run: real extraction, normalisation, validation and dedup logic
runs, but nothing is written to `Tasks`, `Reports` or `Data_Quality`.

Coverage:

| Area | Tests |
|---|---|
| Date parsing | ISO, `29 Aug 2026`, `Aug 29, 2026`, `29/08/2026` (DMY), self-disambiguating `08/29/2026`, MDY mode, `29th Aug 2026`, rejects `32 Aug 2026`, rejects prose |
| Time parsing | `9:30 AM`, `17.45` |
| Status normalisation | Done/finished → Completed, WIP → In Progress, Waiting/Not Done → Pending, unknown → `null` |
| Task normalisation | case+punctuation collapse, different tasks stay different, token similarity |
| HTML extraction | perfect table, reordered columns, multiple tables with a signature table ignored, nested layout tables not double-counted, colspan/rowspan alignment, plain-text pipe tables |
| Ingestion | valid rows, optional field missing, required field missing, invalid status, invalid date, legitimate same-day repeats, 60-row report, non-report email |
| Duplicates | idempotent re-run, cross-email duplicate, duplicate + one new row |
| Forwarded mail | `Fwd:`/`FW:`/`Re:` prefixes never become departments; unknown subjects never invent one |
| Extra columns | irrelevant columns ignored; Remarks → Notes; priority normalised |
| Duration | derived from timestamps, `INSUFFICIENT_DATA` when absent, slow flag needs both numbers |
| AI safety | invented department dropped, wrong completion rate overridden |
| Arithmetic | percentage points ≠ percent |
| End-to-end | sample data through the real pipeline, twice, plus metrics, three report types, and System Status |
| Demo email | `sample-data/real-demo-email.html`: 14 import, 2 quarantined, 3 identical client calls all kept and classified `Needs Review`, exactly 4 measurable slow tasks, and forwarding it imports nothing — so the numbers quoted in `DEMO_SCRIPT.md` cannot drift |

Run them locally too, without Google:

```bash
node tools/run-tests.js
```

---

## 2. The email fixtures

Each is a real email body in `test-emails/`, and each is exercised by the
automated suite. Send them to yourself, label them `DAILY_REPORT`, and run
**Department Reporting → Process New Emails**.

| # | File | What it tests | Expected result |
|---|---|---|---|
| 1 | `01-perfect-report.html` | clean table inside a Gmail layout table, with a signature table | 3 inserted, 0 rejected, signature ignored |
| 2 | `02-reordered-columns.html` | `Employee, Date, Work Done, Current Status, Reference` | 2 inserted, headers mapped by alias |
| 3 | `03-extra-columns.html` | S.No, Department, Category, Priority, Remarks, Approved By, Cost Centre | 2 inserted; irrelevant columns ignored, Remarks → Notes, `P1` → High, `WIP` → In Progress |
| 4 | `04-missing-required-field.html` | one row with no employee | 2 inserted, 1 rejected `MISSING_REQUIRED_FIELD` |
| 5 | `05-missing-optional-field.html` | no Link column at all | 2 inserted, `Link` blank, no rejection |
| 6 | `06-duplicate-email.html` | 3 rows already imported from #1 plus 1 new | 1 inserted, 3 rejected `DUPLICATE_ACROSS_EMAILS` |
| 7 | `07-forwarded-report.html` | `Fwd:` with the report inside a `gmail_quote` blockquote | 2 inserted; department resolved from the subject, **never** `Fwd` |
| 8 | `08-multiple-tables.html` | Sales table + attendance table + Marketing table | 2 inserted from the two report tables; attendance ignored |
| 9 | `09-plain-text-table.txt` | `Date \| Employee \| Task \| Status \| Link` plain text | 2 inserted via the plain-text fallback |
| 10a | `10a-invalid-status.html` | `Compleeted!!` | 0 inserted, 1 rejected `UNKNOWN_STATUS`, detail names `Status_Alias_Map` |
| 10b | `10b-invalid-date.html` | `32 Aug 2026` | 0 inserted, 1 rejected `INVALID_DATE` |
| 11 | `11-repeated-tasks.html` | 3 identical `Client call` rows + 1 other | **4 inserted, 0 rejected** — repetition is not duplication |
| 12 | `12-duration-slow-task.html` | real start/end times: 15:00–17:45 against a 1 h category estimate | 2 inserted; the first flagged slow (variance +1.75 h), the second not |
| 13 | `13-colspan-rowspan.html` | merged header + `rowspan` date cell | 2 inserted, date carried down correctly |
| 14 | `14-large-report.html` | 60 rows, 10 people, 6 status spellings | 60 inserted, 0 rejected |

Send #1 before #6 — #6 exists to prove #1's rows cannot be re-imported.

### Forwarded and replied subjects

Explicitly covered, because a naive subject parser turns `Fwd` into a department
and silently corrupts the duplicate fingerprint:

```
"Fwd: Daily Report - Sales"            -> department Sales
"FW: Daily Report - Operations"        -> department Operations
"Re: Daily Report - Operations"        -> department Operations
"RE: FW: Fwd: Daily Report - Operations" -> department Operations
"Fwd: EOD update"                      -> never "Fwd", never "EOD"
```

## 3. Sample-data test (fastest full-pipeline proof)

Menu → **Department Reporting → Load Sample Data**.

```
Expected: 57 task rows inserted, 23 rejected on purpose, 0 skipped
```

Then verify:

| Sheet | Expectation |
|---|---|
| `Tasks` | 57 rows across 3 departments, 10 employees, 5 dates |
| `Reports` | 5 rows: 3 `SUCCESS`, 2 `PARTIAL` |
| `Data_Quality` | 5 malformed rows + 18 duplicates from the deliberately re-sent email |
| `Department_Summary` | Sales, Marketing, Operations — no `Unassigned` |
| `Repeated_Tasks` | includes one `Highly Repetitive` (Deepa Iyer, 10 occurrences) and one `Needs Review` (Priya Sharma, 3 client calls on one day) |
| `Slow_Tasks` | 5 rows, sorted by variance, each with `Duration_Basis = Derived` |
| `Employee_Summary` | `Data_Sufficiency` populated; most people read `Insufficient — do not rank` |

`sample-data/*.csv` in this repository is exactly what a correct run produces —
diff against it if something looks off.

---

## 4. Idempotency test (the critical one)

```
Run 1 → Load Sample Data   ->  57 inserted
Run 2 → Load Sample Data   ->   0 inserted, 0 rejected
```

Then the harder version, which proves protection is in the *data*, not the
labels:

1. Delete the 5 rows from the `Reports` sheet (leave `Tasks` alone).
2. Run **Load Sample Data** again.
3. Expected: **0 inserted, 57 skipped** — the fingerprints in `Tasks` caught
   every row even with the email-level record gone.

Same test for live email: run **3. Process report emails now** twice. The second
run adds nothing. Remove the `REPORT_PROCESSED` label by hand and run again:
still nothing.

---

## 5. Duplicate vs repeat test

| Input | Expected | Why |
|---|---|---|
| Same email processed twice | 0 new rows, counted as *skipped* | idempotent re-run |
| Same table forwarded from another address | rejected `DUPLICATE_ACROSS_EMAILS` | same fingerprint, different owner |
| 3 identical `Client call` rows in one email | all 3 inserted | occurrence ordinal distinguishes them |
| `Update CRM` on 5 consecutive days | 5 rows, classified `Recurring / Legitimate` | a routine duty is not a defect |
| `Prepare daily report` twice a day for 5 days | 10 rows, classified `Highly Repetitive` | automation candidate, still not a defect |

---

## 6. Failure-recovery test

1. Temporarily set `MAX_RUNTIME_MS` to `1` on the Config sheet.
2. Run **Process New Emails** with several unprocessed emails.
3. The run stops early and logs `timeboxed` in `System_Log`. Emails already
   committed have `Reports` rows; the rest have none.
4. Restore `MAX_RUNTIME_MS` to `240000` and run again.
5. Expected: the remaining emails process, and the already-processed ones
   contribute **0 new rows**.

To simulate a mid-email crash, add `throw new Error('boom')` inside
`writeReportRow_` temporarily. Tasks are written but the `Reports` row is not,
so the email stays non-terminal. Remove the throw and re-run: the rows are
recognised as already inserted (skipped), and the `Reports` row is written.
No duplicates.

---

## 7. ACCEPTANCE TEST

The scenario the project is judged on.

**Input.** Email yourself a table of 10–20 rows:

```
Date | Employee | Task | Status | Link
```

Mix statuses, include two identical rows for one person, one row with a bad
date, and one with a status like `Compleeted`.

**Steps**

1. Send it. The Gmail filter applies `DAILY_REPORT` (or apply it by hand).
2. Wait for the ingest trigger, or run **3. Process report emails now**.

**Expected, in order**

| # | Check | Where |
|---|---|---|
| 1 | Gmail received the email | Gmail |
| 2 | Apps Script detected it | `System_Log`: `Ingest / search` names the query and thread count |
| 3 | Table extracted | `Reports.Tables_Found ≥ 1`, `Rows_Extracted` = your row count |
| 4 | Data normalised | `Tasks.Task_Status` shows canonical values; names match `Employees` |
| 5 | Valid rows in the database | `Reports.Rows_Inserted` = valid rows |
| 6 | Invalid rows logged | `Data_Quality` has the bad-date and bad-status rows with reasons |
| 7 | Duplicates prevented | the two identical rows are **both** present (same email); re-sending the email adds nothing |
| 8 | Metrics updated | `Daily_Summary` has today's row; `Department_Summary` recalculated |
| 9 | Looker reflects it | refresh the report (cache is up to 15 min) |
| 10 | Repeated tasks identified | `Repeated_Tasks` lists any employee+task with ≥2 occurrences, with a classification |
| 11 | Slow tasks identified where possible | `Slow_Tasks` populated only where both durations exist; the rest read `INSUFFICIENT_DATA` |
| 12 | AI summary if enabled | `AI_Reports` row; `Generator` shows which path produced it |
| 13 | Email marked processed | Gmail thread carries `REPORT_PROCESSED` (plus `REPORT_REVIEW` if rows were rejected) |
| 14 | Safe to re-run | run it twice more: `Rows_Inserted = 0` every time, no new `Tasks` rows |

**Pass criteria:** all 14. If #14 fails, stop and investigate before going live —
everything else is recoverable, duplicated data is not.

---

## 8. Regression testing after any change

```bash
node tools/run-tests.js       # 86/86 must still pass (50 unit + 36 e2e)
node tools/export-fixtures.js # regenerates sample-data/ — git diff shows drift
```

In the sheet: **Clear demo data** → **Load sample data** → compare against
`sample-data/*.csv`.
