-- =============================================================================
-- Record WHERE a slow-task expectation came from.
-- =============================================================================
-- Slow-task detection now learns a baseline from history (median duration of
-- the same task, category, or department) when nobody has configured one.
-- "This took 5h against a 1h median from 5 observations" is actionable;
-- "this is slow" is not, so the provenance is stored alongside the flag.
-- =============================================================================

alter table tasks add column if not exists slow_baseline_source text;
alter table tasks add column if not exists slow_baseline_sample int;
alter table tasks add column if not exists slow_reason text;

drop view if exists slow_tasks cascade;
create view slow_tasks as
select owner_user_id, task_id, task_date, department, employee_name as employee, task,
       task_category, task_status, expected_duration, actual_duration,
       slow_variance_hours as variance_hours,
       round(100.0 * slow_variance_hours / nullif(expected_duration, 0), 1) as variance_pct,
       duration_basis, link,
       slow_baseline_source as baseline_source,
       slow_baseline_sample as baseline_sample,
       slow_reason as reason
from tasks
where slow_task_flag = 'TRUE'
order by slow_variance_hours desc;
