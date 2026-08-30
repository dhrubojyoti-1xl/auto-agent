-- A report can legitimately cover several departments: one email, one table,
-- five teams. The report-level department was previously whichever department
-- had the most rows, so a five-department report was labelled with one of them
-- and the other four vanished from the report's own description.
--
-- The column now means what it says: the department of the report, set only
-- when every row agrees. The span is recorded alongside it so the Inbox can
-- say "one report across five departments" rather than picking a winner.
alter table documents add column if not exists departments_count int not null default 0;
alter table documents add column if not exists departments_list text;
