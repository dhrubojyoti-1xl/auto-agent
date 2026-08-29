# Connecting a real Gmail account

This is the one part nobody else can do for you: authorising the script against
your Google account requires your browser and your password. Everything up to
that boundary is already built.

Time: about 20 minutes. Cost: nothing.

---

## What you will end up with

```
Employee sends "Daily Report" email
              ↓
    Gmail filter (created once, in step 7)
              ↓
      label: DAILY_REPORT
              ↓
Apps Script trigger (every 30 minutes)
              ↓
   Google Sheet fills itself
```

No daily labelling. No daily copy-paste.

---

## STEP 1 — Use a Gmail account

Any free Gmail account works, and so does a Workspace account. Use the mailbox
that already receives the reports — the script reads mail, it does not need a
separate address.

> If you would rather demo on a clean account, create a free Gmail account and
> send the test reports to it. The setup is identical.

## STEP 2 — Create the Google Sheet

1. Go to <https://sheets.new>
2. Rename it `Department Reports DB`.

## STEP 3 — Open the script editor

In the sheet: **Extensions → Apps Script**. A new tab opens with `Code.gs`.

## STEP 4 — Add the 14 files

1. Delete the contents of `Code.gs`, rename it `00_Config` (⋮ → Rename), paste
   `apps-script/00_Config.gs`.
2. For each remaining file: **+ → Script**, name it exactly (no `.gs`), paste
   the contents.

   `01_Schema` · `02_Setup` · `03_Utils` · `04_Gmail` · `05_HtmlTable` ·
   `06_Ingest` · `07_Analysis` · `08_Metrics` · `09_AI` · `10_Reports` ·
   `11_Triggers` · `12_Menu` · `13_Tests`

3. Gear icon → **Project Settings** → tick *Show "appsscript.json" manifest file
   in editor*. Open it and replace with `apps-script/appsscript.json`. Change
   `timeZone` if you are not on `Asia/Kolkata`.
4. Save (Ctrl/Cmd + S).

The order in the editor does not matter — Apps Script concatenates the files.

## STEP 5 — Run setup

In the editor, select the function `setupSpreadsheet` from the dropdown and
click **Run**.

## STEP 6 — Authorise permissions

This is the step that needs you.

1. Google shows *Authorization required*. Click **Review permissions**.
2. Choose your account.
3. You will see *Google hasn't verified this app*. Click **Advanced** → **Go to
   \<project name\> (unsafe)**. This warning appears for every unpublished
   personal script; you are authorising code you pasted yourself.
4. Click **Allow**.

What you are granting, and why:

| Scope | Why the system needs it |
|---|---|
| See/edit this spreadsheet | write the Tasks database |
| Read, compose, send and permanently delete… Gmail | Apps Script has no read-only-plus-label scope. The script only ever calls `search`, `getBody`, `addLabel` and `removeLabel`. It never deletes or sends from your mailbox. `04_Gmail.gs` is short — read it. |
| Manage scripts/triggers | install the automation schedule |
| Send email as you | only used if you set `MANAGEMENT_EMAIL` and enable the summary email |
| Connect to an external service | only used if you enable the AI layer |

Setup creates 20 tabs, seeds the master data, and creates the Gmail labels.

## STEP 7 — Create the `DAILY_REPORT` label and the filter

`setupSpreadsheet` already created the labels. Now make labelling automatic.

1. In Gmail, click the **search box**, then the **filter icon** (sliders) on the
   right.
2. Fill in whatever identifies your report emails. Start simple:
   - **Subject:** `Daily Report`
   - (optional, safer) **From:** `@yourcompany.com`
3. Click **Create filter**.
4. Tick **Apply the label** → choose `DAILY_REPORT`.
5. Tick **Also apply filter to matching conversations** to backfill existing mail.
6. Click **Create filter**.

From now on, an employee sending a mail whose subject contains "Daily Report"
gets labelled automatically. Nobody touches Gmail again.

### Tightening detection later

Do this on the **Config** sheet, not in code:

| Key | Example |
|---|---|
| `SEARCH_QUERY` | `label:DAILY_REPORT -label:REPORT_PROCESSED newer_than:30d` |
| `ALLOWED_SENDER_DOMAINS` | `yourcompany.com` |
| `ALLOWED_SENDERS` | `ops@yourcompany.com,sales@yourcompany.com` |
| `SUBJECT_MUST_CONTAIN_ANY` | `daily report,department report,eod report` |
| `DATE_ORDER` | `DMY` for 29/08/2026, `MDY` for 08/29/2026 |

## STEP 8 — Send a test email

1. Open `sample-data/real-demo-email.html` in a browser.
2. Select the whole rendered table (and the surrounding text), copy.
3. In Gmail, compose to **yourself**, subject:
   `Daily Report - Sales, Marketing, Operations`
