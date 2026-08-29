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
-- NOTE ON TYPES: count(*) is bigint, which node-postgres returns as a STRING
-- to avoid silent precision loss. Every count below is cast to int so the
-- application gets numbers and dashboard arithmetic cannot become string
-- concatenation. numeric columns (rates, durations) are still strings by the
-- same rule and are converted explicitly in src/lib/db.ts.
-- Rates are always computed from summed counts. Averaging stored rates across
-- groups of different sizes is the classic way this kind of dashboard lies.

-- A grouping set gives us the per-department rows AND a department='ALL'
-- roll-up in one pass. GROUPING() is what distinguishes "this is the roll-up
-- row" from "this task genuinely has no department" — without it the roll-up
-- silently masquerades as a real department and every total double-counts.
create or replace view daily_summary as
select
  t.task_date                                   as period_start,
  case when grouping(t.department) = 1 then 'ALL'
       else coalesce(t.department, 'Unassigned') end as department,
  count(*)::int                                 as total_tasks,
  count(*) filter (where t.task_status = 'Completed')::int   as completed,
  count(*) filter (where t.task_status = 'In Progress')::int as in_progress,
  count(*) filter (where t.task_status = 'Pending')::int     as pending,
  count(*) filter (where t.task_status = 'Blocked')::int     as blocked,
  count(*) filter (where t.task_status = 'Cancelled')::int   as cancelled,
  count(*) filter (where t.task_status = 'Not Started')::int as not_started,
  round(100.0 * count(*) filter (where t.task_status = 'Completed')
        / nullif(count(*), 0), 1)               as completion_rate,
  count(*) filter (where t.slow_task_flag = 'TRUE')::int     as slow_tasks,
  count(*) filter (where t.repeated_task_flag)::int          as repeated_tasks,
  count(distinct t.employee_name)::int          as employees_reporting
from tasks t
group by grouping sets ((t.task_date, t.department), (t.task_date));

create or replace view weekly_summary as
select
  date_trunc('week', t.task_date)::date         as period_start,
  (date_trunc('week', t.task_date)::date + 6)   as period_end,
  case when grouping(t.department) = 1 then 'ALL'
       else coalesce(t.department, 'Unassigned') end as department,
  count(*)::int                                 as total_tasks,
  count(*) filter (where t.task_status = 'Completed')::int   as completed,
  count(*) filter (where t.task_status = 'Pending')::int     as pending,
  round(100.0 * count(*) filter (where t.task_status = 'Completed')
        / nullif(count(*), 0), 1)               as completion_rate,
  count(*) filter (where t.slow_task_flag = 'TRUE')::int     as slow_tasks,
  count(*) filter (where t.repeated_task_flag)::int          as repeated_tasks,
  count(distinct t.employee_name)::int          as employees_reporting
from tasks t
group by grouping sets ((date_trunc('week', t.task_date), t.department),
                        (date_trunc('week', t.task_date)));

create or replace view monthly_summary as
select
  date_trunc('month', t.task_date)::date        as period_start,
  to_char(t.task_date, 'YYYY-MM')                as month_label,
  case when grouping(t.department) = 1 then 'ALL'
       else coalesce(t.department, 'Unassigned') end as department,
  count(*)::int                                 as total_tasks,
  count(*) filter (where t.task_status = 'Completed')::int   as completed,
  count(*) filter (where t.task_status = 'Pending')::int     as pending,
  round(100.0 * count(*) filter (where t.task_status = 'Completed')
        / nullif(count(*), 0), 1)               as completion_rate,
  count(*) filter (where t.slow_task_flag = 'TRUE')::int     as slow_tasks,
  count(*) filter (where t.repeated_task_flag)::int          as repeated_tasks,
  count(distinct t.employee_name)::int          as employees_reporting
from tasks t
group by grouping sets ((date_trunc('month', t.task_date), to_char(t.task_date, 'YYYY-MM'), t.department),
                        (date_trunc('month', t.task_date), to_char(t.task_date, 'YYYY-MM')));

create or replace view department_summary as
select
  coalesce(t.department, 'Unassigned')          as department,
  count(*)::int                                 as total_tasks,
  count(*) filter (where t.task_status = 'Completed')::int   as completed,
  count(*) filter (where t.task_status = 'In Progress')::int as in_progress,
  count(*) filter (where t.task_status = 'Pending')::int     as pending,
  count(*) filter (where t.task_status = 'Blocked')::int     as blocked,
  round(100.0 * count(*) filter (where t.task_status = 'Completed')
        / nullif(count(*), 0), 1)               as completion_rate,
  count(*) filter (where t.slow_task_flag = 'TRUE')::int     as slow_tasks,
  count(*) filter (where t.repeated_task_flag)::int          as repeated_tasks,
  count(distinct t.employee_name)::int          as employees_reporting,
  min(t.task_date)                              as first_date,
  max(t.task_date)                              as last_date
from tasks t
group by coalesce(t.department, 'Unassigned');

create or replace view employee_summary as
select
  t.employee_name                               as employee,
  max(t.department)                             as department,
  count(*)::int                                 as total_tasks,
  count(*) filter (where t.task_status = 'Completed')::int   as completed,
  count(*) filter (where t.task_status = 'Pending')::int     as pending,
  round(100.0 * count(*) filter (where t.task_status = 'Completed')
        / nullif(count(*), 0), 1)               as completion_rate,
  count(*) filter (where t.slow_task_flag = 'TRUE')::int     as slow_tasks,
  count(*) filter (where t.repeated_task_flag)::int          as repeated_tasks,
  count(distinct t.task_date)::int              as distinct_days_reported,
  -- Honest label: task counts measure reported ACTIVITY, not value.
  case
    when count(*) >= 30 and count(distinct t.task_date) >= 10 then 'Sufficient for trend'
    when count(*) >= 10 then 'Indicative only'
    else 'Insufficient — do not rank'
  end                                           as data_sufficiency
from tasks t
group by t.employee_name;

create or replace view slow_tasks as
select task_id, task_date, department, employee_name as employee, task,
       task_category, task_status, expected_duration, actual_duration,
       slow_variance_hours as variance_hours,
       round(100.0 * slow_variance_hours / nullif(expected_duration, 0), 1) as variance_pct,
       duration_basis, link
from tasks
where slow_task_flag = 'TRUE'
order by slow_variance_hours desc;

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
