# Operating this on a free plan

Everything here assumes the free tiers the product is built for: Vercel Hobby,
Supabase Free, Gmail API, and a paid Anthropic key that should be spent
sparingly. Nothing below needs a service you are not already paying nothing for.

## What runs on its own

| | |
|---|---|
| Automatic inbox check | once a day, 03:00 UTC (`vercel.json` cron) |
| Immediate check | **Sync now** on the Inbox page, any time |
| Analysis rebuild | after every sync that imported something |
| AI commentary | when the figures change, not on every request |

Daily is the ceiling on a Hobby plan — Vercel rejects a tighter cron at deploy
time, so a config claiming hourly would not deploy at all. `vercel.pro.json.example`
holds the hourly schedule for a Pro plan; nothing else changes.

## Bounds that keep the free tiers free

| Bound | Default | Environment variable |
|---|---|---|
| Messages read per sync | 60 | `MAX_MESSAGES_PER_SYNC` |
| Largest attachment fetched | 8 MB | `MAX_ATTACHMENT_BYTES` |
| Google Sheet links followed per message | 3 | `MAX_SHEET_LINKS` |
| Gmail request timeout | 20 s | `GMAIL_TIMEOUT_MS` |
| Gmail attempts per request | 3 | `GMAIL_MAX_ATTEMPTS` |
| Syncs per user per minute | 10 | `RATE_LIMIT_SYNC` |
| Report generations per user per minute | 10 | `RATE_LIMIT_REPORT` |
| Sign-in attempts per address per minute | 10 | `RATE_LIMIT_LOGIN` |

Raw email bodies are never stored. `documents` keeps the subject, sender,
counts and the Gmail message id — enough to prove what happened and to avoid
re-reading a message, without the database growing with the mailbox.

The AI is sent a computed dataset, never email contents, and the dataset is
fingerprinted: an unchanged period reuses the stored commentary instead of
paying for an identical one. **Rewrite commentary** forces a fresh call when
you want one.

## What counts as a report

Nothing about the format is fixed. A message becomes a report when its content
says so, whatever the subject line, the file type, or the column names.

| | |
|---|---|
| Read from | the email body, an attached spreadsheet or CSV/TSV, or a linked Google Sheet |
| Formats | HTML tables, plain-text tables, XLSX, XLSM, CSV, TSV, Google Sheets |
| Subjects | irrelevant &mdash; "FYI", "Monday", "Fwd: Hi" and no subject all work |
| Column names | read for meaning: "Work Done Today", "Staff Member", "Current State", "Reporting Dt", "Emp Nm", and the same words in Spanish, German or French |
| Column order | irrelevant |
| Structure | title rows, two-row headers, blank rows, summary rows and several tables in one message are all handled |
| Employees | from an employee column, or from the sender when the report has none |
| Departments | from a column, the sender's domain, or the employee roster &mdash; never guessed into a default |
| Work streams | yesterday's work, today's work and tomorrow's plan are kept apart; plans never count as work done |

Every message ends with one of four outcomes, visible on **Data quality**:

| Outcome | Meaning |
|---|---|
| Processed | became tasks |
| Not a report | read, judged, and finished with &mdash; a newsletter, an invoice, an unrelated spreadsheet |
| Format not readable | a PDF or Word document; send a spreadsheet, a table in the email, or a Google Sheet link |
| Needs a look | something here is a report and could not be read &mdash; a screenshot, an unshared sheet, a corrupt file |

Nothing is skipped in silence. A screenshot of a table is *not* read
automatically: guessing figures from pixels is how wrong numbers enter a
management report, so it asks for the underlying file instead.

## Reports that arrive as a link

A department that keeps its report in a Google Sheet pastes the link rather
than attaching a file. Those messages are followed: the sheet's own CSV export
is read directly, which needs **no extra Google permission** — no Drive scope,
no re-consent, no verification review.

The one requirement is on the sender's side: the sheet must be shared as
**Anyone with the link can view**. A restricted sheet appears on Data quality
as `SHEET_NOT_SHARED`, naming the sheet and the fix, because only its owner can
change that.

A sheet with no Employee column is attributed to whoever sent the email — one
person's own report does not repeat their name on every line. A sheet that
*does* have an Employee column and leaves a cell blank is still rejected as a
malformed row; guessing there would put somebody else's work under the
sender's name.

## Backup and recovery

Supabase Free has no point-in-time recovery, so the recovery story is built out
of what can be reconstructed and what cannot:

| Data | If the database is lost |
|---|---|
| Schema and views | `supabase/schema.sql` + `supabase/migrations/` — reapplied from the Inbox page |
| Master data | reseeded automatically by the same step |
| Tasks and rejections | restore from an export, or re-read from Gmail |
| Repeat groups, slow-task flags | recomputed by **Rebuild analysis** — never restored |
| Gmail grant | reconnect the inbox; tokens are deliberately not exportable |

Take an export from **Sync health → Keep a copy**:

- `/api/export?format=json` — tasks, rejections, import history, master data
- `/api/export?format=csv` — the task rows, for a spreadsheet

Both are scoped to the signed-in user and contain no tokens or secrets.

**Restore order:** schema and migrations, then master data, then tasks, then
data quality, then **Rebuild analysis**, then reconnect Gmail.

Weekly is a sensible cadence. Re-reading Gmail recovers anything newer than the
last export, as long as it is still inside the sync window.

## When something is wrong

Open **Sync health**. It shows the running build's commit, the database and
Gmail state, the last successful and last failed sync, and the counts for
everything scanned, imported, rejected and de-duplicated.

| Symptom | Where to look |
|---|---|
| A report arrived but no tasks appeared | **Data quality** — the row or the file is listed with a reason |
| A spreadsheet was ignored | **Data quality** — too large, unreadable, or not a report, by filename |
| A linked Google Sheet was ignored | **Data quality** — usually `SHEET_NOT_SHARED`: the sender must set sharing to "Anyone with the link can view" |
| "Reconnect Gmail" | the grant was revoked in the Google account; reconnect on the Inbox page |
| Dashboard shows an error banner | the database was briefly unreachable; imported data is unaffected |
| No AI commentary | the report is still complete; only the commentary degrades |
| A pending database update banner | press **Apply database update**; it is safe to repeat |

## What is deliberately not here

No Redis, no queue, no external scheduler, no monitoring service. The expensive
operations are already serialised per user and bounded per sync; adding
infrastructure would add cost and another thing to be down.
