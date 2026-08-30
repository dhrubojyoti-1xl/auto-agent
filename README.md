# auto-agent — Department Report Automation

Turns a daily departmental report email into structured data, dashboard
analytics, repeated/slow-task analysis and a management summary — with **no
daily copy-paste into a chatbot** and **no paid software**.

```
$ npm test
Loaded 14 Apps Script files
TOTAL: 86/86 passed
```

Everything here is built and tested, not proposed. The parser, normaliser,
deduplicator, metrics engine, report renderer and AI validation gate all run
under a local Node harness (`tools/run-tests.js`) that executes the **real**
Apps Script source — not a parallel test-only implementation.

---

## The pipeline

```
EMPLOYEE  →  DAILY REPORT EMAIL  →  GMAIL
                                      ↓ filter applies label DAILY_REPORT
                            AUTOMATIC REPORT DETECTION
                                      ↓
                              TABLE EXTRACTION          (HTML + plain text)
                                      ↓
                                 VALIDATION             bad rows → Data_Quality
                                      ↓
                               NORMALIZATION            status / name / date / department
                                      ↓
                            DUPLICATE DETECTION         deterministic fingerprints
                                      ↓
                          GOOGLE SHEETS DATABASE        Tasks + Reports + masters
                                      ↓
                            AUTOMATIC METRICS           daily/weekly/monthly/dept/employee
                                      ↓
             ┌────────────────────────┼────────────────────────┐
             ↓                        ↓                        ↓
      LOOKER STUDIO          REPEATED TASK ANALYSIS     SLOW TASK ANALYSIS
       (6 pages)              (4 classifications)     (only where measurable)
             └────────────────────────┼────────────────────────┘
                                      ↓
                          AI MANAGEMENT SUMMARY         optional, fact-checked
                                      ↓
                   DAILY / WEEKLY / MONTHLY REPORT      archived in AI_Reports
```

**The AI is a commentary layer only. Every number is computed by code.** Turn
the AI off — it ships off — and the dashboard, metrics, repeat analysis, slow-task
analysis and the written report all still work.

---

## Cost

| Layer | Tool | Cost |
|---|---|---|
| Ingestion + automation | Google Apps Script | free |
| Database | Google Sheets | free |
| Dashboard | Looker Studio | free |
| Email | your existing Gmail | already paid for |
| AI commentary | `manual` (paste into any free chatbot) | free, no account |
| AI commentary | Gemini free tier, or a self-hosted model | free tier / your hardware |

No Zapier, Make, Airtable, Monday, Power BI, paid database, server or hosting.
The honest caveat: any third-party free AI tier can change at any time — which
is exactly why the AI layer is optional and defaults to `manual`.

---

## Repository layout

```
src/                 the Next.js app (at the repository ROOT, so any Vercel
                     project pointed at this repo builds with no Root Directory
                     setting to configure)
supabase/            schema.sql + ordered, idempotent migrations
tests/               parity, database, sync, isolation, auth, attachments
scripts/             seed, deploy finisher, production acceptance test
apps-script/         paste these 14 files into the Apps Script editor
  00_Config.gs       all configuration (code defaults + Config sheet overrides)
  01_Schema.gs       every sheet and column, in one place
  02_Setup.gs        one-click database creation + master seeding
  03_Utils.gs        batch sheet I/O, logging, hashing, dates, normalisation
  04_Gmail.gs        Gmail transport: search, detection rules, labels
  05_HtmlTable.gs    tolerant HTML + plain-text table extraction
  06_Ingest.gs       document → database pipeline (idempotent)
  07_Analysis.gs     repeated-task + slow-task detection (no AI)
  08_Metrics.gs      daily/weekly/monthly/department/employee summaries
  09_AI.gs           dataset builder, prompts, providers, validation gate
  10_Reports.gs      report rendering + archive + manual AI mode
  11_Triggers.gs     automation schedule and locking
  12_Menu.gs         spreadsheet menu + System Status
  13_Tests.gs        self-tests, 15 email fixtures, sample-data loader
  appsscript.json    manifest + OAuth scopes

sample-data/         CSVs produced by the real pipeline + the Monday demo email
test-emails/         15 ready-to-send fixtures covering every edge case
tools/               Node harness that runs the Apps Script code locally
docs/                architecture, setup, Gmail, schema, dashboard, AI, tests,
                     troubleshooting, demo script, web app, deployment
```

## The product flow (hosted app)

```
Manager opens the app → Continue with Google → read-only Gmail consent → done
        ↓  everything below is automatic, on a schedule
  reads their inbox → detects reports by CONTENT, not labels
  → parses email bodies and xlsx / xlsm / csv / tsv attachments
  → normalises, validates, identifies department + employee, deduplicates
  → Postgres → dashboard → repeated/slow analysis → AI management summary
```

After that one consent there is **no daily manual work**: no labels, no
forwarding, no uploads, no copy-paste, no scripts, no "process" button, no
database URLs. Departments keep emailing reports exactly as they do today.

Each signed-in Google account is its own workspace — one manager cannot see
another's mailbox data ([docs/SECURITY.md](docs/SECURITY.md)).

