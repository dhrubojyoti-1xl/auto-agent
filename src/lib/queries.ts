/** Read-only queries for the dashboard pages. */
import { query } from './db';

export interface Kpis {
  total: number; completed: number; pending: number; inProgress: number;
  blocked: number; completionRate: number; slowTasks: number;
  repeatedTasks: number; departmentsReporting: number; employeesReporting: number;
  insufficientDuration: number; firstDate: string | null; lastDate: string | null;
}

export async function getKpis(ownerUserId: number): Promise<Kpis> {
  const [r] = await query<Record<string, string | number | null>>(`
    select
      count(*)::int as total,
      count(*) filter (where task_status = 'Completed')::int as completed,
      count(*) filter (where task_status = 'Pending')::int as pending,
      count(*) filter (where task_status = 'In Progress')::int as in_progress,
      count(*) filter (where task_status = 'Blocked')::int as blocked,
      coalesce(round(100.0 * count(*) filter (where task_status = 'Completed')
               / nullif(count(*),0), 1), 0) as completion_rate,
      count(*) filter (where slow_task_flag = 'TRUE')::int as slow_tasks,
      count(*) filter (where repeated_task_flag)::int as repeated_tasks,
      count(distinct department)::int as departments_reporting,
      count(distinct employee_name)::int as employees_reporting,
      count(*) filter (where slow_task_flag = 'INSUFFICIENT_DATA')::int as insufficient_duration,
      min(task_date) as first_date, max(task_date) as last_date
    from tasks where owner_user_id = $1`, [ownerUserId]);
  return {
    total: Number(r.total), completed: Number(r.completed), pending: Number(r.pending),
    inProgress: Number(r.in_progress), blocked: Number(r.blocked),
    completionRate: Number(r.completion_rate), slowTasks: Number(r.slow_tasks),
    repeatedTasks: Number(r.repeated_tasks),
    departmentsReporting: Number(r.departments_reporting),
    employeesReporting: Number(r.employees_reporting),
    insufficientDuration: Number(r.insufficient_duration),
    firstDate: r.first_date ? String(r.first_date) : null,
    lastDate: r.last_date ? String(r.last_date) : null
  };
}

export interface DeptRow {
  department: string; total: number; completed: number; pending: number;
  blocked: number; completionRate: number; slowTasks: number;
  repeatedTasks: number; employees: number;
}

export async function getDepartments(ownerUserId: number): Promise<DeptRow[]> {
  const rows = await query<Record<string, string | number>>(
    `select department, total_tasks, completed, pending, blocked, completion_rate,
            slow_tasks, repeated_tasks, employees_reporting
     from department_summary where owner_user_id = $1 order by total_tasks desc`,
    [ownerUserId]);
  return rows.map(r => ({
    department: String(r.department), total: Number(r.total_tasks),
    completed: Number(r.completed), pending: Number(r.pending),
    blocked: Number(r.blocked), completionRate: Number(r.completion_rate),
    slowTasks: Number(r.slow_tasks), repeatedTasks: Number(r.repeated_tasks),
    employees: Number(r.employees_reporting)
  }));
}

export async function getDailyTrend(ownerUserId: number, days = 14) {
  const rows = await query<Record<string, string | number>>(
    `select period_start, total_tasks, completed, completion_rate
     from daily_summary where department = 'ALL' and owner_user_id = $2
     order by period_start desc limit $1`, [days, ownerUserId]);
  return rows.map(r => ({
    date: String(r.period_start), total: Number(r.total_tasks),
    completed: Number(r.completed), completionRate: Number(r.completion_rate)
  })).reverse();
}

export async function getEmployees(ownerUserId: number) {
  const rows = await query<Record<string, string | number>>(
    `select employee, department, total_tasks, completed, pending, completion_rate,
            slow_tasks, repeated_tasks, distinct_days_reported, data_sufficiency
     from employee_summary where owner_user_id = $1 order by total_tasks desc`,
    [ownerUserId]);
  return rows.map(r => ({
    employee: String(r.employee), department: String(r.department ?? ''),
    total: Number(r.total_tasks), completed: Number(r.completed),
    pending: Number(r.pending), completionRate: Number(r.completion_rate),
    slowTasks: Number(r.slow_tasks), repeatedTasks: Number(r.repeated_tasks),
    days: Number(r.distinct_days_reported), dataSufficiency: String(r.data_sufficiency)
  }));
}

