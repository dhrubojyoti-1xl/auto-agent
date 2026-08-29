# Architecture

## 1. The system

```
┌──────────────────────────────────────────────────────────────────────┐
│ Employees / departments — one report email per day                   │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
                        ┌───────────────┐
                        │ Gmail inbox   │  filter applies label DAILY_REPORT
                        └───────┬───────┘
                                ▼
        ┌───────────────────────────────────────────────┐
        │ 04_Gmail.gs + 06_Ingest.gs (every 30 min)     │
        │  search → detect → extract → validate →       │
        │  normalise → fingerprint → dedupe → commit    │
        └───────┬───────────────────────────────┬───────┘
                │ valid rows                    │ bad rows
                ▼                               ▼
        ┌───────────────┐               ┌────────────────┐
        │ Tasks         │               │ Data_Quality  │  reason + raw values
        │ (fact table)  │               └────────────────┘
        └───────┬───────┘               ┌────────────────┐
                │                       │ Reports        │  one row per email
                │                       │ System_Log     │  one row per event
                ▼                       └────────────────┘
        ┌───────────────────────────────────────────────┐
        │ 07_Analysis.gs — deterministic, no AI         │
        │  repeated-task grouping + classification      │
        │  slow-task detection (only where measurable)  │
        └───────────────────────┬───────────────────────┘
                                ▼
        ┌───────────────────────────────────────────────┐
        │ 08_Metrics.gs — flat, pre-aggregated tables   │
        │  Daily / Weekly / Monthly / Department /      │
        │  Employee summaries, each with an ALL row     │
        └───────┬───────────────────────────────┬───────┘
                ▼                               ▼
    ┌───────────────────────┐       ┌───────────────────────────────┐
    │ Looker Studio         │       │ 09_AI.gs — dataset builder    │
    │ 6-page dashboard      │       │  ↓ optional model call        │
    │ (reads summaries)     │       │  ↓ validate against dataset   │
    └───────────────────────┘       └───────────────┬───────────────┘
                                                    ▼
                                    ┌───────────────────────────────┐
                                    │ 10_Reports.gs                 │
                                    │  daily / weekly / monthly     │
                                    │  → AI_Reports archive         │
                                    │  → optional email to mgmt     │
                                    └───────────────────────────────┘
```

## 2. Component responsibilities

| File | Owns | Never does |
|---|---|---|
| `00_Config.gs` | every tunable value, and the Config-sheet override mechanism | hold secrets |
| `01_Schema.gs` | the physical shape of all 20 tabs | contain logic |
| `02_Setup.gs` | idempotent database creation and master seeding | delete transactional data without asking |
| `03_Utils.gs` | batch sheet I/O, buffered logging, hashing, tolerant date/time parsing, and `Masters` — canonical statuses, names, departments, categories, task similarity | know about tasks or emails |
| `04_Gmail.gs` | Gmail search, detection rules, labels, message → document | parse tables or validate rows |
| `05_HtmlTable.gs` | turning email HTML or plain text into a clean grid | interpret business meaning |
| `06_Ingest.gs` | the pipeline: detect → parse → validate → fingerprint → commit | compute metrics |
| `07_Analysis.gs` | repeat classification, slow-task flags | call an AI |
| `08_Metrics.gs` | aggregation into Looker-shaped tables | re-derive flags |
| `09_AI.gs` | the dataset, the prompts, the providers, the validation gate | count anything |
| `10_Reports.gs` | rendering, archiving, emailing | invent a fallback number |
| `11_Triggers.gs` | scheduling and locking | contain business logic |
| `12_Menu.gs` | the spreadsheet menu and System Status | contain business logic |
| `13_Tests.gs` | 80 tests, 15 email fixtures, and sample data pushed through the real pipeline | write to `Tasks` outside the pipeline |

## 3. The five design decisions that matter

**1. Gmail sits behind a document boundary.** `ingestDocument_({emailId, subject,
from, received, html, plain})` in `06_Ingest.gs` is the real entry point;
`04_Gmail.gs` is the only file that knows Gmail exists, and `processOneMessage_`
is a short adapter over a Gmail message. That is why the parser can be tested
without sending an email, why sample data exercises the production path, and why
a future Google Form or webhook input needs no changes downstream.

**2. Duplicate protection lives in the data, not in the labels.** A Gmail label
can be removed by a person. `Task_Fingerprint` plus `Source_Email_ID` cannot.
The ordinal inside the fingerprint is what lets the system tell a *re-sent
report* (reject) from *two genuine client calls* (keep both).

**3. Commit per email, not per run.** Tasks are written, then the `Reports` row,
then the label. Only a written `Reports` row makes an email terminal. A crash
therefore loses nothing and duplicates nothing: the retry finds its own rows
already present and skips them.

**4. Deterministic first, AI last.** Anything countable is computed by code
before a model is ever called. The model receives a JSON dataset and returns
commentary, which is then fact-checked against that same dataset. Disable the AI
and every number, flag and page still works.

**5. Missing data stays missing.** No expected duration means the task is never
judged slow. No timestamps means `INSUFFICIENT_DATA`, not a guess. Thin employee
samples carry `Insufficient — do not rank`. Rejected rows are counted in the
report so nobody mistakes a partial import for a complete one.

## 4. What runs when

| Trigger | Function | Work |
|---|---|---|
| every 30 min | `ingestTrigger` → `processIncomingReports()` | process new emails; rebuild metrics only if something changed |
| daily 09:10 | `dailyPipeline` | ingest → metrics → daily report |
| Monday 09:30 | `weeklyPipeline` | metrics → weekly report |
| daily 09:50 | `monthlyPipeline` | acts only on day 1; reports on the month that just ended |

All four take a script lock, so an overlapping execution exits cleanly rather
than double-writing.
