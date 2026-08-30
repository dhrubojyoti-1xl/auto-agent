/**
 * Data access. One implementation, used both locally and on Supabase, because
 * Supabase *is* Postgres — talking to it over the connection string avoids a
 * second code path that only production exercises.
 *
 * Serverless note: use the Supabase POOLER connection string (port 6543).
 * A direct connection (5432) exhausts Postgres connections under Vercel's
 * per-request isolation.
 */
import { Pool, types } from 'pg';
import type { RejectedRow, TaskRecord } from './core/types';
import type { RepeatGroup } from './core/analysis';

// Return DATE columns as plain yyyy-mm-dd strings. Letting node-postgres build
// a Date object silently shifts a business date across a timezone boundary,
// which is how "Monday's report" ends up filed under Sunday.
types.setTypeParser(1082, (v: string) => v);

let pool: Pool | null = null;

export function getPool(): Pool {
  // Nothing in production ends the pool; test suites do, and a suite that
  // ended it used to make every suite after it in the same file fail with
  // "Cannot use a pool after calling end" — reported as *skipped*, which is a
  // very quiet way to stop running assertions. Closing now clears the handle
  // (see below), so the next caller simply gets a new pool.
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Use the Supabase connection pooler string ' +
      '(Project Settings -> Database -> Connection pooling, port 6543).'
    );
  }
  // Supabase exposes two connection styles and the difference matters here.
  //
  //   pooler (Supavisor, port 6543)  one shared server-side pool
  //   direct (db.<ref>.supabase.co)  a real Postgres connection per client
  //
  // Vercel gives every request its own isolate, so a direct connection opens a
  // fresh pool per isolate and a Nano instance (60 connections) is exhausted
  // under modest load. It works fine for a demo or a single manager, so rather
  // than refuse it we clamp the pool to one connection and say so.
  const isDirect = isDirectConnection(connectionString);
  const max = Number(process.env.PG_POOL_MAX || (isDirect ? 1 : 3));
  if (isDirect && !warnedAboutDirect) {
    warnedAboutDirect = true;
    console.warn(
      '[db] DATABASE_URL is a DIRECT Postgres connection (port 5432). Pool size ' +
      'clamped to 1. This is fine for a demo; switch to the Supabase transaction ' +
      'pooler (port 6543) before real load, or connections will be exhausted.'
    );
  }
  const created = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: isDirect ? 5_000 : 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: /supabase|amazonaws|render|neon/i.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined
  });
  // Closing forgets the handle, so a later caller opens a fresh pool instead
  // of throwing. Arguments are passed straight through: pg's end() accepts an
  // optional callback, and swallowing it makes the call never resolve.
  const originalEnd = created.end.bind(created);
  created.end = ((...args: Parameters<Pool['end']>) => {
    if (pool === created) pool = null;
    return originalEnd(...args);
  }) as Pool['end'];
  pool = created;
  return pool;
}

let warnedAboutDirect = false;

/** True for Supabase's direct endpoint or any plain 5432 connection. */
export function isDirectConnection(connectionString: string): boolean {
  if (/pooler\.supabase\.com/i.test(connectionString)) return false;
  if (/^db\.[a-z0-9]+\.supabase\.co$/i.test(hostOf(connectionString))) return true;
  return /:5432\b/.test(connectionString);
}

export function hostOf(connectionString: string): string {
  try { return new URL(connectionString).hostname; } catch { return ''; }
}

/** For /api/health: which style is configured, without revealing credentials. */
export function connectionStyle(): 'pooler' | 'direct' | 'unknown' {
  const cs = process.env.DATABASE_URL;
  if (!cs) return 'unknown';
  return isDirectConnection(cs) ? 'direct' : 'pooler';
}

export async function query<T = Record<string, unknown>>(
  text: string, params: unknown[] = []
): Promise<T[]> {
  const res = await getPool().query(text, params);
  return res.rows as T[];
}

/* -------------------------------------------------------------------------- */
/* Masters                                                                     */
/* -------------------------------------------------------------------------- */

import type { Category, Department, Employee, Masters, Field } from './core/types';

