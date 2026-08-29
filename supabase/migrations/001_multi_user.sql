-- =============================================================================
-- Multi-user: "Continue with Google" is the identity, and every row belongs to
-- exactly one user.
-- =============================================================================
-- Before this, the app was single-tenant behind a shared password. One manager
-- must not see another's mailbox data, so ownership is carried on every table
-- rather than enforced only in the query layer — a missed WHERE clause then
-- fails closed at the database instead of leaking.
-- Idempotent; safe to re-run.
-- =============================================================================

create table if not exists users (
  id            bigserial primary key,
  google_sub    text unique,                      -- null for the local user
  email         text not null unique,
  display_name  text,
  picture_url   text,
  kind          text not null default 'google',   -- google | local
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- Fallback identity for APP_PASSWORD sign-in, so the app is usable before a
-- Google client is configured. It owns its data like any other user.
insert into users (id, email, display_name, kind)
values (1, 'local@localhost', 'Local admin', 'local')
on conflict (email) do nothing;
select setval(pg_get_serial_sequence('users','id'),
              greatest((select max(id) from users), 1));

do $$
declare t text;
begin
  foreach t in array array[
    'gmail_accounts','documents','tasks','data_quality',
    'repeat_groups','ai_reports','sync_runs'
  ] loop
    execute format(
      'alter table %I add column if not exists owner_user_id bigint references users(id) on delete cascade', t);
    execute format('update %I set owner_user_id = 1 where owner_user_id is null', t);
    execute format('alter table %I alter column owner_user_id set default 1', t);
    execute format('create index if not exists idx_%s_owner on %I (owner_user_id)', t, t);
  end loop;
end $$;

-- Uniqueness must be PER USER. Two managers can legitimately hold the same
-- report: the same fingerprint in two mailboxes is two independent facts, not
-- a duplicate. Scoping the constraint is what makes that true.
alter table tasks drop constraint if exists uq_task_fingerprint;
drop index if exists uq_task_fingerprint;
create unique index if not exists uq_task_fingerprint_owner
  on tasks (owner_user_id, task_fingerprint);

drop index if exists uq_dq_row;
create unique index if not exists uq_dq_row_owner
  on data_quality (owner_user_id, document_id, table_index, row_index, rejection_reason);

-- documents.report_id was globally unique; the same Gmail message id can exist
-- for two users, so scope it too.
alter table documents add column if not exists id bigserial;
alter table documents drop constraint if exists documents_pkey cascade;
alter table documents drop constraint if exists documents_document_id_key;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'documents_pkey') then
    alter table documents add constraint documents_pkey primary key (id);
  end if;
end $$;
create unique index if not exists uq_documents_owner_report
  on documents (owner_user_id, report_id);
create unique index if not exists uq_documents_owner_document
  on documents (owner_user_id, document_id);

alter table gmail_accounts drop constraint if exists gmail_accounts_google_sub_key;
alter table gmail_accounts drop constraint if exists gmail_accounts_email_key;
create unique index if not exists uq_gmail_owner_sub
  on gmail_accounts (owner_user_id, google_sub);

alter table users enable row level security;
