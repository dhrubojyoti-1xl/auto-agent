# Supabase / Postgres setup

The app talks to Postgres over a connection string, so it runs against Supabase,
any managed Postgres, or a local server unchanged.

## 1. Create the database

Supabase → **New project**. Note the database password you set.

## 2. Get the connection string

**Project Settings → Database → Connection pooling → Connection string (URI)**

Use the **pooler** — port `6543`, host containing `pooler.supabase.com`.

> Not the direct connection on 5432. Vercel runs every request in its own
> isolate and exhausts a direct pool within minutes.

## 3. Apply the schema

Either paste `supabase/schema.sql` then each file in
`supabase/migrations/` (in filename order) into the Supabase SQL editor, or
run both in one step from your machine:

```bash
DATABASE_URL="<pooler string>" npm run seed
```

That applies the base schema, applies every migration in order, and seeds the
master data (6 statuses, ~50 status aliases, ~80 header aliases, departments,
task categories). Everything is idempotent — running it on every deploy is the
intended operation.

Add `-- --demo` to also insert ten demo employees. **Do not** on a production
database; add your real roster instead.

## 4. Verify

```bash
psql "<pooler string>" -c "select count(*) from statuses;"        # 6
psql "<pooler string>" -c "select count(*) from header_aliases;"  # ~83
```

## Schema at a glance

| Table | Holds |
|---|---|
| `users` | one row per signed-in identity (Google, plus the local fallback) |
| `gmail_accounts` | connected inboxes; refresh token AES-256-GCM encrypted |
| `sync_runs` | one row per sync attempt — what Sync health displays |
| `documents` | one row per Gmail message examined, including the ones ignored |
| `tasks` | the fact table |
| `data_quality` | every row that did not become a task, with a reason |
| `repeat_groups` | derived repeat classification |
| `ai_reports` | generated management summaries |
| `system_log` | events |
| `departments`, `employees`, `task_categories`, `statuses`, `status_aliases`, `header_aliases` | master data |

Views: `daily_summary`, `weekly_summary`, `monthly_summary`,
`department_summary`, `employee_summary`, `slow_tasks` — all carrying
`owner_user_id`.

## Two design points

**Uniqueness is per user.**

```sql
unique (owner_user_id, task_fingerprint)
```

The same report in two managers' mailboxes is two independent facts. A global
constraint would silently delete one of them.

**Counts are cast `::int` in the views.** `count(*)` is `bigint`, which
node-postgres returns as a *string* to avoid precision loss — uncast, `"14" + "3"`
renders as `"143"` on a dashboard.

## Row-level security

RLS is enabled on every table. The application connects server-side with a
privileged connection string, and no browser ever talks to Postgres directly, so
a leaked anon key exposes nothing.
