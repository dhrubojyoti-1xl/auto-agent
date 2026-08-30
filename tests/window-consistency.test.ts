/**
 * Every panel on the management page must describe the same window. The bug
 * this guards against was visible in the product: a header reading "219 tasks
 * across 30 days" sitting directly above a status donut totalling 303, because
 * the trend was capped at 30 periods while every other query ran over all
 * history.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

d('management panels share one window', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, q: any, seedDb: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    q = await import('../src/lib/queries');
    seedDb = await import('../src/lib/seed-db');
    await resetDatabase(db, seedDb, { demo: false });

    // 90 days of history: far more than the 30-period daily window, so an
    // unwindowed panel disagrees with a windowed one by a wide margin.
    await db.query(
      `insert into tasks (task_id, task_date, department, employee_name, task,
                          task_normalized, task_status, duration_basis,
                          source_document_id, task_fingerprint, owner_user_id)
       select 'W-' || g, (current_date - (g || ' days')::interval)::date,
              case when g % 2 = 0 then 'Sales' else 'HR' end,
              case when g % 2 = 0 then 'Rahul Mehta' else 'Kavita Menon' end,
              'Task ' || g, 'task ' || g,
              case when g % 3 = 0 then 'Pending' else 'Completed' end,
              'Insufficient Data', 'W-DOC', 'w-' || g, $1
       from generate_series(1, 90) g`, [UID]);
  });

  afterAll(async () => { await db.getPool().end(); });

  it('the daily window is narrower than the full history', async () => {
    const series = await q.getPeriodSeries(UID, 'daily', { limit: 30 });
    const windowed = series.reduce((a: number, p: any) => a + p.total, 0);
    const [{ all }] = await db.query(
      `select count(*)::int as all from tasks where owner_user_id = $1`, [UID]);
    expect(windowed).toBeLessThan(all);   // otherwise this test proves nothing
  });

  it('status, employee and department panels total the header figure', async () => {
    for (const grain of ['daily', 'weekly', 'monthly'] as const) {
      const limit = { daily: 30, weekly: 26, monthly: 24 }[grain];
      const series = await q.getPeriodSeries(UID, grain, { limit });
      const header = series.reduce((a: number, p: any) => a + p.total, 0);
      const scope = { from: series[0]?.period };

      const status = await q.getStatusDistribution(UID, scope);
      expect(status.reduce((a: number, s: any) => a + s.value, 0), `status ${grain}`)
        .toBe(header);

      const depts = await q.getDepartmentBreakdown(UID, scope);
      expect(depts.reduce((a: number, s: any) => a + s.total, 0), `depts ${grain}`)
        .toBe(header);

      const emps = await q.getEmployeeActivity(UID, { ...scope, limit: 50 });
      expect(emps.reduce((a: number, s: any) => a + s.total, 0), `employees ${grain}`)
        .toBe(header);
    }
  });

  it('a department filter narrows every panel, not just the trend', async () => {
    const series = await q.getPeriodSeries(UID, 'daily', { department: 'Sales', limit: 30 });
    const header = series.reduce((a: number, p: any) => a + p.total, 0);
    const scope = { department: 'Sales', from: series[0]?.period };

    const status = await q.getStatusDistribution(UID, scope);
    expect(status.reduce((a: number, s: any) => a + s.value, 0)).toBe(header);

    const emps = await q.getEmployeeActivity(UID, { ...scope, limit: 50 });
    expect(emps.every((e: any) => e.department === 'Sales')).toBe(true);
  });

  it('an employee filter narrows the department table too', async () => {
    const depts = await q.getDepartmentBreakdown(UID, { employee: 'Rahul Mehta' });
    expect(depts.map((d: any) => d.department)).toEqual(['Sales']);
  });
});
