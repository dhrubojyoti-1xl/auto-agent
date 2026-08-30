/**
 * The read-only login a charting tool connects with.
 *
 * The alternative is pasting the project's own database password into a
 * third-party tool, and that password can read and write everything —
 * including the table holding the encrypted Google refresh token. This role
 * can run SELECT against three reporting views and nothing else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(
  join(process.cwd(), 'src/app/api/admin/bi-access/route.ts'), 'utf8');
/** The DDL itself lives in a function, because a DO block cannot take parameters. */
const FUNCTION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/014_bi_reader_function.sql'), 'utf8');

describe('the login it creates is genuinely limited', () => {
  it('grants select on exactly the three reporting views', () => {
    expect(FUNCTION_SQL).toMatch(/'bi_tasks', 'bi_daily_by_department', 'bi_messages'/);
    // Everything else in the schema is revoked, in case an earlier version of
    // this function granted more.
    expect(FUNCTION_SQL).toMatch(/revoke all on all tables in schema public/);
  });

  it('never grants insert, update, delete or ownership', () => {
    for (const forbidden of ['grant insert', 'grant update', 'grant delete',
                             'grant all', 'superuser', 'createdb', 'createrole']) {
      expect(FUNCTION_SQL.toLowerCase(), forbidden).not.toContain(forbidden);
      expect(SOURCE.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it('pins the search path, so the function cannot be redirected', () => {
    expect(FUNCTION_SQL).toMatch(/set search_path = pg_catalog, public/);
  });

  it('is not callable by everybody', () => {
    expect(FUNCTION_SQL).toMatch(/revoke all on function create_bi_reader\(text\) from public/);
  });

  it('is reachable only by a signed-in session', () => {
    expect(SOURCE).toMatch(/getSession\(\)/);
    expect(SOURCE).toMatch(/Unauthorised.*401|401.*Unauthorised/s);
  });

  it('is rate limited, because it runs DDL', () => {
    expect(SOURCE).toMatch(/rateLimit\(/);
  });
});

describe('the password is handled as a password', () => {
  it('is never concatenated into SQL', () => {
    // format(%L) quotes it as a literal; string interpolation of a password
    // into DDL is how a quote character becomes a syntax error at best.
    expect(FUNCTION_SQL).toMatch(/format\('(create|alter) role %I with login password %L'/);
    expect(SOURCE).not.toMatch(/\$\{password\}/);
    // Passed as a bound parameter, not built into the statement.
    expect(SOURCE).toMatch(/create_bi_reader\(\$1\)`, \[password\]/);
  });

  it('does not use a DO block, which cannot take parameters at all', () => {
    expect(SOURCE).not.toMatch(/do \$do\$/);
  });

  it('is never returned to the caller or logged', () => {
    const response = SOURCE.slice(SOURCE.indexOf('return NextResponse.json({\n      ok: true'));
    expect(response).not.toContain('password,');
    expect(response).not.toMatch(/password:\s*password/);
    expect(SOURCE).not.toMatch(/console\.(log|warn|error)\([^)]*password/);
  });

  it('refuses one too short to be worth having', () => {
    expect(SOURCE).toMatch(/password\.length < 12/);
  });

  it('refuses characters that break a connection string', () => {
    expect(SOURCE).toMatch(/\[\\\\'"\]/);
  });
});

describe('the connection details it reports', () => {
  it('derives the pooler username from the configured one', () => {
    // Supabase's pooler expects "<role>.<project-ref>"; a bare role name is
    // rejected, and that is the single most common setup failure.
    expect(SOURCE).toMatch(/\$\{ROLE\}\.\$\{ref\}/);
  });

  it('never returns the configured connection string itself', () => {
    expect(SOURCE).not.toMatch(/DATABASE_URL[^;]*return/);
    const returned = SOURCE.slice(SOURCE.indexOf('ok: true'), SOURCE.indexOf('});', SOURCE.indexOf('ok: true')));
    for (const leak of ['DATABASE_URL', 'u.password', 'connectionString']) {
      expect(returned, leak).not.toContain(leak);
    }
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

d('it actually runs', () => {
  /*
   * The source-inspection tests above all passed against a version of this
   * that could never work: the DDL was in a DO block, whose body is a string
   * literal, so the bound parameters were never placeholders and every call
   * failed with "bind message supplies 2 parameters, but prepared statement
   * requires 0". Reading code is not running it.
   */
  let db: any, seedDb: any;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    const { resetDatabase } = await import('./helpers');
    await resetDatabase(db, seedDb, { demo: false });
    await db.query('drop role if exists bi_reader');
  });

  afterAll(async () => {
    await db.query('drop owned by bi_reader').catch(() => {});
    await db.query('drop role if exists bi_reader').catch(() => {});
    await db.getPool().end();
  });

  it('creates a login that can sign in and is not privileged', async () => {
    await db.query('select create_bi_reader($1)', ['a-real-test-password-123']);
    const [role] = await db.query(
      `select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
       from pg_roles where rolname = 'bi_reader'`);
    expect(role.rolcanlogin).toBe(true);
    expect(role.rolsuper).toBe(false);
    expect(role.rolcreaterole).toBe(false);
    expect(role.rolcreatedb).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });

  it('can read the three reporting views and nothing else at all', async () => {
    const grants = await db.query(
      `select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'bi_reader' order by table_name, privilege_type`);
    expect(grants.map((g: any) => `${g.table_name}:${g.privilege_type}`)).toEqual([
      'bi_daily_by_department:SELECT', 'bi_messages:SELECT', 'bi_tasks:SELECT'
    ]);
  });

  it('cannot reach the table holding the Google token', async () => {
    const reachable = await db.query(
      `select count(*)::int as n from information_schema.role_table_grants
       where grantee = 'bi_reader' and table_name in ('gmail_accounts','tasks','users')`);
    expect(reachable[0].n).toBe(0);
  });

  it('can be run again to change the password', async () => {
    await expect(db.query('select create_bi_reader($1)', ['another-password-456']))
      .resolves.toBeTruthy();
  });

  it('refuses a password too short to be worth having', async () => {
    await expect(db.query('select create_bi_reader($1)', ['short']))
      .rejects.toThrow(/at least 12 characters/);
  });

  it('survives a password full of characters that break naive SQL', async () => {
    // Not concatenated, so none of this is special.
    for (const pw of ["it's a long one; drop table tasks; --",
                      'a"b\\c$$d%L-and-long-enough',
                      "'; select 1; -- padded to length"]) {
      await expect(db.query('select create_bi_reader($1)', [pw]), pw).resolves.toBeTruthy();
    }
    const [{ n }] = await db.query(`select count(*)::int as n from tasks`);
    expect(n).toBe(0);          // still there, and still a table
  });
});
