# Setup guide — click by click

Time: about 30 minutes for the core system, plus 30 for the dashboard.
Prerequisite: a Google account (personal Gmail is fine; Workspace is fine).

---

## STEP 1 — Create the Google Sheet

1. Go to <https://sheets.new>
2. Rename it `Department Reports DB`.
3. Copy the spreadsheet ID from the URL — the long string between `/d/` and
   `/edit`. You only need it if you later run the script standalone.

## STEP 2 — Open Apps Script

`Extensions → Apps Script`. A new tab opens with a file called `Code.gs`.

## STEP 3 — Paste the code

1. Delete everything inside `Code.gs` and rename it `00_Config` (click the ⋮
   next to the file name → Rename).
2. Paste `apps-script/00_Config.gs`.
3. For each remaining file in `apps-script/`, click `+ → Script`, name it
   exactly as the file (without `.gs`), and paste the contents:
   `01_Schema`, `02_Setup`, `03_Utils`, `04_Gmail`, `05_HtmlTable`,
   `06_Ingest`, `07_Analysis`, `08_Metrics`, `09_AI`, `10_Reports`,
   `11_Triggers`, `12_Menu`, `13_Tests`.
4. `Project Settings` (gear icon) → tick **Show "appsscript.json" manifest file
   in editor**. Open `appsscript.json` and replace it with
   `apps-script/appsscript.json`. Set `timeZone` to your zone.
5. Save (Ctrl/Cmd + S).

> The 14 files are one program. Apps Script concatenates them, so the order in
> the editor does not matter — but keeping the numbering makes review sane.

## STEP 4 — Configure the spreadsheet ID (only if standalone)

If the script is bound to the sheet (which it is, if you got here via
`Extensions → Apps Script`), leave `SPREADSHEET_ID` blank. If you created a
standalone script instead, put the ID from STEP 1 into `DEFAULT_CONFIG.SPREADSHEET_ID`.

## STEP 5 — Run setup and authorise

1. In the editor, choose the function `setupSpreadsheet` and click **Run**.
2. Google asks for authorisation. Choose your account → *Advanced* → *Go to
   \<project name\> (unsafe)* → *Allow*. This warning appears for every
   unpublished personal script; you are authorising your own code.
3. Scopes requested and why:
   - Spreadsheets — read/write your database
   - Gmail (modify) — read report emails and apply labels; it never deletes mail
   - Script triggers — schedule the automation
   - Send email — the optional management summary
   - External requests — only used when `AI_PROVIDER` is `gemini`/`custom_http`

Setup creates 20 tabs and seeds the master tables. It is safe to re-run: it
repairs headers and never touches your Tasks/Reports data.

## STEP 6 — Reload the Sheet

Go back to the spreadsheet tab and refresh. A **Department Reporting** menu appears. (The menu comes from `onOpen()`, so it only shows after a reload.)

## STEP 7 — Configure Gmail labels and the filter

> Full click-by-click version with screenshots-in-words:
> [REAL_GMAIL_SETUP.md](REAL_GMAIL_SETUP.md).

`setupSpreadsheet` already created the labels `DAILY_REPORT`,
`REPORT_PROCESSED`, `REPORT_ERROR`, `REPORT_REVIEW`.

Now make labelling automatic — this is the step that removes the last manual
action from the daily loop:

1. In Gmail, click the search box's filter icon.
2. Fill in what identifies your report emails, e.g.
   - **From:** `@yourcompany.com`
   - **Subject:** `daily report OR department report`
   - **Has the words:** `has:attachment` is *not* needed; tables are inline
3. `Create filter` → tick **Apply the label** → `DAILY_REPORT`. Tick
   **Also apply filter to matching conversations** to backfill history.

Then tune detection on the **Config** sheet (safer than editing code):

| Key | Example |
|---|---|
| `SEARCH_QUERY` | `label:DAILY_REPORT -label:REPORT_PROCESSED newer_than:30d` |
| `ALLOWED_SENDER_DOMAINS` | `yourcompany.com` |
| `SUBJECT_MUST_CONTAIN_ANY` | `daily report,department report,eod report` |
| `DATE_ORDER` | `DMY` for 29/08/2026, `MDY` for 08/29/2026 |