Google OAuth setup and deployment are one-time administrator jobs:
[docs/GOOGLE_OAUTH_SETUP.md](docs/GOOGLE_OAUTH_SETUP.md),
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Management views and charts

`/management` gives Daily, Weekly and Monthly views with filters for department,
employee and date range, and ten charts drawn as inline SVG in server
components — no charting library, nothing to pay for, no client bundle:

| | |
|---|---|
| Trends | task volume, completed vs backlog, completion-rate trend, backlog trend |
| Departments | volume by department (stacked), completion rate by department, status donut |
| People | employee activity — labelled *reported activity*, never "productivity" |
| Attention | slow tasks by overrun, repeated-task groups by frequency |

Every chart has tooltips, readable axes and an explicit empty state that says
*why* it is empty — a single day cannot draw a trend, and slow-task analysis
needs timestamps that most reports do not carry.

## Two front ends, one engine

| | `apps-script/` | the repository root |
|---|---|---|
| Database | Google Sheets | Postgres (Supabase) |
| Dashboard | Looker Studio | built-in pages |
| Cost | free | free tiers; Anthropic billed per call |
| Gmail ingestion | needs a label, `gmail.modify` | **OAuth, read-only, automatic** |
| Attachments | not parsed | xlsx / csv parsed |

The web app is a **direct port**, and `tests/parity.test.ts` proves it by
running both implementations over the same 14 fixtures and comparing every
field of every record — including the duplicate fingerprint. Start with the
Sheets version if cost matters most; add the web app for a nicer experience.
See [docs/WEB_APP.md](docs/WEB_APP.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Quick start

```bash
npm test          # 86 Apps Script checks, no Google account needed
npm run export-fixtures   # regenerate sample-data/ and test-emails/ from the code
```

Running it day to day: **[docs/OPERATIONS.md](docs/OPERATIONS.md)** — schedules, limits,
backup and recovery, and where to look when something is wrong.

To put it in Google (about 30 minutes): follow **[docs/SETUP.md](docs/SETUP.md)**,
then **[docs/REAL_GMAIL_SETUP.md](docs/REAL_GMAIL_SETUP.md)**.
For Monday: **[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)**.

---

## What is guaranteed, and what backs it

| Guarantee | Mechanism | Test |
|---|---|---|
| Running twice never duplicates | `Task_Fingerprint` = hash(Date+Employee+Department+Task+Status+occurrence#) plus `Source_Email_ID` ownership | `IDEMPOTENT: run 2 inserts 0 rows` |
| Protection survives losing the email record | fingerprints live in `Tasks`, not in a Gmail label | `IDEMPOTENT: fingerprints alone stop re-insertion` |
| A re-sent email is caught | same fingerprint, different owning email → `DUPLICATE_ACROSS_EMAILS` | `DUPLICATE: same rows re-sent…` |
| Two genuine identical tasks are both kept | occurrence ordinal is part of the fingerprint | `T7 legitimate same-day repeats are ALL kept` |
| One bad row never kills an email | per-row validation; rejects go to `Data_Quality` with a reason | `T4`, `T8`, `T9` |
| `Fwd:` / `FW:` / `Re:` are not departments | subject scan matches only *existing* departments | `"FW:" and "Re:" prefixes are also ignored` |
| No invented durations | needs real timestamps or a reported hours column, else `INSUFFICIENT_DATA` | `slow-task flag uses INSUFFICIENT_DATA…` |
| No invented AI facts | AI output schema-checked **and** cross-checked against the dataset | `AI validation rejects an invented department` |
| Percentage points ≠ percentages | `ppChange_()` and explicit wording everywhere | `percentage points are not percentages` |

---

## Honest limitations

1. **One manual setup step remains.** A Gmail filter must be created once so
   report emails get the `DAILY_REPORT` label automatically. That is a 60-second
   job, documented click-by-click. After it, ingestion is unattended.
2. **The five default fields cannot measure productivity.** `Date, Employee,
   Task, Status, Link` support volume, status mix, department/employee activity
   and repeat detection. They cannot support duration or efficiency. The parser
   already accepts `Start Time`, `Completion Time`, `Expected Duration`,
   `Task Category` and `Priority` — the day teams send those, slow-task analysis
   switches on with no code change. Until then every task honestly reads
   `INSUFFICIENT_DATA`.
3. **Task counts are activity, not value.** `Employee_Summary` carries a
   `Data_Sufficiency` column and the AI is forbidden from ranking people.
4. **Apps Script quotas.** 6 minutes per execution, ~90 minutes/day on consumer
   Gmail. This system uses a few seconds per email; a 30-minute trigger over 50
   emails per run is well inside the limits.
5. **Near-duplicate task matching is deliberately conservative.** "Prepare daily
   report" and "Prepare daily MIS report" stay separate groups. Semantic
   matching is future work.
6. **No live Looker Studio dashboard is included** — building one requires
   access to your Google account. `docs/LOOKER_STUDIO.md` is a complete
   build specification: every page, chart, filter, metric and calculated field.

---

## Security

- No secrets in this repository, and none required to run the tests.
- The optional AI key lives in Apps Script `PropertiesService`, set via
  `setApiKey()` — never in code, never in a cell, never in the Config sheet.
- `.gitignore` covers `.env`, key files and clasp config. See `.env.example`.
