import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { buildAuthUrl, googleConfigured } from '@/lib/google-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Starts the Google consent flow. */
/**
 * "Continue with Google". This is the primary sign-in, so it must work with no
 * existing session — one consent covers both identity and Gmail read access.
 */
export async function GET(req: Request) {
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL('/connect?error=not_configured', req.url));
  }
  const origin = new URL(req.url).origin;
  // CSRF: the state is echoed back by Google and must match the cookie, so a
  // forged callback cannot attach someone else's mailbox to this instance.
  const state = randomBytes(16).toString('hex');
  const res = NextResponse.redirect(buildAuthUrl(origin, state));
  res.cookies.set('g_state', state, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', path: '/', maxAge: 600
  });
  return res;
}