## STEP 8 — Configure AI credentials (optional — skip for now)

The system is designed to be commissioned **without** AI. Leave
`AI_ENABLED = FALSE` until the core pipeline is proven. See [AI_LAYER.md](AI_LAYER.md)
when you are ready. Never put a key in a cell.

## STEP 9 — Load sample data

Menu → **Department Reporting → Load Sample Data**.

This builds real HTML emails in memory and pushes them through the same parser
the live pipeline uses. Expected result:

```
57 task rows inserted, 23 rows rejected on purpose, 0 skipped
```

The 23 rejections are intentional: 5 malformed rows and 18 rows from a
deliberately re-sent email, proving duplicate protection.

## STEP 10 — Prove idempotency

Run **Load Sample Data** again. Expected result:

```
0 inserted, 0 rejected, 0 skipped
```

(The emails are already recorded as processed in `Reports`, so they are not even
re-parsed. Delete their rows from `Reports` and run again — you then get
`0 inserted, 57 skipped`, which is the row-level guarantee.)

## STEP 11 — Run the self-tests

Menu → **Department Reporting → Run Tests**. Expected: `86/86 tests passed`. Nothing is
written to Tasks/Reports — the tests are dry-run.

## STEP 12 — Send a real test email

1. In Gmail, compose a mail **to yourself**.
2. Paste the table from `test-emails/01-perfect-report.html`. The simplest way:
   open the file in a browser, select the rendered table, copy, paste into the
   compose window (Gmail keeps the table HTML).
3. Send it, then apply the `DAILY_REPORT` label (or let your filter do it).
4. Menu → **Department Reporting → Process New Emails**.

## STEP 13 — Verify the database

Check, in order:

- **Reports** — one new row, `Processing_Status = SUCCESS`, `Rows_Inserted = 3`.
- **Tasks** — three new rows with normalised statuses and a `Task_Fingerprint`.
- **Data_Quality** — unchanged.
- **System_Log** — an `Ingest / email` INFO line naming the subject.
- The Gmail thread now carries `REPORT_PROCESSED`.

Run **Process New Emails** again: no new rows. That is the acceptance
criterion for idempotency.

## STEP 14 — Connect Looker Studio

Follow [LOOKER_STUDIO.md](LOOKER_STUDIO.md) §1–§2. In short: <https://lookerstudio.google.com>
→ *Create → Data source → Google Sheets* → pick your spreadsheet → add one data
source per summary tab.

## STEP 15 — Build the dashboard

[LOOKER_STUDIO.md](LOOKER_STUDIO.md) §3–§8 gives every page, chart, metric and filter.

## STEP 16 — Enable triggers

Menu → **Department Reporting → Automation → Install triggers**. Defaults (all editable on the Config sheet):

| Trigger | Function | When |
|---|---|---|
| Ingest | `ingestTrigger` → `processIncomingReports()` | every 30 minutes |
| Daily | `dailyPipeline` | 09:10 |
| Weekly | `weeklyPipeline` | Monday 09:30 |
| Monthly | `monthlyPipeline` | daily check at 09:50, acts on day 1 |

Verify in the Apps Script editor under **Triggers** (clock icon).

## STEP 17 — End-to-end test

Run the acceptance test in [TEST_PLAN.md](TEST_PLAN.md) §7. Send a 10–20 row report,
wait for the ingest trigger, and confirm: rows land, metrics update, Looker
refreshes, the email is labelled, and a second run changes nothing.

---

## Post-install checklist

- [ ] `Employees` reflects your real people (edit the seeded demo rows).
- [ ] `Departments` has your departments, with `Sender_Domains` filled in
      if each department mails from its own domain.
- [ ] `Task_Categories` — set `Expected_Duration` only where you genuinely
      know it. Leave it blank otherwise; blank means "do not judge this task's
      speed", which is the honest default.
- [ ] `Status_Alias_Map` — add the exact spellings your teams actually use.
- [ ] `Header_Alias_Map` — add your teams' real column headings.
- [ ] Menu → **Maintenance → Clear demo/transactional data** once you are live, so the sample rows do not
      pollute real metrics.
