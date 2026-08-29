import { NextResponse } from 'next/server';
import { generateReport } from '@/lib/reporting';
import { syncAllAccounts } from '@/lib/sync';
import { logEvent } from '@/lib/db';

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
    const summaries = await syncAllAccounts('cron');
    const imported = summaries.reduce((n, s) => n + s.rowsImported, 0);

    // Only regenerate the management report when something actually changed;
    // an unchanged report costs an AI call for nothing.
    let report = null;
    if (imported > 0) {
      const r = await generateReport('DAILY', undefined, true);
      report = { reportId: r.reportId, status: r.status, generator: r.generator };
    }
    await logEvent('INFO', 'Cron', 'sync', 'OK',
      `${summaries.length} account(s), ${imported} row(s) imported`);
    return NextResponse.json({ ok: true, summaries, report });
  } catch (e) {
    await logEvent('ERROR', 'Cron', 'sync', 'ERROR', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
