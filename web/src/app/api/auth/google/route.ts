import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { isAuthenticated } from '@/lib/auth';
import { buildAuthUrl, googleConfigured } from '@/lib/google-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Starts the Google consent flow. */
export async function GET(req: Request) {
  if (!await isAuthenticated()) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
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
