# The hosted web app (Next.js + Supabase + Anthropic)

A second front end over the **same tested engine**. The Apps Script system
remains complete on its own; this adds a hosted dashboard, a real database, and
an API the Gmail automation can post to.

```
$ cd web && npm test
72 passed (51 parity + 13 database + 8 auth)
```

---

## 1. Why it exists, and what it does not change

| | Apps Script version | Web app |
|---|---|---|
| Database | Google Sheets | Postgres (Supabase) |
| Dashboard | Looker Studio | built-in pages |
| Ingestion | Gmail, directly | pasted reports **and** Gmail via the bridge |
| Cost | free | free tiers; Anthropic is paid per call |
| Duplicate protection | fingerprint in the sheet | fingerprint **plus a database unique constraint** |
| AI | optional, off by default | optional, off by default |

The parsing, normalisation, validation, deduplication, repeat classification,
slow-task detection, metrics and report rendering are a **direct port** of the
Apps Script engine — and `web/tests/parity.test.ts` proves it, by running both
implementations over the same 14 fixtures and comparing every field of every
record, including the duplicate fingerprint. If the two ever diverge, that test
fails.

## 2. Architecture

```
                    ┌──────────────────────────────┐
  Gmail  ──────────►│ Apps Script (14_Bridge.gs)   │  only Google can read Gmail
                    └──────────────┬───────────────┘
                                   │ HTTPS POST, bearer token
                                   ▼
  paste ──────────► ┌──────────────────────────────┐
                    │ Next.js on Vercel            │
                    │  /api/preview  parse only    │
                    │  /api/commit   write         │
                    │  /api/ingest   machine auth  │
                    │  /api/report   AI + validate │
                    └──────────────┬───────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │ Supabase Postgres            │
                    │  unique(task_fingerprint)    │
                    └──────────────────────────────┘
```

**Two separate credentials, on purpose.** The human session (password + signed
HttpOnly cookie) reads the dashboard. The ingest token only writes reports. A
leaked ingest token cannot read anything.

## 3. Layout

```
web/
  src/lib/core/        the ported engine — pure, no I/O, no network, no clock
    types.ts           shared types and the default engine config
    normalize.ts       dates, times, statuses, names, departments, task similarity
    html-table.ts      tolerant HTML + plain-text table extraction
    ingest.ts          validate -> fingerprint -> dedupe
    analysis.ts        repeat classification, slow-task detection
    metrics.ts         daily/weekly/monthly/department/employee aggregation
    ai.ts              dataset builder, prompt, and the validation gate
    report.ts          report rendering with a deterministic fallback
  src/lib/
    db.ts              Postgres access (works against Supabase and locally)
    pipeline.ts        orchestration: preview / commit / rebuild
    reporting.ts       Anthropic call + validation + archive
    auth.ts            password, signed cookie, ingest token
    seed.ts            canonical master data (asserted equal to Apps Script)
    seed-db.ts         idempotent seeding
  src/app/             pages and API routes
  src/middleware.ts    session gate (MUST live in src/ — see below)
  supabase/schema.sql  12 tables, 6 views, RLS on everything
  tests/               parity, database, auth
```

## 4. The database

`supabase/schema.sql` is idempotent and safe to re-run.

The line that matters most:

```sql
constraint uq_task_fingerprint unique (task_fingerprint)
```

The application already refuses duplicates, so this is the backstop: even two
concurrent requests carrying the same report cannot produce a duplicate row.
Inserts use `on conflict (task_fingerprint) do nothing`, so a retry is a no-op
rather than an error.

Rejections have their own uniqueness rule:

```sql
create unique index uq_dq_row
  on data_quality (document_id, table_index, row_index, rejection_reason);
```

Re-submitting an identical report must not pile up duplicate rejection records.
This is also why every duplicate rejection carries the **original** row
position rather than a placeholder — logging them all at the same position
would let this index silently merge fourteen rejections into one.

### Views