export async function getRepeatGroups(
  ownerUserId: number,
  opts: { department?: string; employee?: string; from?: string; to?: string } = {}
) {
  const params: unknown[] = [ownerUserId];
  const where = ['owner_user_id = $1'];
  if (opts.department) { params.push(opts.department); where.push(`department = $${params.length}`); }
  if (opts.employee) { params.push(opts.employee); where.push(`employee = $${params.length}`); }
  // A group belongs in the window if any of its occurrences does, so the
  // group's span must overlap the window rather than sit inside it.
  if (opts.from) { params.push(opts.from); where.push(`last_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`first_date <= $${params.length}`); }
  const rows = await query<Record<string, string | number | string[]>>(
    `select employee, department, task, occurrence_count, distinct_dates,
            max_same_day_count, first_date, last_date, classification,
            classification_reason
     from repeat_groups where ${where.join(' and ')} order by occurrence_count desc`,
    params);
  return rows.map(r => ({
    employee: String(r.employee), department: String(r.department ?? ''),
    task: String(r.task), occurrences: Number(r.occurrence_count),
    distinctDates: Number(r.distinct_dates), maxSameDay: Number(r.max_same_day_count),
    firstDate: String(r.first_date), lastDate: String(r.last_date),
    classification: String(r.classification), reason: String(r.classification_reason ?? '')
  }));
}

export async function getSlowTasks(ownerUserId: number) {
  const rows = await query<Record<string, string | number>>(
    `select task_date, department, employee, task, task_category, task_status,
            expected_duration, actual_duration, variance_hours, variance_pct,
            duration_basis, baseline_source, baseline_sample, reason
     from slow_tasks where owner_user_id = $1`, [ownerUserId]);
  return rows.map(r => ({
    date: String(r.task_date), department: String(r.department ?? ''),
    employee: String(r.employee), task: String(r.task),
    category: String(r.task_category ?? ''), status: String(r.task_status),
    expected: Number(r.expected_duration), actual: Number(r.actual_duration),
    variance: Number(r.variance_hours), variancePct: Number(r.variance_pct),
    basis: String(r.duration_basis),
    baselineSource: String(r.baseline_source ?? 'configured'),
    baselineSample: Number(r.baseline_sample ?? 0),
    reason: String(r.reason ?? '')
  }));
}

export async function getRejections(ownerUserId: number) {
  const rows = await query<Record<string, string | number | Record<string, string>>>(
    `select rejection_id, document_id, rejection_reason, rejection_detail, raw_row,
            claimed_date, logged_at, resolution_status
     from data_quality where owner_user_id = $1 order by logged_at desc limit 300`,
    [ownerUserId]);
  return rows.map(r => ({
    id: Number(r.rejection_id), documentId: String(r.document_id ?? ''),
    reason: String(r.rejection_reason), detail: String(r.rejection_detail ?? ''),
    raw: (r.raw_row || {}) as Record<string, string>,
    claimedDate: r.claimed_date ? String(r.claimed_date) : '',
    loggedAt: String(r.logged_at), resolution: String(r.resolution_status)
  }));
}

export async function getDocuments(ownerUserId: number, limit = 25) {
  const rows = await query<Record<string, string | number>>(
    `select report_id, document_id, source, subject, sender, department, report_date,
            processing_status, rows_extracted, rows_inserted, rows_skipped_idempotent,
            rows_rejected, processed_at
     from documents where owner_user_id = $2
     order by processed_at desc limit $1`, [limit, ownerUserId]);
  return rows.map(r => ({
    reportId: String(r.report_id), documentId: String(r.document_id),
    source: String(r.source), subject: String(r.subject ?? ''),
    sender: String(r.sender ?? ''), department: String(r.department ?? ''),
    reportDate: r.report_date ? String(r.report_date) : '',
    status: String(r.processing_status), extracted: Number(r.rows_extracted),
    inserted: Number(r.rows_inserted), skipped: Number(r.rows_skipped_idempotent),
    rejected: Number(r.rows_rejected), processedAt: String(r.processed_at)
  }));
}

export async function getLatestReport(ownerUserId: number) {
  const rows = await query<Record<string, string>>(
    `select report_id, report_type, period_start, period_end, generated_at,
            generator, status, human_report, validation_error
     from ai_reports where owner_user_id = $1
     order by generated_at desc limit 1`, [ownerUserId]);
  return rows[0] || null;
}

/* ==========================================================================
 * Management analytics — every figure computed in SQL from the task table,
 * so a chart and the report can never disagree.
 * ======================================================================== */

export type Grain = 'daily' | 'weekly' | 'monthly';

const TRUNC: Record<Grain, string> = {
  daily: 'day', weekly: 'week', monthly: 'month'
};

export interface PeriodPoint {
  period: string; total: number; completed: number; pending: number;
  inProgress: number; blocked: number; cancelled: number; notStarted: number;
  completionRate: number; backlog: number; employees: number; departments: number;
}

/** Volume and status split per period, optionally filtered. */
export async function getPeriodSeries(
  ownerUserId: number, grain: Grain,
  opts: { department?: string; employee?: string; from?: string; to?: string; limit?: number } = {}
): Promise<PeriodPoint[]> {
  const params: unknown[] = [ownerUserId];
  const where = ['owner_user_id = $1'];
  if (opts.department) { params.push(opts.department); where.push(`department = $${params.length}`); }
  if (opts.employee) { params.push(opts.employee); where.push(`employee_name = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`task_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`task_date <= $${params.length}`); }
  params.push(opts.limit ?? 60);

  const rows = await query<Record<string, string | number>>(
    `select date_trunc('${TRUNC[grain]}', task_date)::date as period,
            count(*)::int as total,
            count(*) filter (where task_status = 'Completed')::int   as completed,
            count(*) filter (where task_status = 'Pending')::int     as pending,
            count(*) filter (where task_status = 'In Progress')::int as in_progress,
            count(*) filter (where task_status = 'Blocked')::int     as blocked,
            count(*) filter (where task_status = 'Cancelled')::int   as cancelled,
            count(*) filter (where task_status = 'Not Started')::int as not_started,
            coalesce(round(100.0 * count(*) filter (where task_status = 'Completed')
                     / nullif(count(*),0), 1), 0) as completion_rate,
            count(distinct employee_name)::int as employees,
            count(distinct department)::int as departments
     from tasks where ${where.join(' and ')}
     group by 1 order by 1 desc limit $${params.length}`, params);

  return rows.map(r => {
    const total = Number(r.total), completed = Number(r.completed);
    return {
      period: String(r.period), total, completed,
      pending: Number(r.pending), inProgress: Number(r.in_progress),
      blocked: Number(r.blocked), cancelled: Number(r.cancelled),
      notStarted: Number(r.not_started),
      completionRate: Number(r.completion_rate),
      // Backlog: everything reported that is neither finished nor abandoned.
      backlog: total - completed - Number(r.cancelled),
      employees: Number(r.employees), departments: Number(r.departments)
    };
  }).reverse();
}

/** Per-department totals for a window. */
export async function getDepartmentBreakdown(
  ownerUserId: number, opts: { employee?: string; from?: string; to?: string } = {}
) {
  const params: unknown[] = [ownerUserId];
  const where = ['owner_user_id = $1'];
  if (opts.employee) { params.push(opts.employee); where.push(`employee_name = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`task_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`task_date <= $${params.length}`); }
  const rows = await query<Record<string, string | number>>(
    `select coalesce(department,'Unknown') as department,
            count(*)::int as total,
            count(*) filter (where task_status = 'Completed')::int as completed,
            count(*) filter (where task_status = 'Pending')::int as pending,
            count(*) filter (where task_status = 'In Progress')::int as in_progress,
            count(*) filter (where task_status = 'Blocked')::int as blocked,
            coalesce(round(100.0 * count(*) filter (where task_status='Completed')
                     / nullif(count(*),0),1),0) as completion_rate,
            count(*) filter (where slow_task_flag = 'TRUE')::int as slow_tasks,
            count(*) filter (where repeated_task_flag)::int as repeated_tasks,
            count(distinct employee_name)::int as employees
     from tasks where ${where.join(' and ')}
     group by 1 order by total desc`, params);
  return rows.map(r => ({
    department: String(r.department), total: Number(r.total),
    completed: Number(r.completed), pending: Number(r.pending),
    inProgress: Number(r.in_progress), blocked: Number(r.blocked),
    completionRate: Number(r.completion_rate), slowTasks: Number(r.slow_tasks),
    repeatedTasks: Number(r.repeated_tasks), employees: Number(r.employees)
  }));
}

export async function getStatusDistribution(
  ownerUserId: number,
  opts: { department?: string; employee?: string; from?: string; to?: string } = {}
) {
  const params: unknown[] = [ownerUserId];
  const where = ['owner_user_id = $1'];
  if (opts.department) { params.push(opts.department); where.push(`department = $${params.length}`); }
  if (opts.employee) { params.push(opts.employee); where.push(`employee_name = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`task_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`task_date <= $${params.length}`); }
  const rows = await query<Record<string, string | number>>(
    `select task_status as name, count(*)::int as value from tasks
     where ${where.join(' and ')} group by 1 order by 2 desc`, params);
  return rows.map(r => ({ name: String(r.name), value: Number(r.value) }));
}

export async function getEmployeeActivity(
  ownerUserId: number,
  opts: { department?: string; employee?: string; from?: string; to?: string;
          limit?: number } = {}
) {
  const params: unknown[] = [ownerUserId];
  const where = ['owner_user_id = $1'];
  if (opts.department) { params.push(opts.department); where.push(`department = $${params.length}`); }
  if (opts.employee) { params.push(opts.employee); where.push(`employee_name = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`task_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`task_date <= $${params.length}`); }
  params.push(opts.limit ?? 12);
  const rows = await query<Record<string, string | number>>(
    `select employee_name as employee, max(department) as department,
            count(*)::int as total,
            count(*) filter (where task_status='Completed')::int as completed,
            coalesce(round(100.0 * count(*) filter (where task_status='Completed')
                     / nullif(count(*),0),1),0) as completion_rate,
            count(distinct task_date)::int as days
     from tasks where ${where.join(' and ')}
     group by 1 order by total desc limit $${params.length}`, params);
  return rows.map(r => ({
    employee: String(r.employee), department: String(r.department ?? ''),
    total: Number(r.total), completed: Number(r.completed),
    completionRate: Number(r.completion_rate), days: Number(r.days)
  }));
}

/** Distinct departments and employees, for filter drop-downs. */
export async function getFilterOptions(ownerUserId: number) {
  const [depts, emps, range] = await Promise.all([
    query<{ d: string }>(
      `select distinct coalesce(department,'Unknown') as d from tasks
       where owner_user_id = $1 order by 1`, [ownerUserId]),
    query<{ e: string }>(
      `select distinct employee_name as e from tasks where owner_user_id = $1 order by 1`,
      [ownerUserId]),
    query<{ min_date: string | null; max_date: string | null }>(
      `select min(task_date) as min_date, max(task_date) as max_date from tasks
       where owner_user_id = $1`, [ownerUserId])
  ]);
  return {
    departments: depts.map(r => r.d),
    employees: emps.map(r => r.e),
    minDate: range[0]?.min_date ? String(range[0].min_date) : null,
    maxDate: range[0]?.max_date ? String(range[0].max_date) : null
  };
}

/** Slow tasks and repeat groups, already scoped, for their charts. */
export async function getSlowTaskChart(
  ownerUserId: number,
  opts: { department?: string; employee?: string; from?: string; to?: string;
          limit?: number } = {}
) {
  const params: unknown[] = [ownerUserId];
  const where = ['owner_user_id = $1'];
  if (opts.department) { params.push(opts.department); where.push(`department = $${params.length}`); }
  if (opts.employee) { params.push(opts.employee); where.push(`employee = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`task_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`task_date <= $${params.length}`); }
  params.push(opts.limit ?? 10);
  const rows = await query<Record<string, string | number>>(
    `select task, employee, variance_hours, expected_duration, actual_duration
     from slow_tasks where ${where.join(' and ')}
     order by variance_hours desc limit $${params.length}`, params);
  return rows.map(r => ({
    task: String(r.task), employee: String(r.employee),
    variance: Number(r.variance_hours), expected: Number(r.expected_duration),
    actual: Number(r.actual_duration)
  }));
}
