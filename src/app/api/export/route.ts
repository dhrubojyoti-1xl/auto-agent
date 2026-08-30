import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Owner-scoped export — the recovery story on a free Supabase plan.
 *
 * Point-in-time recovery is a paid feature, so the practical answer is that
 * everything derived can be rebuilt and everything reported can be re-read
 * from Gmail; what genuinely cannot be reconstructed is the manual corrections
 * and the master data. This endpoint hands all of it back as one file the
 * manager can keep.
 *
 * `format=csv` returns the task rows for a spreadsheet; `format=json` (the
 * default) returns tasks, rejections, master data and import history together,
 * which is what an actual restore needs.
 *
 * Analysis output is deliberately excluded: repeat groups and slow-task flags
 * are recomputed from the tasks by "Rebuild analysis", so exporting them would
 * only create a second copy that can disagree with the first.
 */
const MAX_ROWS = 50_000;

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map(r => cols.map(c => csvEscape(r[c])).join(','))].join('\n');
}

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });

  const uid = session.userId;
  const format = new URL(req.url).searchParams.get('format') === 'csv' ? 'csv' : 'json';
  const stamp = new Date().toISOString().slice(0, 10);

  const tasks = await query<Record<string, unknown>>(
    `select task_id, task_date, department, employee_name, employee_id, task,
            task_category, task_status, priority, start_date, start_time,
            completion_date, completion_time, expected_duration, actual_duration,
            duration_basis, link, source_document_id, imported_at,
            data_quality_status, data_quality_notes, task_fingerprint, notes
     from tasks where owner_user_id = $1
     order by task_date, employee_name, task_id limit ${MAX_ROWS}`, [uid]);

  if (format === 'csv') {
    return new NextResponse(toCsv(tasks), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="tasks-${stamp}.csv"`
      }
    });
  }

  const [rejections, documents, employees, departments, categories, accounts] = await Promise.all([
    query(`select report_id, document_id, table_index, row_index, rejection_reason,
                  rejection_detail, raw_row, claimed_date, logged_at, resolution_status
           from data_quality where owner_user_id = $1 order by logged_at limit ${MAX_ROWS}`, [uid]),
    query(`select report_id, document_id, source, subject, sender, sender_domain,
                  department, report_date, received_at, processing_status, tables_found,
                  rows_extracted, rows_inserted, rows_skipped_idempotent, rows_rejected,
                  error_message, processed_at, gmail_message_id
           from documents where owner_user_id = $1 order by processed_at limit ${MAX_ROWS}`, [uid]),
    query(`select employee_id, employee_name, name_aliases, department, active,
                  auto_created, joining_date, role, email from employees`),
    query(`select department_id, department_name, name_aliases, manager, manager_email,
                  sender_domains, active from departments`),
    query(`select category_id, category_name, match_keywords, expected_duration, active, notes
           from task_categories`),
    // Deliberately no refresh tokens: an export is a file that gets emailed
    // around, and a Gmail grant must never travel in one.
    query(`select email, display_name, connected_at, last_sync_at, last_sync_status
           from gmail_accounts where owner_user_id = $1`, [uid])
  ]);

  return NextResponse.json({
    exportedAt: new Date().toISOString(),
    schemaVersion: 4,
    ownerUserId: uid,
    note: 'Restore order: schema + migrations, then master data (departments, ' +
          'employees, categories), then tasks, then data_quality. Repeat groups ' +
          'and slow-task flags are recomputed by "Rebuild analysis" and are not ' +
          'included. Gmail refresh tokens are never exported; reconnect the ' +
          'inbox after a restore.',
    counts: {
      tasks: tasks.length, rejections: rejections.length, documents: documents.length,
      employees: employees.length, departments: departments.length,
      categories: categories.length, gmailAccounts: accounts.length
    },
    truncated: tasks.length >= MAX_ROWS,
    tasks, rejections, documents,
    masters: { employees, departments, categories },
    gmailAccounts: accounts
  }, {
    headers: {
      'content-disposition': `attachment; filename="auto-agent-export-${stamp}.json"`
    }
  });
}
