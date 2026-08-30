import { NextResponse } from 'next/server';
import {
  checkPassword, issueToken, LOCAL_USER_ID, passwordLoginEnabled,
  SESSION_COOKIE, sessionCookieOptions
} from '@/lib/auth';
import { LIMITS, rateLimit } from '@/lib/rate-limit';
import { touchLocalUser } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Password sign-in — the fallback identity, used before a Google client is
 * configured. "Continue with Google" is the primary route (/api/auth/google).
 */
export async function POST(req: Request) {
  // Keyed by source address, because an unauthenticated caller has no user id
  // yet. A person typing a password cannot reach this; a script guessing one
  // reaches it immediately.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const limit = rateLimit(`login:${ip}`, LIMITS.login.limit, LIMITS.login.windowMs);
  if (!limit.ok) {
    return NextResponse.json(
      { error: `Too many sign-in attempts. Try again in ${limit.retryAfterSeconds}s.` },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } });
  }

  if (!passwordLoginEnabled()) {
    return NextResponse.json(
      { error: 'Password sign-in is disabled. Use Continue with Google.' }, { status: 400 });
  }
  let password = '';
  try {
    password = String((await req.json())?.password || '');
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  if (!password) return NextResponse.json({ error: 'Password required' }, { status: 400 });

  if (!checkPassword(password)) {
    // Vague and slow on purpose: no hint about how close the guess was.
    await new Promise(r => setTimeout(r, 600));
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
  }

  try { await touchLocalUser(); } catch { /* the database may not be up yet */ }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, issueToken(LOCAL_USER_ID, 'local'), sessionCookieOptions());
  return res;
}