4. Paste. Gmail preserves the table HTML.
5. Send.

The demo email is generated with today's date. Regenerate it any time with
`node tools/export-fixtures.js`.

It contains 16 rows, two of them deliberately bad (an unmappable status
`Compleeted!!` and a missing employee name), so you can show that bad data is
quarantined rather than silently dropped.

## STEP 9 — Process it

Back in the sheet: reload the tab, then
**Department Reporting → Process New Emails**.

## STEP 10 — Verify the database

| Check | Where | Expected |
|---|---|---|
| The email was recorded | `Reports` | one new row, `Processing_Status = PARTIAL` |
| Rows landed | `Tasks` | 14 new rows with normalised statuses |
| Bad rows quarantined | `Data_Quality` | 2 rows with reasons |
| Audit trail | `System_Log` | an INFO line naming the subject |
| Gmail | the thread | now carries `REPORT_PROCESSED` and `REPORT_REVIEW` |

Run **Process New Emails** again. Nothing is added. That is the idempotency
guarantee, and it is the single most important thing to verify.

## STEP 11 — Verify metrics

**Department Reporting → Rebuild Metrics**, then check `Daily_Summary`,
`Department_Summary`, `Employee_Summary`, `Repeated_Tasks` and `Slow_Tasks`.

`Repeated_Tasks` will show one group: Priya Sharma's three identical
"Client call" rows, classified **Needs Review**. All three were imported —
three genuine calls in a day are not duplicates — but the pattern is flagged for
a human to confirm rather than silently merged or silently kept.

`Slow_Tasks` will show four rows, the ones with real start/end times:

| Task | Employee | Expected | Actual | Variance |
|---|---|---|---|---|
| Design creatives for festive campaign | Sana Qureshi | 4 h | 8.5 h | +4.5 h |
| Client call - Corvin onboarding | Imran Khan | 1 h | 2.75 h | +1.75 h |
| Resolve support ticket #4412 | Ayesha Siddiqui | 1 h | 2.5 h | +1.5 h |
| Process customer orders | Vikas Nair | 0.75 h | 1.5 h | +0.75 h |

Every other row reads `INSUFFICIENT_DATA`, because no timestamps were supplied
and the system will not invent a duration.

## STEP 12 — Generate a report

**Department Reporting → Generate Daily Report**, then open the `AI_Reports`
tab and read the `Human_Report` cell. With AI disabled it is written entirely
from the deterministic metrics.

## STEP 13 — Connect Looker Studio

Follow [LOOKER_STUDIO.md](LOOKER_STUDIO.md). Data sources first (§1–§2), then
the pages.

## STEP 14 — Enable automation

**Department Reporting → Automation → Install triggers**.

| Trigger | Function | Default |
|---|---|---|
| Ingest | `ingestTrigger` → `processIncomingReports()` | every 30 minutes |
| Daily | `dailyPipeline` | 09:10 |
| Weekly | `weeklyPipeline` | Monday 09:30 |
| Monthly | `monthlyPipeline` | daily check at 09:50, acts on day 1 |

Verify under the clock icon in the editor.

## STEP 15 — Check the health panel

**Department Reporting → System Status** — last processing time, emails
processed, tasks imported/rejected, duplicates detected, last metrics rebuild,
last report, AI status, installed triggers, last error.

## STEP 16 — Switch to real data

- Replace the demo rows in `Employees` with your real people (keep
  `Name_Aliases` filled in — it is the main defence against messy name data).
- Set your real `Departments`, with `Sender_Domains` if each department mails
  from its own domain.
- In `Task_Categories`, set `Expected_Duration` **only** where you genuinely
  know it. Leave it blank otherwise; blank means "do not judge this task's
  speed".
- Add your teams' real wording to `Status_Alias_Map` and `Header_Alias_Map`.
- **Department Reporting → Maintenance → Clear demo/transactional data.**

---

## What still needs a human, honestly

| Action | Why it cannot be automated from here |
|---|---|
| Pasting the 14 files into the editor | no access to your Google account |
| Clicking **Allow** on the OAuth screen | by design; only you can grant it |
| Creating the Gmail filter | one-time, 60 seconds, step 7 |
| Building the Looker Studio dashboard | needs your account; the full spec is in `LOOKER_STUDIO.md` |

Everything else — parsing, validation, normalisation, deduplication, metrics,
analysis, reporting, scheduling — is implemented and tested.

> If you want to skip the copy-paste in step 4, the files can be pushed with
> Google's `clasp` CLI (`npm i -g @google/clasp; clasp login; clasp push`).
> That still requires you to run `clasp login` in your own browser, so it moves
> the boundary rather than removing it. `.clasp.json` is gitignored.