export async function loadMasters(): Promise<Masters> {
  const [employees, departments, categories, statusAliases, headerAliases] = await Promise.all([
    query<{ employee_id: string; employee_name: string; name_aliases: string[];
            department: string | null; active: boolean }>(
      'select employee_id, employee_name, name_aliases, department, active from employees'),
    query<{ department_id: string; department_name: string; name_aliases: string[];
            sender_domains: string[] }>(
      'select department_id, department_name, name_aliases, sender_domains from departments where active'),
    query<{ category_id: string; category_name: string; match_keywords: string[];
            expected_duration: string | null }>(
      'select category_id, category_name, match_keywords, expected_duration from task_categories where active'),
    query<{ alias: string; canonical_status: string }>('select alias, canonical_status from status_aliases'),
    query<{ alias: string; canonical_field: string }>('select alias, canonical_field from header_aliases')
  ]);

  return {
    employees: employees.map<Employee>(e => ({
      id: e.employee_id, name: e.employee_name, aliases: e.name_aliases || [],
      department: e.department || '', active: e.active
    })),
    departments: departments.map<Department>(d => ({
      id: d.department_id, name: d.department_name,
      aliases: d.name_aliases || [], senderDomains: d.sender_domains || []
    })),
    categories: categories.map<Category>(c => ({
      id: c.category_id, name: c.category_name, keywords: c.match_keywords || [],
      expectedDuration: c.expected_duration === null ? null : Number(c.expected_duration)
    })),
    statusAliases: Object.fromEntries(statusAliases.map(r => [r.alias, r.canonical_status])),
    headerAliases: Object.fromEntries(
      headerAliases.map(r => [r.alias, r.canonical_field as Field])
    )
  };
}

/* -------------------------------------------------------------------------- */
/* Fingerprints — the idempotency index                                        */
/* -------------------------------------------------------------------------- */

/** Fingerprints for ONE user. Duplicate detection is per mailbox, not global. */
export async function loadFingerprints(ownerUserId: number): Promise<Map<string, string>> {
  const rows = await query<{ task_fingerprint: string; source_document_id: string }>(
    'select task_fingerprint, source_document_id from tasks where owner_user_id = $1',
    [ownerUserId]
  );
  return new Map(rows.map(r => [r.task_fingerprint, r.source_document_id]));
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

export async function loadTasks(ownerUserId: number): Promise<TaskRecord[]> {
  const rows = await query<Record<string, unknown>>(
    `select task_id, report_id, task_date, department, employee_name, employee_id,
            task, task_normalized, task_category, task_status, priority,
            start_date, start_time, completion_date, completion_time,
            expected_duration, actual_duration, duration_basis, link,
            source_document_id, source_document_date, data_quality_status,
            data_quality_notes, task_fingerprint, notes, work_kind, extraction_source
     from tasks where owner_user_id = $1
     order by task_date, employee_name, task_id`, [ownerUserId]
  );
  return rows.map(rowToTask);
}

function rowToTask(r: Record<string, unknown>): TaskRecord {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const time = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 5));
  return {
    taskId: String(r.task_id), reportId: String(r.report_id ?? ''),
    date: String(r.task_date), department: String(r.department ?? ''),
    employeeName: String(r.employee_name), employeeId: String(r.employee_id ?? ''),
    task: String(r.task), taskNormalized: String(r.task_normalized),
    taskCategory: String(r.task_category ?? ''),
    taskStatus: String(r.task_status) as TaskRecord['taskStatus'],
    priority: String(r.priority ?? ''),
    startDate: r.start_date ? String(r.start_date) : null,
    startTime: time(r.start_time),
    completionDate: r.completion_date ? String(r.completion_date) : null,
    completionTime: time(r.completion_time),
    workKind: String(r.work_kind ?? 'REPORTED'),
    extractionSource: String(r.extraction_source ?? 'table'),
    expectedDuration: num(r.expected_duration), actualDuration: num(r.actual_duration),
    durationBasis: String(r.duration_basis) as TaskRecord['durationBasis'],
    link: String(r.link ?? ''), sourceDocumentId: String(r.source_document_id),
    sourceDocumentDate: r.source_document_date ? new Date(String(r.source_document_date)).toISOString() : '',
    dataQualityStatus: String(r.data_quality_status) as TaskRecord['dataQualityStatus'],
    dataQualityNotes: String(r.data_quality_notes ?? ''),
    taskFingerprint: String(r.task_fingerprint), notes: String(r.notes ?? '')
  };
}

