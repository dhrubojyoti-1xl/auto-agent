-- A daily report routinely carries three different things under three
-- headings: what was done yesterday, what was done today, and what is planned
-- for tomorrow. Counting them as one stream inflates today's completions with
-- yesterday's work and with work nobody has started.
--
-- The kind is recorded per task so analytics can keep them apart. Existing
-- rows are REPORTED, which is what they were: work stated in a report, with no
-- claim about which day's stream it belonged to.
alter table tasks add column if not exists work_kind text not null default 'REPORTED';

create index if not exists idx_tasks_work_kind on tasks (owner_user_id, work_kind);
