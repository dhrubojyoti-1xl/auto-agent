import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { LIMITS, rateLimit } from '@/lib/rate-limit';
import { syncAllAccounts } from '@/lib/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** "Sync now". The cron does this automatically; this is for impatience. */
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });

  const limit = rateLimit(`sync:${session.userId}`, LIMITS.sync.limit, LIMITS.sync.windowMs);
  if (!limit.ok) {
    return NextResponse.json(
      { error: `Sync is already running for this inbox. Try again in ${limit.retryAfterSeconds}s.` },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } });
  }
  try {
    // Only this user's inboxes; a manual sync must not touch anyone else's.
    const summaries = await syncAllAccounts('manual', session.userId);
    return NextResponse.json({ ok: true, summaries });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
