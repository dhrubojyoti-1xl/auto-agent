# Monday demo — 8 minutes

One message: **nobody copies a table into a chatbot any more.**

---

## Before the room (15 minutes, the night before)

- [ ] Sheet set up, 14 files pasted, `setupSpreadsheet()` authorised
      ([REAL_GMAIL_SETUP.md](REAL_GMAIL_SETUP.md))
- [ ] Gmail filter live: subject contains `Daily Report` → label `DAILY_REPORT`
- [ ] `node tools/export-fixtures.js` — regenerates the demo email with **today's** date
      (16 rows: 14 good, 2 deliberately bad)
- [ ] Triggers installed
- [ ] Looker Studio dashboard built ([LOOKER_STUDIO.md](LOOKER_STUDIO.md))
- [ ] **Maintenance → Clear demo/transactional data**, then
      **Load Sample Data** so the dashboard has a week of history behind today
- [ ] Tabs open in this order: Gmail · Sheet · Looker Studio
- [ ] The demo email drafted but **not sent**

---

## The demo

### 1. The problem (30 seconds)

> "Every day someone opens these report emails, copies the tables, and pastes
> them into a chatbot to get a summary. That is the job we are deleting."

Show one report email in Gmail.

### 2. Send the report (45 seconds)

Send the drafted email — subject
`Daily Report - Sales, Marketing, Operations`.

Point at the label appearing on the thread:

> "The Gmail filter labelled it `DAILY_REPORT` automatically. That filter was
> created once. Nobody touches Gmail again."

### 3. Ingest (45 seconds)

In the sheet: **Department Reporting → Process New Emails**.

> "Normally this runs every thirty minutes on a schedule. I am pressing it so
> you do not have to watch a clock."

### 4. The database (60 seconds)

Open **Tasks**. Scroll to the new rows.

Point at three columns specifically:

- `Task_Status` — *"the email said Done, WIP, Complete and In progress. They are
  all normalised. Fifty spellings are mapped, and adding a new one is a row in a
  sheet, not a code change."*
- `Task_Category` and `Expected_Duration` — *"matched from the task text."*
- `Task_Fingerprint` — *"remember this one, it matters in a minute."*

### 5. Nothing is silently dropped (45 seconds)

Open **Data_Quality**. Two rows.

> "One row had the status `Compleeted!!` and one had no employee name. They are
> quarantined with the raw values and a reason that tells you which sheet to
> fix. The other fourteen rows imported fine — one bad row never kills the
> email. Most tools either drop these silently or reject the whole message."

### 6. The dashboard (90 seconds)

**Rebuild Metrics**, then switch to Looker Studio and refresh.

- Page 1: KPIs move. *"Completion rate, slow tasks, repeated tasks, departments
  reporting."*
- Page 5 **Repeated Tasks**: one group — Priya Sharma, `Client call`, three
  occurrences, classified **Needs Review**.

  > "All three imported. Three genuine client calls in a day are not duplicates,
  > so nothing was dropped — but the pattern is flagged for a human to confirm.
  > The system classifies repetition as recurring, highly repetitive, potential
  > duplication or needs review, and never calls it a fault by itself."

- Page 4 **Slow Tasks**: four rows, largest variance first — Sana Qureshi's
  creative work at 8.5 h against a 4 h estimate, down to order processing at
  1.5 h against 0.75 h.

  > "Only four, because only those rows had real start and end times. Everything
  > else says INSUFFICIENT_DATA. The system will not invent a duration to fill a
  > chart. The day the teams add start and end columns, this page fills up on
  > its own — the parser already accepts them."

### 7. The management summary (60 seconds)

**Generate Daily Report**, open `AI_Reports`, read the `Human_Report` cell.

> "That is the thing that used to be a copy-paste into a chatbot. Note the
> footer: every number here is computed by code. The AI is optional and is
> currently off — this report was written without it. When it is on, the AI
> writes commentary only, and anything it invents gets stripped by a validator
> before publication."

If you want to show the guard-rail, open `AI_LAYER.md` §5 for ten seconds.

### 8. The closer — send it again (45 seconds)

Forward the same email to yourself, then **Process New Emails**.

Open `Reports`: `Rows_Inserted = 0`, `Rows_Rejected = 16`. Open `Data_Quality`
and sort by reason: 14 rows of `DUPLICATE_ACROSS_EMAILS`, plus the same two bad
rows caught again.

> "Same data, different email. Zero duplicates. And this is not the Gmail label
> doing the work — the fingerprints are in the database, so it holds even if
> somebody removes the label or the whole email record."

### 9. Health (20 seconds)

**System Status.** Emails processed, tasks imported, tasks rejected, duplicates
detected, last error.

> "That is the operations view. If something breaks, this and the System_Log tab
> tell you what and when."

---

## The close

> "Total cost: nothing. Gmail, Sheets, Apps Script, Looker Studio — all free
> tiers, no Zapier, no Airtable, no server. The AI layer is optional and can run
> by pasting into a free chatbot once a day if we never want to pay for an API.
>
> What it does not do yet: it cannot measure productivity, because the five
> columns we get today cannot support that. Add a start time and an end time to
> the report template and it can. That is the next conversation."

---

## Questions you will get

**"What if someone changes the columns?"**
Reorder them, rename them, add extra ones — it still works. Fixture
`test-emails/02-reordered-columns.html` and `03-extra-columns.html` prove it.
A genuinely new heading is one row in `Header_Alias_Map`.

**"What if it is forwarded?"**
`test-emails/07-forwarded-report.html`. `Fwd:`, `FW:` and `Re:` are explicitly
tested and never become department names.

**"What if two people have the same name?"**
First-name matching is only used when unambiguous. Two people called Rahul
disables it, and both must be listed in `Employees` with aliases.

**"What if the script crashes halfway?"**
Each email is committed on its own and only marked done once its `Reports` row
is written. The retry recognises its own rows and skips them. No gaps, no
duplicates.

**"Can we trust the AI?"**
It never produces a number. It receives pre-computed facts and returns
commentary, which is checked against those facts — invented departments,
employees, task IDs and rates are deleted and logged. Turn it off entirely and
everything still works.

**"How many reports can it handle?"**
Fifty emails per run, a run every thirty minutes, a few seconds per email — well
inside the free Apps Script quota. Google Sheets is comfortable past 100,000
tasks; `MIGRATION` guidance covers Postgres/BigQuery after that.

---

## If something goes wrong live

| Symptom | Do this |
|---|---|
| Email not picked up | Check the label is on the thread. Then `SEARCH_QUERY` on the Config sheet. |
| `NO_DATA` in Reports | The table pasted as an image. Use the HTML fixture, not a screenshot. |
| Dashboard not updating | Looker caches for up to 15 minutes — press *Refresh data* top-right. |
| Anything else | Open `System_Log`, filter to the latest `Run_ID`. Do this on screen; an audit trail that survives a live failure is itself a selling point. |