`daily_summary`, `weekly_summary`, `monthly_summary`, `department_summary`,
`employee_summary`, `slow_tasks`.

Two details that keep them honest:

- Every count is cast `::int`. `count(*)` is `bigint`, which node-postgres
  returns as a **string** to avoid precision loss — uncast, `"14" + "3"` renders
  as `"143"` in a dashboard.
- The period views use `grouping sets` with `grouping(department)` to label the
  roll-up row `'ALL'`. Without that test, the roll-up masquerades as a real
  department and every total double-counts.

Rates are always `sum(completed) / sum(total)`, never an average of stored
rates. Averaging a 100%-of-1 department with a 50%-of-40 department gives 75%,
which is wrong.

## 5. Security

| Control | Implementation |
|---|---|
| Password | `APP_PASSWORD`, compared as HMACs in constant time so neither the value nor its length leaks through timing |
| Session | HMAC-signed token in an **HttpOnly, SameSite=Lax** cookie, `Secure` in production, 7-day expiry. Never in localStorage, never in a URL |
| Page access | `src/middleware.ts` redirects to `/login` |
| API access | every private route re-verifies the signature itself — middleware runs on the edge runtime, where `node:crypto` is unavailable, so it can only check the cookie's shape |
| Machine ingest | separate bearer token, write-only in effect |
| Database | RLS enabled on every table; the app connects server-side with the pooler string; no browser ever talks to Postgres |
| Secrets | environment variables only; `.env.local` is gitignored; nothing secret is in the repository |

> **The `src/middleware.ts` location is load-bearing.** With a `src/` directory,
> Next.js ignores a `middleware.ts` at the project root — silently. During this
> build that left every dashboard page publicly readable until an unauthenticated
> `curl /` returned 200 instead of a redirect. `tests/auth.test.ts` now asserts
> the file is in `src/` and not at the root.

## 6. The AI layer

Identical contract to the Apps Script version, and off unless
`ANTHROPIC_API_KEY` is set.

1. Every number is computed **before** the model is called.
2. The model receives a JSON dataset and returns commentary only.
3. `validateAiJson()` drops any claim the dataset cannot support — unknown
   departments, unknown task ids, an impossible completion rate — and the report
   footer names what was removed.
4. On failure the report is still produced from the deterministic layer, and
   says so.

Model is configurable via `ANTHROPIC_MODEL` (default `claude-sonnet-5`).

## 7. Running it locally

```bash
cd web
cp .env.example .env.local          # then fill in the values
createdb autoagent_dev
DATABASE_URL=postgres://localhost/autoagent_dev npm run seed -- --demo
npm run dev                          # http://localhost:3210
```

Tests:

```bash
npm test                                                   # parity + auth
createdb autoagent_test
TEST_DATABASE_URL=postgres://localhost/autoagent_test npm test   # + database
```

## 8. Connecting Gmail

The web app cannot read Gmail — only Google can, and only after you grant
consent. Rather than authorising a second application, the Apps Script project
you have already authorised forwards each report:

1. Web app: set `INGEST_TOKEN` (any long random string).
2. Sheet: **Department Reporting → Web app bridge → Store ingest token**.
3. Config sheet: `BRIDGE_ENABLED = TRUE`,
   `BRIDGE_URL = https://<your-app>.vercel.app/api/ingest`.
4. **Web app bridge → Test bridge connection.**
5. Leave `BRIDGE_ONLY = FALSE` to write to both, or set it `TRUE` to make the
   web app the only database.

Idempotency holds across the whole chain: the Gmail message id is the document
id, so a re-forwarded email inserts nothing.

## 9. What this does not do

- **It does not remove the Google consent step.** Reading a Gmail inbox requires
  it, whichever front end you use.
- **It is not free the way the Sheets version is.** Supabase and Vercel have
  free tiers; Anthropic bills per call. The AI stays optional for that reason.
- **It still cannot measure productivity** from `Date, Employee, Task, Status,
  Link`. The slow-task page states how many tasks could not be measured at all,
  rather than quietly implying everything else was on time.
