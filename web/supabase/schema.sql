-- =============================================================================
-- auto-agent — Postgres / Supabase schema
-- =============================================================================
-- Apply by pasting into the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -f supabase/schema.sql
--
-- Safe to re-run: everything is IF NOT EXISTS / CREATE OR REPLACE, and no
-- statement destroys data.
-- =============================================================================

-- ---------------------------------------------------------------- masters ---
create table if not exists departments (
  department_id   text primary key,
  department_name text not null unique,
  name_aliases    text[] not null default '{}',
  manager         text,
  manager_email   text,
  sender_domains  text[] not null default '{}',
  active          boolean not null default true
);

create table if not exists employees (
  employee_id   text primary key,
  employee_name text not null,
  name_aliases  text[] not null default '{}',
  department    text,
  active        boolean not null default true,
  joining_date  date,
  role          text,
  email         text
);
create unique index if not exists uq_employee_name on employees (lower(employee_name));

create table if not exists task_categories (
  category_id       text primary key,
  category_name     text not null unique,
  match_keywords    text[] not null default '{}',
  -- HOURS. NULL means "nobody has stated an expectation" and must never be
  -- coerced to 0 — that would make every task infinitely slow.
  expected_duration numeric,
  active            boolean not null default true,
  notes             text
);

create table if not exists statuses (
  status              text primary key,
  active              boolean not null default true,
  counts_as_completed boolean not null default false,
  is_terminal         boolean not null default false,
  sort_order          int not null default 0
);

create table if not exists status_aliases (
  alias            text primary key,
  canonical_status text not null references statuses(status)
);

create table if not exists header_aliases (
  alias           text primary key,
  canonical_field text not null
);

-- ------------------------------------------------------------- documents ---
-- One row per ingested document: an email, a pasted report, an upload.
create table if not exists documents (
  report_id               text primary key,
  document_id             text not null unique,
  source                  text not null default 'paste',   -- paste | email | upload | api
  subject                 text,
  sender                  text,
  sender_domain           text,
  department              text,
  report_date             date,
  received_at             timestamptz,
  processing_status       text not null,                   -- SUCCESS|PARTIAL|NO_DATA|FAILED
  tables_found            int not null default 0,
  rows_extracted          int not null default 0,
  rows_inserted           int not null default 0,
  rows_skipped_idempotent int not null default 0,
  rows_rejected           int not null default 0,
  error_message           text,
  processed_at            timestamptz not null default now()
);

-- ------------------------------------------------------------------ facts ---
create table if not exists tasks (
  task_id               text primary key,
  report_id             text references documents(report_id) on delete cascade,
  task_date             date not null,
  department            text,
  employee_name         text not null,
  employee_id           text,
  task                  text not null,
  task_normalized       text not null,
  task_category         text,
  task_status           text not null,
  priority              text,
  start_date            date,
  start_time            time,
  completion_date       date,
  completion_time       time,
  expected_duration     numeric,
  actual_duration       numeric,
  duration_basis        text not null default 'Insufficient Data',
  link                  text,
  source_document_id    text not null,
  source_document_date  timestamptz,
  imported_at           timestamptz not null default now(),
  data_quality_status   text not null default 'OK',
  data_quality_notes    text,
  task_fingerprint      text not null,
  repeated_task_flag    boolean not null default false,
  repeat_classification text,
  slow_task_flag        text not null default 'INSUFFICIENT_DATA',
  slow_variance_hours   numeric,
  notes                 text,

  -- THE idempotency guarantee, enforced by the database rather than by code.
  -- The fingerprint already contains an occurrence ordinal, so two genuine
  -- identical tasks in one report are distinct rows, while a re-sent report
  -- collides and is rejected.
  constraint uq_task_fingerprint unique (task_fingerprint)
);

create index if not exists idx_tasks_date      on tasks (task_date);
create index if not exists idx_tasks_dept_date on tasks (department, task_date);
create index if not exists idx_tasks_emp_date  on tasks (employee_name, task_date);
create index if not exists idx_tasks_norm      on tasks (task_normalized);
create index if not exists idx_tasks_source    on tasks (source_document_id);

-- Nothing is silently dropped: every row that did not become a task is here.
create table if not exists data_quality (
  rejection_id      bigserial primary key,
  report_id         text,
  document_id       text,
  table_index       int,
  row_index         int,
  rejection_reason  text not null,
  rejection_detail  text,
  raw_row           jsonb not null default '{}'::jsonb,
  claimed_date      date,
  logged_at         timestamptz not null default now(),
  resolution_status text not null default 'Open'
);
create index if not exists idx_dq_reason on data_quality (rejection_reason);
create index if not exists idx_dq_date   on data_quality (claimed_date);

-- Rejections must be idempotent too. Without this, re-submitting an identical
-- report piles up duplicate rejection records and the Data Quality page
-- over-reports how much bad data arrived.
create unique index if not exists uq_dq_row
  on data_quality (document_id, table_index, row_index, rejection_reason);

