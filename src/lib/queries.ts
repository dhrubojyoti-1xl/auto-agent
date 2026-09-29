/** Read-only queries for the dashboard pages. */
import { query } from './db';
import { keyify } from './core/normalize';
import { looksLikePersonName } from './core/person-name';
import { reportDocument, reportRejection } from './visibility';

/**
 * Which names in the task table are people.
 *
 * Reports imported before the DWR fixes carry task titles in the employee
 * field — "Hr Meeting", "Content Team" — and those rows are left exactly as
 * they are. They still count in every department total; they are simply not
 * offered as colleagues in a drop-down or ranked beside real people.
 *
 * The roster is the authority: anyone on it is a person, whatever their name
 * looks like. With ROSTER_ONLY on, only the roster counts.
 */
export async function personFilter(): Promise<(name: string) => boolean> {
  const roster = await query<{ employee_name: string; name_aliases: string[] | null }>(
    `select employee_name, name_aliases from employees where active and not auto_created`);
  const known = new Set<string>();
  for (const r of roster) {
    known.add(keyify(r.employee_name));
    for (const a of r.name_aliases || []) if (a) known.add(keyify(a));
  }
  known.delete('');
  const rosterOnly = /^(1|true|yes|on)$/i.test(process.env.ROSTER_ONLY || '') && known.size > 0;
  return (name: string) => known.has(keyify(name)) || (!rosterOnly && looksLikePersonName(name));
}

/**
 * The names in this account's tasks that are not people, for excluding from
 * headcounts in SQL (`employee_name <> all($n)`), so "People reporting" agrees
 * with the list of people beside it.
 */
async function nonPeople(ownerUserId: number): Promise<string[]> {
  const [names, isPerson] = await Promise.all([
    query<{ e: string }>(
      `select distinct employee_name as e from tasks where owner_user_id = $1`, [ownerUserId]),
    personFilter()
  ]);
  return names.map(r => r.e).filter(n => !isPerson(n));
}

/**
 * Work that has not happened yet is not work.
 *
 * A daily report often carries a "Tomorrow's Plan" column beside today's work.
 * Counting those rows inflates every figure management looks at — task volume,
 * completion rate, employee activity — with work nobody has started. They are
 * still imported and still visible; they are simply not counted as activity.
 */
const NOT_PLANNED = "work_kind <> 'PLANNED'";

/**
 * A row whose status names two states at once is counted in nothing.
 *
 * Leaving it in the denominator would mean counting it as work that failed to
 * complete, which is as much of a claim as counting it as complete. It stays
 * visible on Data quality, where somebody can ask for a single status.
 */
const NOT_AMBIGUOUS = "task_status <> 'Ambiguous'";

export interface Kpis {
  total: number; completed: number; pending: number; inProgress: number;
  blocked: number; completionRate: number; slowTasks: number;
  repeatedTasks: number;
  repeatGroups: number;
  repeatAttention: number; departmentsReporting: number; employeesReporting: number;
  insufficientDuration: number; firstDate: string | null; lastDate: string | null;
}

