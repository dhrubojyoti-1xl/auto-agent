/**
 * The read-only login a charting tool connects with.
 *
 * The alternative is pasting the project's own database password into a
 * third-party tool, and that password can read and write everything —
 * including the table holding the encrypted Google refresh token. This role
 * can run SELECT against three reporting views and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(
  join(process.cwd(), 'src/app/api/admin/bi-access/route.ts'), 'utf8');

describe('the login it creates is genuinely limited', () => {
  it('grants select on exactly the three reporting views', () => {
    expect(SOURCE).toMatch(/VIEWS = \['bi_tasks', 'bi_daily_by_department', 'bi_messages'\]/);
    // Everything else in the schema is revoked, in case an earlier grant was wider.
    expect(SOURCE).toMatch(/revoke all on all tables in schema public/);
  });

  it('never grants insert, update, delete or ownership', () => {
    for (const forbidden of ['grant insert', 'grant update', 'grant delete',
                             'grant all', 'superuser', 'createdb', 'createrole']) {
      expect(SOURCE.toLowerCase(), forbidden).not.toContain(forbidden);
    }
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
    expect(SOURCE).toMatch(/format\('(create|alter) role %I with login password %L'/);
    expect(SOURCE).not.toMatch(/password\s*'\s*\$\{/);
    expect(SOURCE).not.toMatch(/\$\{password\}/);
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
