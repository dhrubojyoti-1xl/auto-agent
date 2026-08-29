# Troubleshooting

Start with **Department Reporting → System Status** — it shows the last
processing time, counts, AI state, installed triggers and the last error in one
panel. Then open the **System_Log** sheet, filtered to the latest `Run_ID`, and
`Reports.Processing_Status` for the email in question.

---

## Ingestion

### "The script runs but finds nothing"

`System_Log` shows `Ingest / search — Query matched 0 thread(s)`.

| Cause | Fix |
|---|---|
| The label is not applied | Check the thread actually carries `DAILY_REPORT` |
| `SEARCH_QUERY` excludes it | The default has `newer_than:30d`; older mail is skipped. Widen it temporarily |
| The email was already processed | The query has `-label:REPORT_PROCESSED`. Remove the label to reprocess — the fingerprints still prevent duplicates |
| Label name mismatch | Gmail labels are case-sensitive and nested labels need the full path (`Reports/Daily`) |

### `Processing_Status = NO_DATA`

The email contained no table with recognisable `Date`, `Employee`, `Task` and
`Status` headers.

1. Open `Reports.Error_Message` — it reports how many tables were seen.
2. If `Tables_Found = 0` and the email looks like a table on screen, it is
   probably a pasted image or an attachment. Inline HTML tables and plain-text
   pipe tables are supported; images and attachments are not.
3. If tables were seen but none matched, your headers are not in
   `Header_Alias_Map`. Add rows — e.g. `daily activity` → `Task` — and reprocess.
4. `MIN_HEADER_MATCHES` (default 3) can be lowered to 2 for very sparse tables,
   at the cost of more false positives on signature tables.

### Rows land in `Data_Quality`

Read `Rejection_Detail`; it names the sheet to edit.

| Reason | Fix |
|---|---|
| `UNKNOWN_STATUS` | Add the exact spelling to `Status_Alias_Map`, or set `REJECT_UNKNOWN_STATUS=FALSE` to import as Pending with a warning |
| `INVALID_DATE` | Check `DATE_ORDER`. `04/05/2026` is 4 May under DMY and 5 April under MDY — the system cannot know which without being told |
| `MISSING_REQUIRED_FIELD` | The source report genuinely has a blank. Fix it upstream; a blank cell cannot be invented |
| `UNKNOWN_EMPLOYEE` | Add the person (or an alias) to `Employees`, or set `AUTO_CREATE_EMPLOYEES=TRUE` |
| `TASK_TOO_SHORT` | Someone wrote `ok` in the Task column. Lower `MIN_TASK_LENGTH` only if you really want that |
| `DUPLICATE_ACROSS_EMAILS` | Working as intended — the same content arrived twice. See below if it is wrong |

After fixing a master sheet: remove `REPORT_PROCESSED` from the thread, delete
that email's row from `Reports`, and reprocess. Already-good rows will be
skipped, not duplicated.

### Genuine rows wrongly rejected as duplicates

Two truly different tasks that share date + employee + department + task text +
status are indistinguishable to the fingerprint **across emails**. Within one
email they are fine (the occurrence ordinal separates them).

Fix the source: send both in one email, or make the task text distinguishable
("Client call — Acme" vs "Client call — Borex"). Better task text improves the
repeat analysis too.

### The same task appears twice in `Tasks`

Expected when both rows came from the **same** email — that is the deliberate
"two genuine client calls" behaviour. If they came from different emails, check
whether `Department` differs between them: department is part of the
fingerprint, so a department change between runs creates a new fingerprint.
Fix the master data, then delete the stray rows by hand.

### Rows imported with the wrong department

Precedence is: row `Department` column → `Employees.Department` → subject
or sender-domain hint → `DEFAULT_DEPARTMENT`.

- Fill `Employees.Department` for everyone; that is the reliable route.
- Add `Sender_Domains` to `Departments` when each department mails from
  its own domain.
- Add subject words to `Departments.Name_Aliases` — the subject scan
  matches whole words only, so `mktg` must be listed as an alias.

### Names not merging (`Rahul` vs `Rahul Mehta`)

First-name matching only applies when it is **unambiguous**. Two people called
Rahul disables it deliberately. Put every real-world spelling in
`Employees.Name_Aliases`.

---

## Execution and quotas

### "Exceeded maximum execution time"