export async function getKpis(ownerUserId: number): Promise<Kpis> {
  const excluded = await nonPeople(ownerUserId);
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
      (select count(*)::int from repeat_groups g where g.owner_user_id = $1) as repeat_groups,
      (select count(*)::int from repeat_groups g where g.owner_user_id = $1
         and g.classification in ('Needs Review', 'Potential Duplication')) as repeat_attention,
      count(distinct department)::int as departments_reporting,
      count(distinct employee_name) filter (where employee_name <> all($2::text[]))::int
        as employees_reporting,
      count(*) filter (where slow_task_flag = 'INSUFFICIENT_DATA')::int as insufficient_duration,
      min(task_date) as first_date, max(task_date) as last_date
    from tasks where owner_user_id = $1 and work_kind <> 'PLANNED'
      and task_status <> 'Ambiguous'`, [ownerUserId, excluded]);
  return {
    total: Number(r.total), completed: Number(r.completed), pending: Number(r.pending),
    inProgress: Number(r.in_progress), blocked: Number(r.blocked),
    completionRate: Number(r.completion_rate), slowTasks: Number(r.slow_tasks),
    repeatedTasks: Number(r.repeated_tasks),
    repeatGroups: Number(r.repeat_groups ?? 0),
    repeatAttention: Number(r.repeat_attention ?? 0),
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
  const [rows, isPerson] = await Promise.all([query<Record<string, string | number>>(
    `select employee, department, total_tasks, completed, pending, completion_rate,
            slow_tasks, repeated_tasks, distinct_days_reported, data_sufficiency
     from employee_summary where owner_user_id = $1 order by total_tasks desc`,
    [ownerUserId]), personFilter()]);
  return rows.filter(r => isPerson(String(r.employee))).map(r => ({
    employee: String(r.employee), department: String(r.department ?? ''),
    total: Number(r.total_tasks), completed: Number(r.completed),
    pending: Number(r.pending), completionRate: Number(r.completion_rate),
    slowTasks: Number(r.slow_tasks), repeatedTasks: Number(r.repeated_tasks),
    days: Number(r.distinct_days_reported), dataSufficiency: String(r.data_sufficiency)
  }));
}

export async function getRepeatGroups(
  ownerUserId: number,
  opts: { department?: string; employee?: string; from?: string; to?: string;
          search?: string } = {}
) {
  const params: unknown[] = [ownerUserId];
  const where = ['owner_user_id = $1'];
  if (opts.department) { params.push(opts.department); where.push(`department = $${params.length}`); }
  if (opts.employee) { params.push(opts.employee); where.push(`employee = $${params.length}`); }
  // A group belongs in the window if any of its occurrences does, so the
  // group's span must overlap the window rather than sit inside it.
  if (opts.from) { params.push(opts.from); where.push(`last_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`first_date <= $${params.length}`); }
  if (opts.search) { params.push(`%${opts.search}%`); where.push(`task ilike $${params.length}`); }
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

export async function getSlowTasks(
  ownerUserId: number,
  opts: { department?: string; employee?: string; from?: string; to?: string;
          search?: string } = {}
) {
  const params: unknown[] = [ownerUserId];
  const where = ['owner_user_id = $1'];
  if (opts.department) { params.push(opts.department); where.push(`department = $${params.length}`); }
  if (opts.employee) { params.push(opts.employee); where.push(`employee = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`task_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`task_date <= $${params.length}`); }
  // Filtered in SQL, not hidden in the browser: a page that fetches everything
  // and then shows a subset still sends every row to whoever asked, and its
  // "3 slow tasks" would be counted from a list the reader cannot see.
  if (opts.search) { params.push(`%${opts.search}%`); where.push(`task ilike $${params.length}`); }
  const rows = await query<Record<string, string | number>>(
    `select task_date, department, employee, task, task_category, task_status,
            expected_duration, actual_duration, variance_hours, variance_pct,
            duration_basis, baseline_source, baseline_sample, reason
     from slow_tasks where ${where.join(' and ')}`, params);
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
     from data_quality dq where owner_user_id = $1 and ${reportRejection('dq')}
     order by logged_at desc limit 300`,
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
     from documents d where owner_user_id = $2 and ${reportDocument('d')}
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
  const where = ['owner_user_id = $1', NOT_PLANNED, NOT_AMBIGUOUS];
  if (opts.department) { params.push(opts.department); where.push(`department = $${params.length}`); }
  if (opts.employee) { params.push(opts.employee); where.push(`employee_name = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`task_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`task_date <= $${params.length}`); }
  params.push(await nonPeople(ownerUserId));
  const excludedParam = `$${params.length}::text[]`;
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
            count(distinct employee_name) filter (where employee_name <> all(${excludedParam}))::int
              as employees,
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
  const where = ['owner_user_id = $1', NOT_PLANNED, NOT_AMBIGUOUS];
  if (opts.employee) { params.push(opts.employee); where.push(`employee_name = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`task_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`task_date <= $${params.length}`); }
  params.push(await nonPeople(ownerUserId));
  const excludedParam = `$${params.length}::text[]`;
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
      (select count(*)::int from repeat_groups g where g.owner_user_id = $1) as repeat_groups,
      (select count(*)::int from repeat_groups g where g.owner_user_id = $1
         and g.classification in ('Needs Review', 'Potential Duplication')) as repeat_attention,
            count(distinct employee_name) filter (where employee_name <> all(${excludedParam}))::int
              as employees
     from tasks where ${where.join(' and ')}
     group by 1 order by total desc`, params);

  // Who runs each department, from the roster. Fetched separately rather than
  // joined: the aggregate above is the one query on this page whose shape has
  // been stable for months, and rewriting its FROM clause to hang a lookup off
  // it risks the totals to save a round trip that costs nothing.
  const managers = new Map(
    (await query<{ department_name: string; manager: string | null }>(
      `select department_name, manager from departments where active`))
      .map(d => [d.department_name.toLowerCase(), d.manager || ''])
  );
  return rows.map(r => ({
    department: String(r.department), total: Number(r.total),
    completed: Number(r.completed), pending: Number(r.pending),
    inProgress: Number(r.in_progress), blocked: Number(r.blocked),
    completionRate: Number(r.completion_rate), slowTasks: Number(r.slow_tasks),
    repeatedTasks: Number(r.repeated_tasks),
    repeatGroups: Number(r.repeat_groups ?? 0),
    repeatAttention: Number(r.repeat_attention ?? 0), employees: Number(r.employees),
    manager: managers.get(String(r.department).toLowerCase()) || ''
  }));
}

