import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { syncAllAccounts } from '@/lib/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** "Sync now". The cron does this automatically; this is for impatience. */
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  try {
    // Only this user's inboxes; a manual sync must not touch anyone else's.
    const summaries = await syncAllAccounts('manual', session.userId);
    return NextResponse.json({ ok: true, summaries });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
