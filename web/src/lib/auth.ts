/**
 * Password + signed-cookie session.
 *
 * Deliberately minimal: this is an internal dashboard, not a consumer product.
 * What it does NOT do is as important as what it does — no password in the
 * bundle, no password in a URL, no token in localStorage, nothing readable by
 * client-side JavaScript.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'aa_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;      // 7 days

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  // A weak fallback would silently make sessions forgeable, so fail loudly.
  throw new Error('SESSION_SECRET is not set (needs at least 16 characters).');
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

/** Constant-time compare; a plain === leaks the answer through timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function issueToken(): string {
  const issued = Date.now();
  const nonce = randomBytes(8).toString('hex');
  const payload = `${issued}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [issued, nonce, mac] = parts;
  if (!safeEqual(mac, sign(`${issued}.${nonce}`))) return false;
  const age = (Date.now() - Number(issued)) / 1000;
  return Number.isFinite(age) && age >= 0 && age < MAX_AGE_SECONDS;
}

export function checkPassword(candidate: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) throw new Error('APP_PASSWORD is not set.');
  // Hash both sides first so the comparison length never reveals the real
  // password's length.
  const h = (s: string) => createHmac('sha256', 'pw').update(s).digest('hex');
  return safeEqual(h(candidate), h(expected));
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

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  return verifyToken(store.get(SESSION_COOKIE)?.value);
}

/**
 * Machine-to-machine auth for the ingest endpoint (used by the Apps Script
 * Gmail bridge). Separate from the human session on purpose: a leaked ingest
 * token can add report data, but cannot read the dashboard.
 */
export function checkIngestToken(header: string | null): boolean {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return false;
  const provided = (header || '').replace(/^Bearer\s+/i, '').trim();
  if (!provided) return false;
  const h = (s: string) => createHmac('sha256', 'tok').update(s).digest('hex');
  return safeEqual(h(provided), h(expected));
}