export async function getStatusDistribution(
  ownerUserId: number,
  opts: { department?: string; employee?: string; from?: string; to?: string } = {}
) {
  const params: unknown[] = [ownerUserId];
  const where = ['owner_user_id = $1', NOT_PLANNED, NOT_AMBIGUOUS];
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
  return (await getEmployeeActivityPanel(ownerUserId, opts)).rows;
}

/** The people ranking, plus how many names were left out of it as not people. */
export async function getEmployeeActivityPanel(
  ownerUserId: number,
  opts: { department?: string; employee?: string; from?: string; to?: string;
          limit?: number } = {}
) {
  const params: unknown[] = [ownerUserId];
  const where = ['owner_user_id = $1', NOT_PLANNED, NOT_AMBIGUOUS];
  if (opts.department) { params.push(opts.department); where.push(`department = $${params.length}`); }
  if (opts.employee) { params.push(opts.employee); where.push(`employee_name = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`task_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`task_date <= $${params.length}`); }
  const [grouped, isPerson] = await Promise.all([query<Record<string, string | number>>(
    `select employee_name as employee, max(department) as department,
            count(*)::int as total,
            count(*) filter (where task_status='Completed')::int as completed,
            coalesce(round(100.0 * count(*) filter (where task_status='Completed')
                     / nullif(count(*),0),1),0) as completion_rate,
            count(distinct task_date)::int as days
     from tasks where ${where.join(' and ')}
     group by 1 order by total desc, 1`, params), personFilter()]);
  const all = grouped.map(r => ({
    employee: String(r.employee), department: String(r.department ?? ''),
    total: Number(r.total), completed: Number(r.completed),
    completionRate: Number(r.completion_rate), days: Number(r.days)
  }));
  // Filtered after grouping and only then cut to length: cutting first would
  // let task titles take places in the top ten and leave the panel short.
  const people = all.filter(r => isPerson(r.employee));
  const hidden = all.filter(r => !isPerson(r.employee));
  return {
    rows: people.slice(0, opts.limit ?? 12),
    hiddenNames: hidden.length,
    hiddenTasks: hidden.reduce((a, r) => a + r.total, 0),
    hiddenExamples: hidden.slice(0, 3).map(r => r.employee)
  };
}

/**
 * Distinct departments and employees, for filter drop-downs.
 *
 * The employee list holds people only, and with a department chosen, only the
 * people who reported under it — a Support filter offering the whole company
 * (and every task title ever mistaken for a name) is not a filter.
 *
 * With ROSTER_ONLY on, the roster is the organisation, so its departments and
 * people are offered too — including anyone who has not reported yet, which
 * is exactly who a manager filters for. Before, an account whose reports had
 * not arrived showed empty drop-downs beside a 14-department roster.
 */
