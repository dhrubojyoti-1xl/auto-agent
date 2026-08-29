import { NextResponse } from 'next/server';
import { generateReport } from '@/lib/reporting';
import { syncAllAccounts } from '@/lib/sync';
import { logEvent, query } from '@/lib/db';

/** Users whose inboxes produced rows in the last few minutes. */
async function ownersWithNewRows(): Promise<number[]> {
  const rows = await query<{ owner_user_id: number }>(
    `select distinct owner_user_id from tasks
     where imported_at > now() - interval '15 minutes'`);
  return rows.map(r => Number(r.owner_user_id));
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The unattended loop. Vercel Cron calls this on a schedule (vercel.json).
 *
 * Vercel signs cron invocations with CRON_SECRET; requiring it stops anyone on
 * the internet from driving the mailbox reader.
 */
function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization') || '';
  return header === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }
  try {
    // null = every connected inbox across every user. This is the unattended
    // loop, so it is the one place that legitimately crosses users.
    const summaries = await syncAllAccounts('cron', null);
    const imported = summaries.reduce((n, s) => n + s.rowsImported, 0);

    // Only regenerate the management report when something actually changed;
    // an unchanged report costs an AI call for nothing.
    // Regenerate each affected user's summary, not one global report.
    const reports: { reportId: string; status: string; generator: string }[] = [];
    if (imported > 0) {
      const owners = await ownersWithNewRows();
      for (const uid of owners) {
        const r = await generateReport('DAILY', uid, undefined, true);
        reports.push({ reportId: r.reportId, status: r.status, generator: r.generator });
      }
    }
    await logEvent('INFO', 'Cron', 'sync', 'OK',
      `${summaries.length} account(s), ${imported} row(s) imported`);
    return NextResponse.json({ ok: true, summaries, reports });
  } catch (e) {
    await logEvent('ERROR', 'Cron', 'sync', 'ERROR', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
