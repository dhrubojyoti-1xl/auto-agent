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
    return {
      host: u.hostname,
      port: u.port || '5432',
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
    // The password is passed as a parameter to format(), never concatenated,
    // so its contents cannot become SQL.
    const [{ exists }] = await query<{ exists: boolean }>(
      `select exists(select 1 from pg_roles where rolname = $1) as exists`, [ROLE]);

    await query(
      exists
        ? `do $do$ begin execute format('alter role %I with login password %L', $1, $2); end $do$`
        : `do $do$ begin execute format('create role %I with login password %L', $1, $2); end $do$`,
      [ROLE, password]);

    await query(`do $do$ begin
                   execute format('grant connect on database %I to %I',
                                  current_database(), $1);
                 end $do$`, [ROLE]);
    await query(`grant usage on schema public to ${ROLE}`);
    for (const view of VIEWS) {
      await query(`grant select on ${view} to ${ROLE}`);
    }
    // Nothing else, ever. Explicitly revoked in case a previous grant was wider.
    await query(`revoke all on all tables in schema public from ${ROLE}`);
    for (const view of VIEWS) {
      await query(`grant select on ${view} to ${ROLE}`);
    }

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
