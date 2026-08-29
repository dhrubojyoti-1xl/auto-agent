/**
 * Sessions.
 *
 * Identity comes from "Continue with Google". A signed, HttpOnly cookie
 * carries the user id, so every request knows whose data it may touch.
 *
 * APP_PASSWORD remains as a fallback identity (user id 1) so the app is usable
 * before a Google client is configured, and for the manual-entry page. It owns
 * its data like any other user rather than seeing everything.
 *
 * What this deliberately does NOT do: put anything in localStorage, put a token
 * in a URL, or let client-side JavaScript read the session.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'aa_session';
export const LOCAL_USER_ID = 1;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET is not set (needs at least 16 characters).');
  }
  return s;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface Session { userId: number; kind: 'google' | 'local' }

export function issueToken(userId: number, kind: 'google' | 'local'): string {
  const payload = `${userId}.${kind}.${Date.now()}.${randomBytes(8).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): Session | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [userId, kind, issued, nonce, mac] = parts;
  if (!safeEqual(mac, sign(`${userId}.${kind}.${issued}.${nonce}`))) return null;
  const age = (Date.now() - Number(issued)) / 1000;
  if (!Number.isFinite(age) || age < 0 || age >= MAX_AGE_SECONDS) return null;
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) return null;
  if (kind !== 'google' && kind !== 'local') return null;
  return { userId: id, kind };
}

export function checkPassword(candidate: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;
  // Hash both sides so the comparison never leaks the real password's length.
  const h = (s: string) => createHmac('sha256', 'pw').update(s).digest('hex');
  return safeEqual(h(candidate), h(expected));
}

export function passwordLoginEnabled(): boolean {
  return !!process.env.APP_PASSWORD;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: MAX_AGE_SECONDS
  };
}

/** The session, or null. Every data route must call this and scope by userId. */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return verifyToken(store.get(SESSION_COOKIE)?.value);
}

/** Convenience for routes that only need a yes/no. */
export async function isAuthenticated(): Promise<boolean> {
  return (await getSession()) !== null;
}

/**
 * Machine-to-machine auth for /api/ingest. Separate from the human session on
 * purpose: a leaked ingest token can add report data but cannot read anything.
 */
export function checkIngestToken(header: string | null): boolean {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return false;
  const provided = (header || '').replace(/^Bearer\s+/i, '').trim();
  if (!provided) return false;
  const h = (s: string) => createHmac('sha256', 'tok').update(s).digest('hex');
  return safeEqual(h(provided), h(expected));
}
