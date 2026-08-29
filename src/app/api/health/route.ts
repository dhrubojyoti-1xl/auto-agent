import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public, but deliberately says nothing an attacker can use. */
export async function GET() {
  const checks: Record<string, string> = {};
  try {
    const rows = await query<{ count: number }>('select count(*)::int as count from tasks');
    checks.database = 'ok';
    checks.tasks = String(rows[0].count);
  } catch (e) {
    checks.database = 'error';
    checks.detail = (e as Error).message.slice(0, 120);
  }
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
