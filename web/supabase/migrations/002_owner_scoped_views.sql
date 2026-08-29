-- =============================================================================
-- Rebuild the summary views with owner_user_id, so dashboard queries can scope
-- to the signed-in user. Without this the views aggregate across every user
-- and one manager sees another's totals.
-- =============================================================================

-- CREATE OR REPLACE cannot add a column in first position ("cannot change name
-- of view column"), so the old definitions are dropped first. Views hold no
-- data, so this is free.
drop view if exists daily_summary cascade;
drop view if exists weekly_summary cascade;
drop view if exists monthly_summary cascade;
drop view if exists department_summary cascade;
drop view if exists employee_summary cascade;
drop view if exists slow_tasks cascade;

create view daily_summary as
select
  t.owner_user_id,
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
group by grouping sets ((t.owner_user_id, t.task_date, t.department),
                        (t.owner_user_id, t.task_date));

create view weekly_summary as
select
  t.owner_user_id,
  date_trunc('week', t.task_date)::date         as period_start,
  (date_trunc('week', t.task_date)::date + 6)   as period_end,
  case when grouping(t.department) = 1 then 'ALL'
       else coalesce(t.department, 'Unassigned') end as department,
  count(*)::int                                 as total_tasks,
  count(*) filter (where t.task_status = 'Completed')::int as completed,
  count(*) filter (where t.task_status = 'Pending')::int   as pending,
  round(100.0 * count(*) filter (where t.task_status = 'Completed')
        / nullif(count(*), 0), 1)               as completion_rate,
  count(*) filter (where t.slow_task_flag = 'TRUE')::int   as slow_tasks,
  count(*) filter (where t.repeated_task_flag)::int        as repeated_tasks,
  count(distinct t.employee_name)::int          as employees_reporting
from tasks t
group by grouping sets ((t.owner_user_id, date_trunc('week', t.task_date), t.department),
                        (t.owner_user_id, date_trunc('week', t.task_date)));

create view monthly_summary as
select
  t.owner_user_id,
  date_trunc('month', t.task_date)::date        as period_start,
  to_char(t.task_date, 'YYYY-MM')               as month_label,
  case when grouping(t.department) = 1 then 'ALL'
       else coalesce(t.department, 'Unassigned') end as department,
  count(*)::int                                 as total_tasks,
  count(*) filter (where t.task_status = 'Completed')::int as completed,
  count(*) filter (where t.task_status = 'Pending')::int   as pending,
  round(100.0 * count(*) filter (where t.task_status = 'Completed')
        / nullif(count(*), 0), 1)               as completion_rate,
  count(*) filter (where t.slow_task_flag = 'TRUE')::int   as slow_tasks,
  count(*) filter (where t.repeated_task_flag)::int        as repeated_tasks,
  count(distinct t.employee_name)::int          as employees_reporting
from tasks t
group by grouping sets
  ((t.owner_user_id, date_trunc('month', t.task_date), to_char(t.task_date,'YYYY-MM'), t.department),
   (t.owner_user_id, date_trunc('month', t.task_date), to_char(t.task_date,'YYYY-MM')));

create view department_summary as
select
  t.owner_user_id,
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
group by t.owner_user_id, coalesce(t.department, 'Unassigned');

create view employee_summary as
select
  t.owner_user_id,
  t.employee_name                               as employee,
  max(t.department)                             as department,
  count(*)::int                                 as total_tasks,
  count(*) filter (where t.task_status = 'Completed')::int as completed,
  count(*) filter (where t.task_status = 'Pending')::int   as pending,
  round(100.0 * count(*) filter (where t.task_status = 'Completed')
        / nullif(count(*), 0), 1)               as completion_rate,
  count(*) filter (where t.slow_task_flag = 'TRUE')::int   as slow_tasks,
  count(*) filter (where t.repeated_task_flag)::int        as repeated_tasks,
  count(distinct t.task_date)::int              as distinct_days_reported,
  case
    when count(*) >= 30 and count(distinct t.task_date) >= 10 then 'Sufficient for trend'
    when count(*) >= 10 then 'Indicative only'
    else 'Insufficient — do not rank'
  end                                           as data_sufficiency
from tasks t
group by t.owner_user_id, t.employee_name;

create view slow_tasks as
select owner_user_id, task_id, task_date, department, employee_name as employee, task,
       task_category, task_status, expected_duration, actual_duration,
       slow_variance_hours as variance_hours,
       round(100.0 * slow_variance_hours / nullif(expected_duration, 0), 1) as variance_pct,
       duration_basis, link
from tasks
where slow_task_flag = 'TRUE'
order by slow_variance_hours desc;