Apps Script caps one execution at 6 minutes. The ingest loop stops itself at
`MAX_RUNTIME_MS` (default 4 minutes) and logs `timeboxed`; the next run
continues. If you still hit it, lower `MAX_EMAILS_PER_RUN`.

### "Service invoked too many times" / quota errors

Consumer Gmail allows roughly 20,000 Gmail read operations and 90 minutes of
script runtime per day. Reduce trigger frequency (`TRIGGER_INGEST_EVERY_MINUTES
= 60`) and tighten `SEARCH_QUERY` with `newer_than:7d`.

### Two runs overlapping

`withLock_()` takes a script lock; the second run logs
`Another run holds the lock; skipping this execution` and exits. That is normal
and safe — it is not a failure.

### "Authorization is required to perform that action"

Run `setupSpreadsheet()` manually once from the editor and complete the OAuth
consent. Triggers cannot show a consent screen.

### The Department Reporting menu is missing

`onOpen()` only runs when the spreadsheet loads. Reload the tab. If it is still
missing, the project has a syntax error — open the editor and check for a red
marker; a broken file stops `onOpen` from ever running.

---

## Metrics and dashboard

### Looker Studio shows old numbers

Data-source freshness for Sheets is 15 minutes minimum. Use *Refresh data*
(top-right) to force it. If a specific chart is empty, check its chart-level
`Department = ALL` / `!= ALL` filter first — that is the usual culprit.

### Totals are double what they should be

You are summing the `ALL` roll-up rows together with the per-department rows.
Every summary tab carries both. Add the filter.

### Completion rate looks wrong on an aggregate chart

Do not average stored `Completion_Rate` across rows of different sizes. Use the
calculated field `SUM(Completed)/SUM(Total_Tasks)*100`. See
`docs/LOOKER_STUDIO.md` §2.

### Dates render as text or 1970

Set the field type to **Date (YYYYMMDD)** in the data source, not just the
display format. Then refresh fields.

### `Slow_Tasks` is empty

Almost always correct: slow-task detection needs **both** an expected duration
(from `Task_Categories` or an email column) and an actual duration (from
start/completion timestamps or an hours column). With only
`Date, Employee, Task, Status, Link`, no task can be measured — every row reads
`INSUFFICIENT_DATA`, by design. Add the timestamp columns to your report
template to switch this on.

### Everything is flagged slow

Your `Expected_Duration` values are too tight, or someone reported an end time
without a start time on a different day. Check `Duration_Basis`: `Reported`
means the email supplied the hours, `Derived` means the script computed them.
Raise the category estimate or `SLOW_TASK_MULTIPLIER`.

### Every repeat is "Needs Review"

`REPEAT_SAME_DAY_REVIEW_MIN` (default 3) is too low for teams that legitimately
log many identical rows per day. Raise it.

---

## AI layer

| Symptom | Cause / fix |
|---|---|
| `Status = OK_AI_UNAVAILABLE` | Key missing, quota exhausted, or network error. `Validation_Error` has the HTTP detail. The deterministic report was still produced |
| `Status = OK_AI_PARTIAL` | The model invented something; it was removed. `Validation_Error` lists exactly what |
| `No API key stored` | Menu → **AI (optional) → Store AI API key** |
| Manual mode does nothing | Paste the JSON into column **G** of the `AI_Dataset` row, then run **AI (optional) → Import pasted AI JSON** |
| `Import_Status = PARSE_FAILED` | The chatbot wrapped its answer in prose. Ask it for JSON only; the parser already strips code fences |
| Numbers in the narrative differ from the KPIs | Should be impossible — the validator substitutes dataset values. Report it with the `AI_JSON` cell contents |

---

## Data integrity

### `Rows_Extracted ≠ Inserted + Skipped + Rejected`

They must reconcile. If they do not, an exception occurred mid-email; check
`System_Log` for an ERROR with the same `Email_ID`, and confirm
`Processing_Status = FAILED` so the email will be retried.

### Recovering from a bad import

1. Note the `Report_ID`.
2. Filter `Tasks` by that `Report_ID` and delete those rows.
3. Delete the `Reports` row.
4. Remove `REPORT_PROCESSED` from the Gmail thread.
5. Fix the master data.
6. Reprocess.

### Starting over

Menu → **Clear demo data (Tasks/Reports/Rejected)**. Masters and Config survive.
To also reset Gmail, remove `REPORT_PROCESSED` from the affected threads.
