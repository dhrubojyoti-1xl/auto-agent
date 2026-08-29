import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { syncAllAccounts } from '@/lib/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** "Sync now". The cron does this automatically; this is for impatience. */
export async function POST() {
  if (!await isAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }
  try {
    const summaries = await syncAllAccounts('manual');
    return NextResponse.json({ ok: true, summaries });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
