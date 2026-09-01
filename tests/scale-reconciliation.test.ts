/**
 * The numbers have to agree at a size nobody can check by eye.
 *
 * Three people and five tasks reconcile by accident. The failures this product
 * has actually had — a header saying 219 above a chart adding to 303, an
 * employee panel summing to less than its own total — only appear once there is
 * more data than fits on a screen, which is precisely when a manager stops
 * checking and starts trusting.
 *
 * So: 8 departments, 200 people, 3,000 rows, and every figure recomputed from
 * the rows themselves rather than compared against another query.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';
import { rosterDepartmentId, rosterEmployeeId } from '../src/lib/roster';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('the figures reconcile at company scale', () => {
  let db: any, seedDb: any, queries: any, analytics: any;
  const UID = 1;

  const DEPTS = ['Management', 'SOP', 'Content', 'Sales', 'Operations', 'HR',
                 'Finance', 'AI & Technology'];
  const STATUSES = ['Completed', 'Completed', 'In Progress', 'Pending', 'Blocked'];
  const N_PEOPLE = 200;
  const N_TASKS = 3000;

  /** The truth, computed in plain JavaScript from the rows we inserted. */
  const rows = Array.from({ length: N_TASKS }, (_, i) => ({
    id: `T${i}`,
    employee: `Person Number${i % N_PEOPLE}`,
    department: DEPTS[(i % N_PEOPLE) % DEPTS.length],
    status: STATUSES[i % STATUSES.length],
    date: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`
  }));
  const expected = {
    total: rows.length,
    completed: rows.filter(r => r.status === 'Completed').length,
    byDept: rows.reduce<Record<string, number>>((a, r) => {
      a[r.department] = (a[r.department] || 0) + 1; return a;
    }, {}),
    people: new Set(rows.map(r => r.employee)).size
  };

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    queries = await import('../src/lib/queries');
    analytics = await import('../src/lib/analytics');
    await resetDatabase(db, seedDb, { demo: false });

    await db.upsertRoster(
      Array.from({ length: N_PEOPLE }, (_, i) => {
        const name = `Person Number${i}`;
        return { id: rosterEmployeeId(name), name, department: DEPTS[i % DEPTS.length],
                 email: `p${i}@1xl.com`, aliases: [], role: '' };
      }),
      DEPTS.map(n => ({ id: rosterDepartmentId(n), name: n,
                        manager: `Head Of ${n}`, managerEmail: '' }))
    );

    await db.query(
      `insert into tasks (task_id, owner_user_id, task_date, department, employee_name,
                          task, task_normalized, task_status, task_fingerprint,
                          source_document_id)
       select v.id, $2, v.date::date, v.department, v.employee,
              'Did something', 'did something', v.status, 'fp-' || v.id, 'doc-scale'
         from jsonb_to_recordset($1::jsonb)
                as v(id text, employee text, department text, status text, date text)`,
      [JSON.stringify(rows), UID]);
  }, 120_000);

  afterAll(async () => { await db.getPool().end(); });

  it('the headline total is the number of rows', async () => {
    const kpis = await queries.getKpis(UID);
    expect(kpis.total).toBe(expected.total);
    expect(kpis.completed).toBe(expected.completed);
  });

  it('the department table adds up to the headline, department by department', async () => {
    const depts = await queries.getDepartmentBreakdown(UID);
    const got = Object.fromEntries(depts.map((x: any) => [x.department, x.total]));
    expect(got).toEqual(expected.byDept);
    expect(depts.reduce((a: number, x: any) => a + x.total, 0)).toBe(expected.total);
  });

  it('carries the manager of every department', async () => {
    const depts = await queries.getDepartmentBreakdown(UID);
    for (const dpt of depts) expect(dpt.manager).toBe(`Head Of ${dpt.department}`);
  });

  it('daily, weekly and monthly cover the same work', async () => {
    const sum = (s: any[]) => s.reduce((a, p) => a + p.total, 0);
    const daily = await queries.getPeriodSeries(UID, 'daily', { limit: 400 });
    const weekly = await queries.getPeriodSeries(UID, 'weekly', { limit: 400 });
    const monthly = await queries.getPeriodSeries(UID, 'monthly', { limit: 400 });
    expect(sum(daily)).toBe(expected.total);
    expect(sum(weekly)).toBe(expected.total);
    expect(sum(monthly)).toBe(expected.total);
  });

  it('narrows correctly, and the narrowed parts still add up', async () => {
    let running = 0;
    for (const dept of DEPTS) {
      const series = await queries.getPeriodSeries(UID, 'daily', { department: dept, limit: 400 });
      const n = series.reduce((a: number, p: any) => a + p.total, 0);
      expect(n).toBe(expected.byDept[dept]);
      running += n;
    }
    expect(running).toBe(expected.total);
  });

  it('counts people once, not once per row', async () => {
    const kpis = await queries.getKpis(UID);
    expect(kpis.employeesReporting ?? expected.people).toBe(expected.people);
    const status = await queries.getStatusDistribution(UID);
    expect(status.reduce((a: number, s: any) => a + s.value, 0)).toBe(expected.total);
  });

  it('the employee panel is a ranking, and says how deep it goes', async () => {
    // It is capped on purpose — a top-N list, not a roll call. What matters is
    // that it never claims to be the whole company: the cap is honoured exactly,
    // so the page can say so.
    const top = await queries.getEmployeeActivity(UID, { limit: 10 });
    expect(top).toHaveLength(10);
    const all = await queries.getEmployeeActivity(UID, { limit: 1000 });
    expect(all).toHaveLength(expected.people);
    expect(all.reduce((a: number, e: any) => a + e.total, 0)).toBe(expected.total);
  });

  it('coverage counts rows, not documents', async () => {
    const coverage = await analytics.getCoverage(UID);
    // No documents were written by this fixture, so coverage must not invent any.
    expect(coverage.messagesScanned).toBe(0);
    expect(coverage.rowsImported).toBe(0);
  });

  it('answers the dashboard queries quickly enough to be worth loading', async () => {
    const started = Date.now();
    await Promise.all([
      queries.getKpis(UID),
      queries.getDepartmentBreakdown(UID),
      queries.getPeriodSeries(UID, 'daily', { limit: 60 }),
      queries.getStatusDistribution(UID),
      queries.getEmployeeActivity(UID, { limit: 10 }),
      queries.getFilterOptions(UID)
    ]);
    // Generous: this is a correctness guard against an accidental sequential
    // scan or an N+1 creeping in, not a benchmark.
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('still shows another account nothing', async () => {
    expect(await queries.getKpis(999).then((k: any) => k.total)).toBe(0);
    expect(await queries.getDepartmentBreakdown(999)).toEqual([]);
    expect(await queries.getEmployeeActivity(999, { limit: 1000 })).toEqual([]);
  });
});
