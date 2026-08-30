import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Delete this user's operational data so production starts clean.
 *
 * Removes: tasks, ingested documents, data-quality rows, repeat groups,
 *          generated reports, sync history, and any employee the importer
 *          invented — those carry a department guessed from a report that is
 *          now deleted, and leaving them behind mis-files later reports.
 * Keeps:   the Gmail connection, configured employees, the department master,
 *          status and header aliases — configuration, not data.
 *
 * Scoped to the signed-in user, so it can never clear another tenant's data.
 * Requires an explicit {"confirm": "DELETE"} body, because an accidental POST
 * to this route should do nothing at all.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (body?.confirm !== 'DELETE') {
    return NextResponse.json(
      { error: 'Send {"confirm":"DELETE"} to proceed. Nothing was deleted.' },
      { status: 400 });
  }

  const uid = session.userId;
  const before = await counts(uid);

  // Order matters: children before parents, or the FK to documents blocks it.
  await query('delete from tasks where owner_user_id = $1', [uid]);
  await query('delete from data_quality where owner_user_id = $1', [uid]);
  await query('delete from repeat_groups where owner_user_id = $1', [uid]);
  await query('delete from ai_reports where owner_user_id = $1', [uid]);
  await query('delete from documents where owner_user_id = $1', [uid]);
  await query('delete from sync_runs where owner_user_id = $1', [uid]);
  // Employees the importer invented, now that the reports they came from are
  // gone. Configured employees are untouched.
  const wiped = await query<{ employee_id: string }>(
    `delete from employees where auto_created returning employee_id`);

  // Forget which Gmail messages were seen, so a fresh sync re-reads the inbox
  // rather than skipping everything as already-processed.
  await query(
    `update gmail_accounts set last_sync_at = null, last_sync_status = null,
       last_sync_message = null where owner_user_id = $1`, [uid]);

  return NextResponse.json({
    ok: true,
    deleted: { ...before, autoCreatedEmployees: wiped.length },
    remaining: await counts(uid)
  });
}

async function counts(uid: number) {
  const [r] = await query<Record<string, number>>(
    `select
       (select count(*)::int from tasks where owner_user_id = $1)         as tasks,
       (select count(*)::int from documents where owner_user_id = $1)     as documents,
       (select count(*)::int from data_quality where owner_user_id = $1)  as data_quality,
       (select count(*)::int from repeat_groups where owner_user_id = $1) as repeat_groups,
       (select count(*)::int from ai_reports where owner_user_id = $1)    as ai_reports,
       (select count(*)::int from sync_runs where owner_user_id = $1)     as sync_runs`,
    [uid]);
  return r;
}