export async function getFilterOptions(
  ownerUserId: number, opts: { department?: string } = {}
) {
  const empParams: unknown[] = [ownerUserId];
  let empWhere = 'owner_user_id = $1';
  if (opts.department) {
    empParams.push(opts.department);
    empWhere += ` and coalesce(department,'Unknown') = $2`;
  }
  const rosterOnly = /^(1|true|yes|on)$/i.test(process.env.ROSTER_ONLY || '');
  const [depts, emps, range, isPerson, roster] = await Promise.all([
    query<{ d: string }>(
      `select distinct coalesce(department,'Unknown') as d from tasks
       where owner_user_id = $1 order by 1`, [ownerUserId]),
    query<{ e: string }>(
      `select distinct employee_name as e from tasks where ${empWhere} order by 1`,
      empParams),
    query<{ min_date: string | null; max_date: string | null }>(
      `select min(task_date) as min_date, max(task_date) as max_date from tasks
       where owner_user_id = $1`, [ownerUserId]),
    personFilter(),
    rosterOnly
      ? query<{ name: string; department: string }>(
          `select employee_name as name, department from employees
            where active and not auto_created
              and department is not null and department <> ''`)
      : Promise.resolve([] as { name: string; department: string }[])
  ]);
  const departments = depts.map(r => r.d);
  const employees = emps.map(r => r.e).filter(isPerson);
  if (roster.length) {
    const byName = (a: string, b: string) => a.localeCompare(b);
    const d = new Set(departments), e = new Set(employees);
    for (const p of roster) {
      d.add(p.department);
      if (!opts.department || p.department === opts.department) e.add(p.name);
    }
    departments.splice(0, departments.length, ...[...d].sort(byName));
    employees.splice(0, employees.length, ...[...e].sort(byName));
  }
  return {
    departments,
    employees,
    minDate: range[0]?.min_date ? String(range[0].min_date) : null,
    maxDate: range[0]?.max_date ? String(range[0].max_date) : null
  };
}

/**
 * How many slow tasks the scope holds. The chart below shows only the worst
 * few, so its length is not the count: the headline figure read 8 on a page
 * whose Slow tasks list had 204 rows.
 */
