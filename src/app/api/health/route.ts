import { NextResponse } from 'next/server';
import { connectionStyle, query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public, but deliberately says nothing an attacker can use. */
export async function GET() {
  const checks: Record<string, string> = {};
  try {
    const rows = await query<{ count: number }>('select count(*)::int as count from tasks');
    checks.database = 'ok';
    checks.tasks = String(rows[0].count);
    checks.connection = connectionStyle();
    if (checks.connection === 'direct') {
      checks.connectionNote =
        'direct connection (5432): fine for a demo, switch to the pooler (6543) before real load';
    }
  } catch (e) {
    checks.database = 'error';
    checks.detail = (e as Error).message.slice(0, 120);
  }
  // Which build is actually serving this request. Without it, "I deployed the
  // fix" and "the fix is live" are two different claims with no way to tell
  // them apart.
  checks.commit = (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7);
  checks.deployedAt = process.env.VERCEL_DEPLOYMENT_ID ? 'vercel' : 'local';
  checks.region = process.env.VERCEL_REGION || 'local';

  try {
    const [s] = await query<{
      last_ok: string | null; last_fail: string | null; runs: number;
      scanned: number; reports: number; imported: number; rejected: number;
      duplicates: number;
    }>(
      `select max(started_at) filter (where status = 'OK')     as last_ok,
              max(started_at) filter (where status in ('FAILED','REAUTH_REQUIRED')) as last_fail,
              count(*)::int                    as runs,
              coalesce(sum(messages_scanned),0)::int as scanned,
              coalesce(sum(reports_found),0)::int    as reports,
              coalesce(sum(rows_imported),0)::int    as imported,
              coalesce(sum(rows_rejected),0)::int    as rejected,
              coalesce(sum(rows_duplicate),0)::int   as duplicates
       from sync_runs`);
    checks.lastSuccessfulSync = s?.last_ok ? String(s.last_ok).slice(0, 19).replace('T', ' ') : 'never';
    checks.lastFailedSync = s?.last_fail ? String(s.last_fail).slice(0, 19).replace('T', ' ') : 'never';
    checks.syncRuns = String(s?.runs ?? 0);
    checks.emailsScanned = String(s?.scanned ?? 0);
    checks.reportsFound = String(s?.reports ?? 0);
    checks.rowsImported = String(s?.imported ?? 0);
    checks.rowsRejected = String(s?.rejected ?? 0);
    checks.duplicatesBlocked = String(s?.duplicates ?? 0);
  } catch { checks.lastSuccessfulSync = 'unknown'; }

  checks.appPassword = process.env.APP_PASSWORD ? 'configured' : 'MISSING';
  checks.sessionSecret = process.env.SESSION_SECRET ? 'configured' : 'MISSING';
  checks.ingestToken = process.env.INGEST_TOKEN ? 'configured' : 'not set';
  checks.ai = process.env.ANTHROPIC_API_KEY ? 'configured' : 'disabled';
  checks.googleOauth = (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
    ? 'configured' : 'MISSING';
  checks.tokenEncryption = process.env.TOKEN_ENCRYPTION_KEY ? 'configured' : 'MISSING';
  checks.cronSecret = process.env.CRON_SECRET ? 'configured' : 'MISSING';
  try {
    const acc = await query<{ count: number; connected: string | null }>(
      `select count(*)::int as count, max(email) as connected
       from gmail_accounts where active`);
    checks.connectedInboxes = String(acc[0].count);
  } catch { checks.connectedInboxes = 'unknown'; }

  // Google OAuth, token encryption and the cron secret are what make the
  // product work unattended, so a deployment without them is not "ok".
  const ok = checks.database === 'ok' && checks.appPassword === 'configured' &&
             checks.sessionSecret === 'configured' &&
             checks.googleOauth === 'configured' &&
             checks.tokenEncryption === 'configured';
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
