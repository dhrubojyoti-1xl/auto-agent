/**
 * A staff list is imported over a cross-region link.
 *
 * The application runs in Virginia and the database is in Tokyo, so a round
 * trip costs roughly 180ms. That makes the number of statements, not the amount
 * of data, the thing that decides whether an import finishes or is killed
 * halfway: one insert per person turns a 300-person list into nearly a minute
 * of waiting and a request that never returns.
 *
 * So these count statements rather than measure seconds — a clock would only
 * prove the local database is fast, which nobody doubted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';
import { rosterDepartmentId, rosterEmployeeId } from '../src/lib/roster';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('importing a whole company', () => {
  let db: any, seedDb: any, refile: any;
  const UID = 1;
  const DEPTS = ['Management', 'SOP', 'Content', 'Sales', 'Operations', 'HR'];

  const people = Array.from({ length: 300 }, (_, i) => {
    const name = `Person Number${i}`;
    return {
      id: rosterEmployeeId(name), name,
      department: DEPTS[i % DEPTS.length],
      email: `p${i}@1xl.com`, aliases: [`P${i}`], role: ''
    };
  });
  const departments = DEPTS.map(n => ({
    id: rosterDepartmentId(n), name: n, manager: '', managerEmail: ''
  }));

  /** Statements committed against this database, as the server counts them. */
  async function statements(): Promise<number> {
    const [r] = await db.query(
      `select xact_commit + xact_rollback as n from pg_stat_database
        where datname = current_database()`);
    return Number(r.n);
  }

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    refile = await import('../src/lib/refile');
    await resetDatabase(db, seedDb, { demo: false });
  });

  afterAll(async () => { await db.getPool().end(); });

  it('writes 300 people in a handful of statements, not 300', async () => {
    const before = await statements();
    await db.upsertRoster(people, departments);
    const after = await statements();

    // Two writes plus the two reads that bracket them. The ceiling is
    // deliberately loose — the point is that it does not scale with headcount.
    const used = after - before;
    expect(used).toBeLessThan(15);

    const { people: stored } = await db.loadRoster();
    expect(stored.length).toBeGreaterThanOrEqual(300);
  });

  it('keeps every alias and department across that many rows', async () => {
    const { people: stored } = await db.loadRoster();
    const p42 = stored.find((x: any) => x.name === 'Person Number42');
    expect(p42.department).toBe(DEPTS[42 % DEPTS.length]);
    expect(p42.aliases).toContain('P42');
    expect(p42.autoCreated).toBe(false);
  });

  it('re-files hundreds of task rows in a handful of statements too', async () => {
    // 600 rows of work, all unassigned, exactly the shape of the live data.
    const rows = Array.from({ length: 600 }, (_, i) => ({
      id: `T${i}`, name: `Person Number${i % 300}`, day: 1 + (i % 27)
    }));
    await db.query(
      `insert into tasks (task_id, owner_user_id, task_date, employee_name, task,
                          task_normalized, task_status, task_fingerprint,
                          source_document_id)
       select v.id, $2, v.day::date, v.name, 'Did something', 'did something',
              'Completed', 'fp-' || v.id, 'doc-scale'
         from jsonb_to_recordset($1::jsonb) as v(id text, name text, day text)`,
      [JSON.stringify(rows.map(r => ({
        id: r.id, name: r.name,
        day: `2026-08-${String(r.day).padStart(2, '0')}`
      }))), UID]);

    const before = await statements();
    const result = await refile.refileByRoster(UID);
    const after = await statements();

    expect(result.moved).toBe(600);
    // A transaction wrapping two updates, plus the reads it needs first.
    expect(after - before).toBeLessThan(15);

    const [{ unassigned }] = await db.query(
      `select count(*)::int as unassigned from tasks
        where owner_user_id = $1 and coalesce(department,'') = ''`, [UID]);
    expect(unassigned).toBe(0);
  });
});