/**
 * Inserts accepted rows. ON CONFLICT DO NOTHING makes the database itself the
 * final idempotency backstop, so even a race between two concurrent ingests
 * cannot create a duplicate.
 * Returns how many rows were actually written.
 */
export async function insertTasks(tasks: TaskRecord[], ownerUserId: number): Promise<number> {
  if (!tasks.length) return 0;
  const client = await getPool().connect();
  try {
    await client.query('begin');
    let written = 0;
    for (const t of tasks) {
      const res = await client.query(
        `insert into tasks (
           task_id, report_id, task_date, department, employee_name, employee_id,
           task, task_normalized, task_category, task_status, priority,
           start_date, start_time, completion_date, completion_time,
           expected_duration, actual_duration, duration_basis, link,
           source_document_id, source_document_date, data_quality_status,
           data_quality_notes, task_fingerprint, notes, owner_user_id, work_kind,
           extraction_source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
         on conflict (owner_user_id, task_fingerprint) do nothing`,
        [t.taskId, t.reportId || null, t.date, t.department, t.employeeName, t.employeeId,
         t.task, t.taskNormalized, t.taskCategory || null, t.taskStatus, t.priority || null,
         t.startDate, t.startTime, t.completionDate, t.completionTime,
         t.expectedDuration, t.actualDuration, t.durationBasis, t.link || null,
         t.sourceDocumentId, t.sourceDocumentDate || null, t.dataQualityStatus,
         t.dataQualityNotes || null, t.taskFingerprint, t.notes || null, ownerUserId,
         t.workKind || 'REPORTED', t.extractionSource || 'table']
      );
      written += res.rowCount ?? 0;
    }
    await client.query('commit');
    return written;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function insertRejections(
  rows: RejectedRow[], claimedDates: (string | null)[], ownerUserId: number
): Promise<number> {
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    await query(
      `insert into data_quality
         (report_id, document_id, table_index, row_index, rejection_reason,
          rejection_detail, raw_row, claimed_date, owner_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (owner_user_id, document_id, table_index, row_index, rejection_reason)
       do nothing`,
      [r.reportId, r.documentId, r.tableIndex, r.rowIndex, r.reason,
       r.detail, JSON.stringify(r.raw), claimedDates[i], ownerUserId]
    );
  }
  return rows.length;
}

export async function upsertDocument(d: {
  ownerUserId: number;
  reportId: string; documentId: string; source: string; subject: string;
  sender: string; senderDomain: string; department: string; reportDate: string | null;
  receivedAt: string; status: string; tablesFound: number; rowsExtracted: number;
  rowsInserted: number; rowsSkipped: number; rowsRejected: number; error: string;
}): Promise<void> {
  await query(
    `insert into documents (report_id, document_id, source, subject, sender, sender_domain,
       department, report_date, received_at, processing_status, tables_found,
       rows_extracted, rows_inserted, rows_skipped_idempotent, rows_rejected,
       error_message, owner_user_id, processed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
     on conflict (owner_user_id, report_id) do update set
       processing_status = excluded.processing_status,
       tables_found = excluded.tables_found,
       rows_extracted = excluded.rows_extracted,
       rows_inserted = documents.rows_inserted + excluded.rows_inserted,
       rows_skipped_idempotent = excluded.rows_skipped_idempotent,
       rows_rejected = excluded.rows_rejected,
       error_message = excluded.error_message,
       processed_at = now()`,
    [d.reportId, d.documentId, d.source, d.subject, d.sender, d.senderDomain,
     d.department || null, d.reportDate, d.receivedAt, d.status, d.tablesFound,
     d.rowsExtracted, d.rowsInserted, d.rowsSkipped, d.rowsRejected, d.error || null,
     d.ownerUserId]
  );
}

/**
 * Employees the importer met in a report and had to invent a record for.
 *
 * They are marked, because an invented employee is derived data wearing
 * configuration's clothes: its department is a guess taken from whichever
 * report it first appeared in, and that guess goes on to decide where later
 * rows are filed. Marking them lets a purge remove them with the data they
 * came from, and lets the Data quality page show the manager who the
 * assistant assumed existed.
 */
export async function upsertEmployees(employees: Employee[]): Promise<void> {
  for (const e of employees) {
    await query(
      `insert into employees (employee_id, employee_name, name_aliases, department,
                              active, auto_created)
       values ($1,$2,$3,$4,true,true)
       on conflict (employee_id) do nothing`,
      [e.id, e.name, e.aliases, e.department || null]
    );
  }
}

/** Writes the analysis flags back onto the task rows, in one statement each. */
export interface SlowDetail { source: string; sample: number; reason: string; expected: number }

export async function writeAnalysisFlags(
  repeat: Map<string, string>,
  slowFlag: Map<string, string>,
  variance: Map<string, number | null>,
  ownerUserId: number,
  slowDetail: Map<string, SlowDetail> = new Map()
): Promise<void> {
  const ids = [...slowFlag.keys()];
  if (!ids.length) return;
  await query(
    `update tasks t set
       repeated_task_flag = v.repeated,
       repeat_classification = nullif(v.classification, ''),
       slow_task_flag = v.slow_flag,
       slow_variance_hours = v.variance,
       slow_baseline_source = nullif(v.baseline_source, ''),
       slow_baseline_sample = nullif(v.baseline_sample, 0),
       slow_reason = nullif(v.reason, ''),
       -- A learned baseline is shown as the expectation, so the dashboard and
       -- the stored row cannot disagree about what "expected" meant.
       expected_duration = coalesce(t.expected_duration, nullif(v.expected, 0))
     from (
       select unnest($1::text[]) as task_id,
              unnest($2::boolean[]) as repeated,
              unnest($3::text[]) as classification,
              unnest($4::text[]) as slow_flag,
              unnest($5::numeric[]) as variance,
              unnest($7::text[]) as baseline_source,
              unnest($8::int[]) as baseline_sample,
              unnest($9::text[]) as reason,
              unnest($10::numeric[]) as expected
     ) v
     where t.task_id = v.task_id and t.owner_user_id = $6`,
    [ids,
     ids.map(id => repeat.has(id)),
     ids.map(id => repeat.get(id) ?? ''),
     ids.map(id => slowFlag.get(id) ?? 'INSUFFICIENT_DATA'),
     ids.map(id => variance.get(id) ?? null), ownerUserId,
     ids.map(id => slowDetail.get(id)?.source ?? ''),
     ids.map(id => slowDetail.get(id)?.sample ?? 0),
     ids.map(id => slowDetail.get(id)?.reason ?? ''),
     ids.map(id => slowDetail.get(id)?.expected ?? 0)]
  );
}

export async function replaceRepeatGroups(
  groups: RepeatGroup[], ownerUserId: number
): Promise<void> {
  // Repeat groups are a derived cache; rebuilding wholesale is correct and
  // cheaper than diffing. Scoped, or one user's rebuild wipes another's.
  await query('delete from repeat_groups where owner_user_id = $1', [ownerUserId]);
  for (const g of groups) {
    await query(
      `insert into repeat_groups (repeat_key, employee, department, task, normalized_task,
         occurrence_count, distinct_dates, max_same_day_count, first_date, last_date,
         dates, completed_count, open_count, classification, classification_reason,
         owner_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [g.repeatKey, g.employee, g.department, g.task, g.normalizedTask,
       g.occurrenceCount, g.distinctDates, g.maxSameDayCount, g.firstDate, g.lastDate,
       g.dates, g.completedCount, g.openCount, g.classification, g.classificationReason,
       ownerUserId]
    );
  }
}

export async function logEvent(
  level: string, component: string, action: string, status: string,
  message: string, documentId?: string, reportId?: string, details?: unknown
): Promise<void> {
  try {
    await query(
      `insert into system_log (level, component, action, status, message, document_id, report_id, details)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [level, component, action, status, message.slice(0, 2000),
       documentId || null, reportId || null, details ? JSON.stringify(details) : null]
    );
  } catch {
    // Logging must never take the request down with it.
  }
}
