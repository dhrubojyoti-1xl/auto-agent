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
  const ok = checks.database === 'ok' && checks.appPassword === 'configured' &&
             checks.sessionSecret === 'configured';
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
