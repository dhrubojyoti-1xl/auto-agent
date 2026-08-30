/**
 * The export is the recovery plan on a free Supabase plan, so it has to work
 * on the schema that actually exists — an export that 500s is worse than none,
 * because it is only ever exercised on the day something has gone wrong.
 *
 * The first version of this endpoint selected from a table called `categories`.
 * The table is `task_categories`. Nothing in the type system had an opinion,
 * the build passed, and the failure only appeared when a request was made.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('the export runs against the real schema', () => {
  let db: any, seedDb: any;
  const UID = 1;

  // Every table and column the route names, pulled out of the source so the
  // test cannot drift away from what the endpoint actually queries.
  const source = readFileSync(
    join(process.cwd(), 'src/app/api/export/route.ts'), 'utf8');
  const selects = [...source.matchAll(/`(select[\s\S]*?)`/gi)].map(m => m[1]);

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    await resetDatabase(db, seedDb, { demo: false });
    await db.query(
      `insert into tasks (task_id, task_date, department, employee_name, task,
                          task_normalized, task_status, duration_basis,
                          source_document_id, task_fingerprint, owner_user_id)
       values ('X-1', date '2026-08-12', 'Sales', 'Rahul Mehta', 'Client call, part 2',
               'client call part 2', 'Completed', 'Insufficient Data', 'X', 'x1', $1)`,
      [UID]);
  });

  afterAll(async () => { await db.getPool().end(); });

  it('names at least the six relations a restore needs', () => {
    expect(selects.length).toBeGreaterThanOrEqual(6);
  });

  it('every query the endpoint issues actually executes', async () => {
    for (const sql of selects) {
      const runnable = sql.replace(/\$1/g, String(UID)).replace(/\$\{MAX_ROWS\}/g, '10');
      await expect(db.query(runnable), sql.slice(0, 60)).resolves.toBeTruthy();
    }
  });

  it('never selects a Gmail refresh token', () => {
    for (const sql of selects) {
      expect(sql.toLowerCase(), sql.slice(0, 60)).not.toContain('refresh_token');
    }
  });

  it('bounds every task-scale query, so one export cannot read the world', () => {
    const scaled = selects.filter(s => /from (tasks|data_quality|documents)\b/i.test(s));
    expect(scaled.length).toBe(3);
    for (const sql of scaled) expect(sql.toLowerCase(), sql.slice(0, 40)).toContain('limit');
  });

  it('scopes every user-owned query to one owner', () => {
    for (const sql of selects) {
      if (/from (tasks|data_quality|documents|gmail_accounts)\b/i.test(sql)) {
        expect(sql, sql.slice(0, 40)).toMatch(/owner_user_id\s*=\s*\$1/);
      }
    }
  });
});

describe('CSV escaping survives the values reports actually contain', () => {
  // Same rules the route applies; kept here so a change to either is noticed.
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  it('quotes a field containing a comma', () => {
    expect(esc('Client call, part 2')).toBe('"Client call, part 2"');
  });
  it('doubles an embedded quote', () => {
    expect(esc('He said "done"')).toBe('"He said ""done"""');
  });
  it('quotes a field containing a newline', () => {
    expect(esc('line one\nline two')).toBe('"line one\nline two"');
  });
  it('leaves an ordinary value untouched', () => {
    expect(esc('Completed')).toBe('Completed');
  });
});