-- Derived cache of repeat analysis. Rebuilt wholesale after every ingest —
-- a group's classification depends on the whole dataset, so incremental
-- updates would be wrong more often than they would be fast.
create table if not exists repeat_groups (
  repeat_key            text primary key,
  employee              text not null,
  department            text,
  task                  text not null,
  normalized_task       text not null,
  occurrence_count      int not null,
  distinct_dates        int not null,
  max_same_day_count    int not null,
  first_date            date,
  last_date             date,
  dates                 text[] not null default '{}',
  completed_count       int not null default 0,
  open_count            int not null default 0,
  classification        text not null,
  classification_reason text,
  updated_at            timestamptz not null default now()
);
create index if not exists idx_repeat_class on repeat_groups (classification);

create table if not exists ai_reports (
  report_id        text primary key,
  report_type      text not null,
  period_start     date not null,
  period_end       date not null,
  generated_at     timestamptz not null default now(),
  generator        text not null,
  model            text,
  status           text not null,
  summary          text,
  human_report     text,
  dataset_json     jsonb,
  ai_json          jsonb,
  validation_error text
);

create table if not exists system_log (
  id         bigserial primary key,
  ts         timestamptz not null default now(),
  level      text not null default 'INFO',
  component  text,
  action     text,
  status     text,
  message    text,
  document_id text,
  report_id  text,
  details    jsonb
);
create index if not exists idx_log_ts on system_log (ts desc);

-- ---------------------------------------------------------------- views -----
-- The reporting views live in supabase/migrations/002_owner_scoped_views.sql,
-- because they must carry owner_user_id and CREATE OR REPLACE cannot add a
-- leading column. Keeping one definition avoids the base schema and the
-- migration fighting each other on every re-run.

-- ------------------------------------------------------------------ RLS -----
-- Every table is locked by default. The application connects with the service
-- role key SERVER-SIDE ONLY, which bypasses RLS; no anon client ever reads
-- these tables directly, so a leaked anon key exposes nothing.
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'departments','employees','task_categories','statuses','status_aliases',
    'header_aliases','documents','tasks','data_quality','repeat_groups',
    'ai_reports','system_log'
  ] loop
    execute format('alter table %I enable row level security', tbl);
  end loop;
end $$;

-- =============================================================================
-- GMAIL CONNECTION (product flow: the manager connects their own inbox)
-- =============================================================================
-- One row per connected Google account. The refresh token is stored encrypted
-- with AES-256-GCM (see src/lib/crypto.ts); the key lives only in the
-- environment, so a database dump alone cannot read anyone's mailbox.
create table if not exists gmail_accounts (
  id                  bigserial primary key,
  email               text not null unique,
  google_sub          text not null unique,       -- stable Google user id
  display_name        text,
  picture_url         text,
  refresh_token_enc   text not null,              -- AES-256-GCM, never plaintext
  scopes              text[] not null default '{}',
  connected_at        timestamptz not null default now(),
  last_sync_at        timestamptz,
  last_sync_status    text,
  last_sync_message   text,
  -- Only mail newer than this is considered, so connecting an old mailbox does
  -- not drag in years of history on the first run.
  sync_since          date not null default (current_date - 14),
  active              boolean not null default true,
  revoked_at          timestamptz
);

-- One row per sync attempt, so the dashboard can show what the assistant did
-- without anyone reading logs.
create table if not exists sync_runs (
  id                bigserial primary key,
  gmail_account_id  bigint references gmail_accounts(id) on delete cascade,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  trigger           text not null default 'cron',   -- cron | manual | connect
  status            text not null default 'RUNNING',-- RUNNING|OK|PARTIAL|FAILED
  messages_scanned  int not null default 0,
  reports_found     int not null default 0,
  rows_imported     int not null default 0,
  rows_rejected     int not null default 0,
  rows_duplicate    int not null default 0,
  error_message     text
);
create index if not exists idx_sync_runs_started on sync_runs (started_at desc);

-- Which Gmail message produced which document, and what it looked like. Every
-- scanned message gets a row even when it is not a report, so the next sync
-- never re-downloads or re-parses it.
alter table documents add column if not exists gmail_account_id bigint;
alter table documents add column if not exists gmail_message_id text;
alter table documents add column if not exists attachment_name text;
create index if not exists idx_documents_gmail on documents (gmail_message_id);

do $$
begin
  execute 'alter table gmail_accounts enable row level security';
  execute 'alter table sync_runs enable row level security';
end $$;


-- =============================================================================
-- Migrations are applied after the base schema by scripts/seed.ts, in order.
-- See supabase/migrations/. Everything is idempotent, so applying the base
-- schema and every migration on each deploy is the intended operation.
-- =============================================================================
