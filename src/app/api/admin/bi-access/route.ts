import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { query } from '@/lib/db';
import { LIMITS, rateLimit } from '@/lib/rate-limit';
import { safeErrorMessage } from '@/lib/safe-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Creates the read-only login a charting tool connects with.
 *
 * Doing this from the application rather than by hand exists for one reason:
 * the alternative is pasting the project's own database password into a
 * third-party tool, and that password can read and write everything, including
 * the table holding the encrypted Google refresh token.
 *
 * The role this creates can run SELECT against three reporting views and
 * nothing else. It cannot read the tasks table directly, cannot see a token,
 * and cannot write anything anywhere.
 *
 * The password is chosen by the person calling this and is never logged, never
 * stored, and never returned. If they lose it they call this again with a new
 * one, which is why the role is altered rather than refused when it exists.
 */
const ROLE = 'bi_reader';
const VIEWS = ['bi_tasks', 'bi_daily_by_department', 'bi_messages'] as const;

/** The connection details a BI tool needs, derived without exposing a secret. */
function connectionDetails(): {
  host: string; port: string; database: string; user: string
} | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const u = new URL(url);
    // Through Supabase's pooler the login is "<role>.<project-ref>", and the
    // project ref is the tail of the configured user. Direct connections use
    // the bare role name.
    const configured = decodeURIComponent(u.username || '');
    const ref = configured.includes('.') ? configured.split('.').slice(1).join('.') : '';
    // The app's own port is not the one a charting tool wants. Supabase runs
    // two poolers on the same host: 6543 is transaction mode, which suits a
    // serverless app but rejects the prepared statements every JDBC client
    // sends, so Looker Studio fails there in ways that read as random. 5432 is
    // session mode, which is what a reporting tool needs.
    const port = (u.port === '6543' || !u.port) ? '5432' : u.port;
    return {
      host: u.hostname,
      port,
      database: (u.pathname || '/postgres').replace(/^\//, '') || 'postgres',
      user: ref ? `${ROLE}.${ref}` : ROLE
    };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });

  const limit = rateLimit(`bi:${session.userId}`, LIMITS.report.limit, LIMITS.report.windowMs);
  if (!limit.ok) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${limit.retryAfterSeconds}s.` },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } });
  }

  const body = await req.json().catch(() => ({}));
  const password = String(body?.password ?? '');

  if (password.length < 12) {
    return NextResponse.json(
      { error: 'Choose a password of at least 12 characters. This login can read your ' +
               'reporting data, so it deserves a real one.' }, { status: 400 });
  }
  if (/[\\'"]/.test(password)) {
    // Rejected rather than escaped: a quote or backslash in a password that is
    // about to be pasted into a connection string causes failures nobody can
    // diagnose, and the fix is simply to choose a different password.
    return NextResponse.json(
      { error: 'Avoid quotes and backslashes — they break connection strings in ways ' +
               'that are hard to diagnose later. Letters, digits and other punctuation ' +
               'are fine.' }, { status: 400 });
  }

  const details = connectionDetails();
  if (!details) {
    return NextResponse.json(
      { error: 'This deployment has no database connection configured.' }, { status: 500 });
  }

  try {
    const [{ exists }] = await query<{ exists: boolean }>(
      `select exists(select 1 from pg_roles where rolname = $1) as exists`, [ROLE]);

    // The whole operation lives in a database function, because a DO block
    // cannot take parameters — its body is a string literal, so a $1 inside it
    // is never bound, and the attempt fails with "bind message supplies 2
    // parameters, but prepared statement requires 0". A function can, so the
    // password arrives as a real argument and reaches the DDL through
    // format(%L) rather than being concatenated into it.
    await query(`select create_bi_reader($1)`, [password]);

    return NextResponse.json({
      ok: true,
      created: !exists,
      ...details,
      views: VIEWS,
      note: 'The password is not stored anywhere and cannot be shown again. ' +
            'Run this once more with a new one if it is lost.'
    });
  } catch (e) {
    return NextResponse.json({ error: safeErrorMessage(e, 300) }, { status: 500 });
  }
}
