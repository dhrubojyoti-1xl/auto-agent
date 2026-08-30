-- Views shaped for a business-intelligence tool.
--
-- Looker Studio, Power BI and Metabase all connect straight to Postgres, and
-- all of them are happiest with one wide, flat, already-joined table per
-- question rather than a normalised schema they have to model. The existing
-- views serve the application; these serve a person dragging fields onto a
-- canvas.
--
-- Two rules hold throughout. Planned work and ambiguous statuses are excluded
-- from anything named "counted", exactly as the dashboard excludes them, so a
-- chart built here cannot disagree with the application. And owner_user_id is
-- present on every row, because a BI tool has no idea what a tenant is and the
-- filter has to be available to it.

-- One row per task, everything a chart might group by already resolved.
create or replace view bi_tasks as
select
  t.owner_user_id,
  t.task_id,
  t.task_date                                          as work_date,
  date_trunc('week',  t.task_date)::date               as week_start,
  date_trunc('month', t.task_date)::date               as month_start,
  to_char(t.task_date, 'YYYY-MM')                      as year_month,
  coalesce(nullif(t.department, ''), 'Not identified') as department,
  t.employee_name                                      as employee,
  t.task,
  t.task_category                                      as category,
  t.task_status                                        as status,
  t.work_kind,
  t.extraction_source,
  -- The three flags a chart actually wants, so nobody has to remember the rules.
  (t.work_kind <> 'PLANNED' and t.task_status <> 'Ambiguous')          as counted,
  (t.task_status = 'Completed'
     and t.work_kind <> 'PLANNED' and t.task_status <> 'Ambiguous')    as completed,
  (t.task_status in ('Pending','In Progress','Blocked')
     and t.work_kind <> 'PLANNED')                                     as open_work,
  t.actual_duration                                    as hours_taken,
  t.expected_duration                                  as hours_expected,
  t.slow_task_flag,
  t.slow_baseline_source,
  t.repeated_task_flag,
  t.repeat_classification,
  t.link,
  t.source_document_id,
  t.imported_at
from tasks t;

comment on view bi_tasks is
  'One row per task with dates pre-bucketed and the counting rules resolved. '
  'Filter on owner_user_id. Use counted/completed rather than re-deriving them.';

-- Daily counts per department, already aggregated for a time series.
create or replace view bi_daily_by_department as
select
  owner_user_id,
  work_date,
  department,
  count(*) filter (where counted)::int                            as tasks,
  count(*) filter (where completed)::int                          as completed,
  count(*) filter (where open_work)::int                          as open_work,
  count(distinct employee) filter (where counted)::int            as people,
  coalesce(round(100.0 * count(*) filter (where completed)
           / nullif(count(*) filter (where counted), 0), 1), 0)   as completion_rate
from bi_tasks
group by owner_user_id, work_date, department;

comment on view bi_daily_by_department is
  'Daily task counts per department, planned and ambiguous rows already excluded.';

-- What happened to every message, for a coverage or data-quality chart.
create or replace view bi_messages as
select
  d.owner_user_id,
  d.report_id,
  d.received_at,
  d.processed_at,
  d.subject,
  d.sender,
  coalesce(d.classification, 'NON_REPORT')  as classification,
  d.processing_status,
  d.attachment_name,
  d.departments_count,
  d.departments_list,
  d.rows_extracted,
  d.rows_inserted,
  d.rows_rejected,
  d.prefilter_score,
  d.evidence
from documents d;

comment on view bi_messages is
  'Every message the assistant judged, with its verdict and the rows it produced.';
