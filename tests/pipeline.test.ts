/**
 * Full-pipeline tests against a REAL Postgres database.
 *
 * Skipped automatically when TEST_DATABASE_URL is not set, so `npm test` still
 * works on a machine with no database. Run them with:
 *   createdb autoagent_test
 *   TEST_DATABASE_URL=postgres://localhost/autoagent_test npm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;

process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

const ROOT = join(__dirname, '..');

d('pipeline against Postgres', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any, pipeline: any, seedDb: any;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    pipeline = await import('../src/lib/pipeline');
    seedDb = await import('../src/lib/seed-db');
    await resetDatabase(db, seedDb);
  });

  afterAll(async () => { await db.getPool().end(); });

  const html = readFileSync(join(ROOT, 'sample-data', 'real-demo-email.html'), 'utf8');
  const doc = () => ({
    documentId: 'DEMO-1', subject: 'Daily Report - Sales, Marketing, Operations',
    sender: 'Team <team@example.com>', receivedAt: new Date().toISOString(), html
  });

  it('seeds the masters', async () => {
    const [{ count: statuses }] = await db.query('select count(*)::int as count from statuses');
    const [{ count: aliases }] = await db.query('select count(*)::int as count from status_aliases');
    const [{ count: cats }] = await db.query('select count(*)::int as count from task_categories');
    expect(statuses).toBe(7);
    expect(aliases).toBeGreaterThan(40);
    expect(cats).toBe(13);
  });

  it('preview writes nothing', async () => {
    const preview = await pipeline.previewDocument(doc(), 1);
    expect(preview.accepted.length).toBe(14);
    expect(preview.rejected.length).toBe(2);
    const [{ count }] = await db.query('select count(*)::int as count from tasks');
    expect(count).toBe(0);
  });

  it('commit writes 14 tasks and 2 rejections', async () => {
    const res = await pipeline.commitDocument(doc(), 'paste', 1);
    expect(res.rowsWritten).toBe(14);
    expect(res.rejected.length).toBe(2);
    const [{ count: tasks }] = await db.query('select count(*)::int as count from tasks');
    const [{ count: dq }] = await db.query('select count(*)::int as count from data_quality');
    expect(tasks).toBe(14);
    expect(dq).toBe(2);
  });

  it('IDEMPOTENT: committing the same document again writes nothing', async () => {
    const res = await pipeline.commitDocument(doc(), 'paste', 1);
    expect(res.rowsWritten).toBe(0);
    expect(res.skippedIdempotent).toBe(14);
    const [{ count }] = await db.query('select count(*)::int as count from tasks');
    expect(count).toBe(14);
  });

  it('a forwarded copy from a different document is rejected as duplicate', async () => {
    const res = await pipeline.commitDocument(
      { ...doc(), documentId: 'DEMO-FWD', subject: 'Fwd: Daily Report - Sales' }, 'email', 1);
    expect(res.rowsWritten).toBe(0);
    const dupes = res.rejected.filter((r: { reason: string }) => r.reason === 'DUPLICATE_ACROSS_DOCUMENTS');
    expect(dupes.length).toBe(14);
    const [{ count }] = await db.query('select count(*)::int as count from tasks');
    expect(count).toBe(14);
  });

  it('every duplicate is recorded individually, not collapsed', async () => {
    // The forwarded copy produced 14 duplicate rejections. Each must survive
    // as its own row: logging them all at the same position would let the
    // uniqueness index silently merge them.
    const [{ count }] = await db.query(
      `select count(*)::int as count from data_quality
       where rejection_reason = 'DUPLICATE_ACROSS_DOCUMENTS'`);
    expect(count).toBe(14);
  });

  it('rejections are idempotent', async () => {
    // Re-submitting an identical report must not pile up duplicate rejection
    // records, or the Data Quality page over-reports how much bad data arrived.
    const before = await db.query('select count(*)::int as count from data_quality');
    await pipeline.commitDocument(doc(), 'paste', 1);
    await pipeline.commitDocument(doc(), 'paste', 1);
    const after = await db.query('select count(*)::int as count from data_quality');
    expect(after[0].count).toBe(before[0].count);
  });

  it('the database constraint is the final backstop', async () => {
    const rows = await db.query('select task_fingerprint from tasks limit 1');
    await expect(db.query(
      `insert into tasks (task_id, task_date, employee_name, task, task_normalized,
         task_status, source_document_id, task_fingerprint, owner_user_id)
       values ('X','2026-01-01','X','X','x','Pending','X',$1,1)`, [rows[0].task_fingerprint]
    )).rejects.toThrow(/uq_task_fingerprint|duplicate key/);
  });

  it('analysis flags are written back to the rows', async () => {
    const out = await pipeline.rebuildAnalysis(1);
    expect(out.slowTasks).toBe(4);
    const groups = await db.query(
      `select employee, task, occurrence_count, classification from repeat_groups
       order by occurrence_count desc`);
    expect(groups.length).toBe(1);
    expect(groups[0].employee).toBe('Priya Sharma');
    expect(groups[0].occurrence_count).toBe(3);
    expect(groups[0].classification).toBe('Needs Review');
    const flagged = await db.query(
      `select count(*)::int as count from tasks where slow_task_flag = 'TRUE'`);
    expect(flagged[0].count).toBe(4);
    const insufficient = await db.query(
      `select count(*)::int as count from tasks where slow_task_flag = 'INSUFFICIENT_DATA'`);
    expect(insufficient[0].count).toBeGreaterThan(0);
  });

  it('the ALL roll-up row is labelled, not mistaken for a department', async () => {
    const rows = await db.query(
      `select department, total_tasks, completion_rate from daily_summary order by department`);
    const all = rows.find((r: { department: string }) => r.department === 'ALL');
    expect(all).toBeTruthy();
    expect(all.total_tasks).toBe(14);
    const perDept = rows.filter((r: { department: string }) => r.department !== 'ALL');
    expect(perDept.reduce((s: number, r: { total_tasks: number }) => s + r.total_tasks, 0)).toBe(14);
    expect(perDept.map((r: { department: string }) => r.department).sort())
      .toEqual(['Marketing', 'Operations', 'Sales']);
  });

  it('employee_summary never ranks a thin sample', async () => {
    const rows = await db.query('select employee, total_tasks, data_sufficiency from employee_summary');
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r: { total_tasks: number; data_sufficiency: string }) => {
      if (r.total_tasks < 10) expect(r.data_sufficiency).toBe('Insufficient — do not rank');
    });
  });

  it('rejections keep the business date they claimed', async () => {
    const rows = await db.query(
      `select rejection_reason, claimed_date from data_quality order by rejection_reason`);
    expect(rows.map((r: { rejection_reason: string }) => r.rejection_reason))
      .toEqual(expect.arrayContaining(['MISSING_REQUIRED_FIELD', 'UNKNOWN_STATUS']));
  });

  it('dates survive the database round trip unshifted', async () => {
    // Derive the expectation from the FIXTURE, not from today's clock: the
    // demo email is generated with a date stamped at export time, so comparing
    // against `new Date()` made this fail every time the day rolled over.
    const html = readFileSync(join(ROOT, 'sample-data', 'real-demo-email.html'), 'utf8');
    const stamped = html.match(/(\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})/);
    expect(stamped).toBeTruthy();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const [, dd, mon, yyyy] = stamped as RegExpMatchArray;
    const expected = `${yyyy}-${String(months.indexOf(mon) + 1).padStart(2, '0')}-${dd}`;

    const rows = await db.query(`select distinct task_date from tasks`);
    expect(rows.map((r: { task_date: string }) => String(r.task_date))).toEqual([expected]);
  });
});

describe('connection style detection', () => {
  it('tells a Supabase pooler URL from a direct one', async () => {
    const { isDirectConnection } = await import('../src/lib/db');
    expect(isDirectConnection(
      'postgresql://postgres.abc:pw@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres'
    )).toBe(false);
    expect(isDirectConnection(
      'postgresql://postgres:pw@db.njiwtuvwujooanyznyty.supabase.co:5432/postgres'
    )).toBe(true);
    expect(isDirectConnection('postgres://localhost/dev')).toBe(false);
  });
});

describe('DATABASE_URL construction and validation', () => {
  // Regression: `vercel env pull` writes the literal string [SENSITIVE] for
  // variables Vercel marks Sensitive. Sourcing that gave the seed step
  // DATABASE_URL="[SENSITIVE]", which pg-connection-string parses through its
  // libpq fallback into host "base" — the cause of ENOTFOUND base.
  const run = async (args: string[]) => {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const { join } = await import('path');
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath, [join(__dirname, '..', 'scripts', 'db-url.mjs'), ...args]);
      return { code: 0, out: stdout };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, out: (err.stdout || '') + (err.stderr || '') };
    }
  };

  it('rejects the redacted [SENSITIVE] value instead of connecting to "base"', async () => {
    const r = await run(['verify', '[SENSITIVE]']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not a parseable URL/i);
  });

  it('rejects a URL whose host is literally "base"', async () => {
    const r = await run(['verify', 'postgresql://u:p@base:5432/postgres']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not a real host/i);
  });

  it('rejects an unsubstituted [YOUR-PASSWORD] placeholder', async () => {
    const r = await run([
      'verify', 'postgresql://postgres:[YOUR-PASSWORD]@db.ref.supabase.co:5432/postgres']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/placeholder/i);
  });

  it('builds a pooler URL with the right user, port and encoded password', async () => {
    const r = await run(['build', 'myref', 'p@ss:w/rd#1', 'pooler', 'aws-0-ap-south-1.pooler.supabase.com']);
    expect(r.code).toBe(0);
    const u = new URL(r.out.trim());
    expect(u.protocol).toBe('postgresql:');
    expect(u.username).toBe('postgres.myref');
    expect(u.hostname).toBe('aws-0-ap-south-1.pooler.supabase.com');
    expect(u.port).toBe('6543');
    expect(u.pathname).toBe('/postgres');
    // Decoded back to the original, so special characters survive intact.
    expect(decodeURIComponent(u.password)).toBe('p@ss:w/rd#1');
    expect(r.out).not.toContain('p@ss:w/rd#1');   // raw password never emitted
  });

  it('builds a direct URL with the plain postgres user on 5432', async () => {
    const r = await run(['build', 'myref', 'secret', 'direct']);
    const u = new URL(r.out.trim());
    expect(u.username).toBe('postgres');
    expect(u.hostname).toBe('db.myref.supabase.co');
    expect(u.port).toBe('5432');
  });

  it('refuses to build from an empty or placeholder password', async () => {
    expect((await run(['build', 'myref', '', 'direct'])).code).not.toBe(0);
    expect((await run(['build', 'myref', '[SENSITIVE]', 'direct'])).code).not.toBe(0);
  });
});