export async function countSlowTasks(
  ownerUserId: number,
  opts: { department?: string; employee?: string; from?: string; to?: string } = {}
): Promise<number> {
  const params: unknown[] = [ownerUserId];
  const where = ['owner_user_id = $1'];
  if (opts.department) { params.push(opts.department); where.push(`department = $${params.length}`); }
  if (opts.employee) { params.push(opts.employee); where.push(`employee = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`task_date >= $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`task_date <= $${params.length}`); }
  const [r] = await query<{ n: number }>(
    `select count(*)::int as n from slow_tasks where ${where.join(' and ')}`, params);
  return Number(r?.n ?? 0);
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

/**
 * Employees the importer invented because a report named someone who was not
 * in the roster. Their department is a guess from the first report they
 * appeared in, and that guess decides where later rows without a department
 * column are filed — so it is shown, not hidden.
 */
export async function getAutoCreatedEmployees(ownerUserId: number) {
  const rows = await query<Record<string, string | number>>(
    `select e.employee_id, e.employee_name, e.department,
            count(t.task_id)::int as tasks,
            min(t.task_date) as first_seen, max(t.task_date) as last_seen
     from employees e
     left join tasks t on t.employee_name = e.employee_name
                      and t.owner_user_id = $1
     where e.auto_created
     group by e.employee_id, e.employee_name, e.department
     order by count(t.task_id) desc, e.employee_name`, [ownerUserId]);
  return rows.map(r => ({
    id: String(r.employee_id), name: String(r.employee_name),
    department: String(r.department ?? ''), tasks: Number(r.tasks),
    firstSeen: r.first_seen ? String(r.first_seen) : '',
    lastSeen: r.last_seen ? String(r.last_seen) : ''
  }));
}

/**
 * Every message that did not become data, with the decision the assistant made
 * about it.
 *
 * "0 reports found" is true and useless. This is the same fact told properly:
 * which messages were looked at, what each was judged to be, and what the
 * judgement rested on.
 */
export async function getMessageOutcomes(ownerUserId: number, limit = 50) {
  const rows = await query<Record<string, string | number | null>>(
    `select subject, sender, received_at, processing_status,
            coalesce(classification, 'NON_REPORT') as classification,
            evidence, rows_inserted, rows_rejected, attachment_name,
            prefilter_score, prefilter_signals
     from documents d
     where owner_user_id = $1
       -- Reports only: a message that was not a report is never listed.
       and ${reportDocument('d')}
       and coalesce(classification, 'NON_REPORT') <> 'DEPARTMENTAL_REPORT'
       -- A message whose attachment or linked sheet became a report is a
       -- report. Listing its body separately as "not a report" reads as a
       -- contradiction with the line above it.
       and not exists (
         select 1 from documents s
          where s.owner_user_id = d.owner_user_id
            and s.gmail_message_id = d.gmail_message_id
            and s.rows_inserted > 0)
     order by received_at desc nulls last, processed_at desc
     limit $2`, [ownerUserId, limit]);
  return rows.map(r => ({
    subject: String(r.subject ?? '(no subject)'),
    sender: String(r.sender ?? ''),
    receivedAt: r.received_at ? String(r.received_at) : '',
    classification: String(r.classification),
    evidence: String(r.evidence ?? ''),
    rejected: Number(r.rows_rejected ?? 0),
    attachment: String(r.attachment_name ?? ''),
    prefilterScore: r.prefilter_score === null || r.prefilter_score === undefined
      ? null : Number(r.prefilter_score),
    prefilterSignals: String(r.prefilter_signals ?? '')
  }));
}

/**
 * How many messages actually became reports, and how many were looked at.
 *
 * Counted over every message, not over the handful shown in a table. The
 * Overview previously derived "Reports processed" from the eight rows it was
 * about to display, so an inbox with nine newsletters at the top reported zero
 * reports processed on a page showing forty-seven imported tasks.
 */
export async function getProcessingTotals(ownerUserId: number) {
  const [row] = await query<Record<string, number>>(
    `select
       count(*) filter (where processing_status <> 'NO_DATA')::int as reports,
       count(*)::int                                              as scanned,
       coalesce(sum(rows_inserted), 0)::int                       as imported
     from documents where owner_user_id = $1`, [ownerUserId]);
  return {
    reports: Number(row?.reports ?? 0),
    scanned: Number(row?.scanned ?? 0),
    imported: Number(row?.imported ?? 0)
  };
}

/**
 * The most recent messages that actually produced something, then the rest.
 *
 * A busy inbox pushes the one report of the day off the bottom of a list
 * ordered purely by time, which leaves the manager looking at eight
 * newsletters under a heading that says "Recent imports".
 */
export async function getRecentImports(ownerUserId: number, limit = 8) {
  const rows = await query<Record<string, string | number>>(
    `select subject, source, processing_status, rows_extracted, rows_inserted,
            rows_skipped_idempotent, rows_rejected, processed_at, attachment_name
     from documents d
     where owner_user_id = $1 and processing_status <> 'NO_DATA' and ${reportDocument('d')}
     order by processed_at desc limit $2`, [ownerUserId, limit]);
  return rows.map(r => ({
    subject: String(r.subject ?? ''), source: String(r.source),
    status: String(r.processing_status), extracted: Number(r.rows_extracted),
    inserted: Number(r.rows_inserted), skipped: Number(r.rows_skipped_idempotent),
    rejected: Number(r.rows_rejected), processedAt: String(r.processed_at),
    attachment: String(r.attachment_name ?? '')
  }));
}

/**
 * What the assistant made of each recent message, for the Inbox page.
 *
 * The Inbox is not a mail client and must not become one: this shows the
 * verdict, not the correspondence. A manager needs to know that Monday's
 * report was read and eighteen rows landed, and that a spreadsheet could not
 * be opened — not to browse their newsletters.
 */
/**
 * How many messages were checked and are not reports. A number only: their
 * subjects and senders are never shown anywhere in the app.
 */
export async function getOtherMessageCount(
  ownerUserId: number
): Promise<{ total: number; unreadable: number }> {
  const [r] = await query<{ n: number; unreadable: number }>(
    `select count(distinct coalesce(d.gmail_message_id, d.report_id))::int as n,
            -- A PDF, a picture or a private sheet that could not be opened. It
            -- may have been a report sent the wrong way, so it is counted —
            -- still without a subject or a sender.
            count(distinct coalesce(d.gmail_message_id, d.report_id)) filter (
              where d.classification in ('REVIEW_REQUIRED', 'UNSUPPORTED_FORMAT'))::int
              as unreadable
       from documents d
      where owner_user_id = $1 and d.source in ('email', 'attachment')
        and not ${reportDocument('d')}
        and not exists (select 1 from documents s
                         where s.owner_user_id = d.owner_user_id
                           and s.gmail_message_id = d.gmail_message_id
                           and ${reportDocument('s')})`, [ownerUserId]);
  return { total: Number(r?.n ?? 0), unreadable: Number(r?.unreadable ?? 0) };
}

export async function getInboxMessages(ownerUserId: number, limit = 15) {
  const rows = await query<Record<string, string | number | null>>(
    `select subject, sender, received_at, processing_status,
            coalesce(classification, 'NON_REPORT') as classification,
            confidence, evidence, department, rows_extracted, rows_inserted,
            rows_rejected, attachment_name, departments_count, departments_list
     from documents d
     where owner_user_id = $1
       -- Reports only. Every other message was checked and is never shown.
       and ${reportDocument('d')}
       and not exists (
         select 1 from documents s
          where s.owner_user_id = d.owner_user_id
            and s.gmail_message_id = d.gmail_message_id
            and s.rows_inserted > 0
            and s.report_id <> d.report_id)
     -- Reports and unfinished business first, newsletters last. Strict
     -- chronological order buries the one report of the day under whatever
     -- marketing arrived after it, which is exactly what a manager opening
     -- this page does not want to see.
     order by case coalesce(classification, 'NON_REPORT')
                when 'DEPARTMENTAL_REPORT' then 0
                when 'REVIEW_REQUIRED'     then 1
                when 'UNSUPPORTED_FORMAT'  then 2
                when 'POSSIBLE_REPORT'     then 3
                else 4 end,
              received_at desc nulls last, processed_at desc
     limit $2`, [ownerUserId, limit]);
  return rows.map(r => ({
    subject: String(r.subject ?? '(no subject)'),
    sender: String(r.sender ?? ''),
    receivedAt: r.received_at ? String(r.received_at) : '',
    classification: String(r.classification),
    confidence: r.confidence === null || r.confidence === undefined
      ? null : Number(r.confidence),
    evidence: String(r.evidence ?? ''),
    department: String(r.department ?? ''),
    extracted: Number(r.rows_extracted ?? 0),
    imported: Number(r.rows_inserted ?? 0),
    rejected: Number(r.rows_rejected ?? 0),
    attachment: String(r.attachment_name ?? ''),
    departmentsCount: Number(r.departments_count ?? 0),
    departmentsList: String(r.departments_list ?? '')
  }));
}

/**
 * Everything the department summaries need for one day.
 *
 * Defaults to the latest day anything was reported, because "today" at nine in
 * the morning is empty and a page that opens on nothing looks broken. The
 * dates offered are the recent days that have work, not the calendar.
 */
export async function getDepartmentDay(ownerUserId: number, date?: string) {
  const days = await query<{ d: string }>(
    `select distinct task_date::text as d from tasks
      where owner_user_id = $1 and work_kind <> 'PLANNED'
      order by 1 desc limit 45`, [ownerUserId]);
  const available = days.map(r => r.d);
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : available[0];
  // The roster is read even when there is no day to show, so an empty page can
  // still say which departments it is waiting for.
  const rosterRows = () => query<{ employee_name: string; department: string | null }>(
    `select employee_name, department from employees
      where active and not auto_created and department is not null and department <> ''`);
  if (!day) {
    const roster = await rosterRows();
    return {
      date: null as string | null, available, rows: [],
      roster: roster.map(r => ({ name: r.employee_name, department: String(r.department) })),
      isPerson: (_: string) => false
    };
  }

  const [rows, roster, isPerson] = await Promise.all([
    query<Record<string, string | number | null>>(
      `select coalesce(department, 'Unassigned') as department, employee_name, task,
              coalesce(task_category, '') as task_category, task_status,
              actual_duration, work_kind
         from tasks where owner_user_id = $1 and task_date = $2
        order by department, employee_name, task_id`, [ownerUserId, day]),
    rosterRows(),
    personFilter()
  ]);
  return {
    date: day as string | null,
    available,
    rows: rows.map(r => ({
      department: String(r.department), employee: String(r.employee_name ?? ''),
      task: String(r.task ?? ''), category: String(r.task_category ?? ''),
      status: String(r.task_status ?? ''),
      hours: r.actual_duration === null || r.actual_duration === undefined
        ? null : Number(r.actual_duration),
      workKind: String(r.work_kind ?? 'REPORTED')
    })),
    roster: roster.map(r => ({ name: r.employee_name, department: String(r.department) })),
    isPerson
  };
}
