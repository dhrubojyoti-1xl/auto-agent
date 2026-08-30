-- Where a row came from, so a figure read out of a picture is filterable and
-- auditable rather than indistinguishable from one typed into a spreadsheet.
alter table tasks add column if not exists extraction_source text not null default 'table';
create index if not exists idx_tasks_extraction_source
  on tasks (owner_user_id, extraction_source);
