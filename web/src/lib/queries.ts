/** Read-only queries for the dashboard pages. */
import { query } from './db';

export interface Kpis {
  total: number; completed: number; pending: number; inProgress: number;
  blocked: number; completionRate: number; slowTasks: number;
  repeatedTasks: number; departmentsReporting: number; employeesReporting: number;
  insufficientDuration: number; firstDate: string | null; lastDate: string | null;
}

export async function getKpis(): Promise<Kpis> {
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
    from tasks`);
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

export async function getDepartments(): Promise<DeptRow[]> {
  const rows = await query<Record<string, string | number>>(
    `select department, total_tasks, completed, pending, blocked, completion_rate,
            slow_tasks, repeated_tasks, employees_reporting
     from department_summary order by total_tasks desc`);
  return rows.map(r => ({
    department: String(r.department), total: Number(r.total_tasks),
    completed: Number(r.completed), pending: Number(r.pending),
    blocked: Number(r.blocked), completionRate: Number(r.completion_rate),
    slowTasks: Number(r.slow_tasks), repeatedTasks: Number(r.repeated_tasks),
    employees: Number(r.employees_reporting)
  }));
}

export async function getDailyTrend(days = 14) {
  const rows = await query<Record<string, string | number>>(
    `select period_start, total_tasks, completed, completion_rate
     from daily_summary where department = 'ALL'
     order by period_start desc limit $1`, [days]);
  return rows.map(r => ({
    date: String(r.period_start), total: Number(r.total_tasks),
    completed: Number(r.completed), completionRate: Number(r.completion_rate)
  })).reverse();
}

export async function getEmployees() {
  const rows = await query<Record<string, string | number>>(
    `select employee, department, total_tasks, completed, pending, completion_rate,
            slow_tasks, repeated_tasks, distinct_days_reported, data_sufficiency
     from employee_summary order by total_tasks desc`);
  return rows.map(r => ({
    employee: String(r.employee), department: String(r.department ?? ''),
    total: Number(r.total_tasks), completed: Number(r.completed),
    pending: Number(r.pending), completionRate: Number(r.completion_rate),
    slowTasks: Number(r.slow_tasks), repeatedTasks: Number(r.repeated_tasks),
    days: Number(r.distinct_days_reported), dataSufficiency: String(r.data_sufficiency)
  }));
}

export async function getRepeatGroups() {
  const rows = await query<Record<string, string | number | string[]>>(
    `select employee, department, task, occurrence_count, distinct_dates,
            max_same_day_count, first_date, last_date, classification,
            classification_reason
     from repeat_groups order by occurrence_count desc`);
  return rows.map(r => ({
    employee: String(r.employee), department: String(r.department ?? ''),
    task: String(r.task), occurrences: Number(r.occurrence_count),
    distinctDates: Number(r.distinct_dates), maxSameDay: Number(r.max_same_day_count),
    firstDate: String(r.first_date), lastDate: String(r.last_date),
    classification: String(r.classification), reason: String(r.classification_reason ?? '')
  }));
}

export async function getSlowTasks() {
  const rows = await query<Record<string, string | number>>(
    `select task_date, department, employee, task, task_category, task_status,
            expected_duration, actual_duration, variance_hours, variance_pct, duration_basis
     from slow_tasks`);
  return rows.map(r => ({
    date: String(r.task_date), department: String(r.department ?? ''),
    employee: String(r.employee), task: String(r.task),
    category: String(r.task_category ?? ''), status: String(r.task_status),
    expected: Number(r.expected_duration), actual: Number(r.actual_duration),
    variance: Number(r.variance_hours), variancePct: Number(r.variance_pct),
    basis: String(r.duration_basis)
  }));
}

export async function getRejections() {
  const rows = await query<Record<string, string | number | Record<string, string>>>(
    `select rejection_id, document_id, rejection_reason, rejection_detail, raw_row,
            claimed_date, logged_at, resolution_status
     from data_quality order by logged_at desc limit 300`);
  return rows.map(r => ({
    id: Number(r.rejection_id), documentId: String(r.document_id ?? ''),
    reason: String(r.rejection_reason), detail: String(r.rejection_detail ?? ''),
    raw: (r.raw_row || {}) as Record<string, string>,
    claimedDate: r.claimed_date ? String(r.claimed_date) : '',
    loggedAt: String(r.logged_at), resolution: String(r.resolution_status)
  }));
}

export async function getDocuments(limit = 25) {
  const rows = await query<Record<string, string | number>>(
    `select report_id, document_id, source, subject, sender, department, report_date,
            processing_status, rows_extracted, rows_inserted, rows_skipped_idempotent,
            rows_rejected, processed_at
     from documents order by processed_at desc limit $1`, [limit]);
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

export async function getLatestReport() {
  const rows = await query<Record<string, string>>(
    `select report_id, report_type, period_start, period_end, generated_at,
            generator, status, human_report, validation_error
     from ai_reports order by generated_at desc limit 1`);
  return rows[0] || null;
}
