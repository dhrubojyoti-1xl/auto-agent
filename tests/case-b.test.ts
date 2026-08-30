/**
 * CASE B, as an arithmetic contract.
 *
 * Eight rows, one of them planned. The planned row must leave the numerator
 * AND the denominator: five completed of seven counted is 71.4%, not 62.5%.
 * Getting 62.5% means the planned row was counted as work that failed to
 * complete, which is a claim about a person that the data does not support.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

const ROWS: [string, string, string, string, string][] = [
  ['Dhrubo Ganguly', 'AI & Technology', 'AI Integration in SaaS', 'Completed', 'COMPLETED_WORK'],
  ['Rahul Mehta', 'Sales', 'Client Follow-up', 'Completed', 'COMPLETED_WORK'],
  ['Priya Sharma', 'HR', 'Employee Onboarding', 'In Progress', 'CURRENT_WORK'],
  ['Arjun Sen', 'Operations', 'Vendor Reconciliation', 'Pending', 'CURRENT_WORK'],
  ['Mita Roy', 'Marketing', 'Campaign Performance Review', 'Completed', 'COMPLETED_WORK'],
  ['Dhrubo Ganguly', 'AI & Technology', 'Dashboard Visual Improvements', 'Completed', 'COMPLETED_WORK'],
  ['Rahul Mehta', 'Sales', 'New Lead Research', 'Completed', 'COMPLETED_WORK'],
  ['Priya Sharma', 'HR', 'Policy Update', 'Not Started', 'PLANNED']
];

/* eslint-disable @typescript-eslint/no-explicit-any */
d('Case B reconciles', () => {
  let db: any, seedDb: any, q: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    q = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });
    for (let i = 0; i < ROWS.length; i++) {
      const [emp, dept, task, status, kind] = ROWS[i];
      await db.query(
        `insert into tasks (task_id, task_date, department, employee_name, task,
                            task_normalized, task_status, duration_basis,
                            source_document_id, task_fingerprint, owner_user_id, work_kind)
         values ($1, date '2026-08-30', $2, $3, $4, lower($4), $5,
                 'Insufficient Data', 'CASE-B', $6, $7, $8)`,
        ['B' + i, dept, emp, task, status, 'b' + i, UID, kind]);
    }
  });

  afterAll(async () => { await db.getPool().end(); });

  it('stores all eight rows, including the planned one', async () => {
    const [{ n }] = await db.query(
      `select count(*)::int as n from tasks where owner_user_id = $1`, [UID]);
    expect(n).toBe(8);
    const [{ p }] = await db.query(
      `select count(*)::int as p from tasks where owner_user_id = $1
         and work_kind = 'PLANNED'`, [UID]);
    expect(p).toBe(1);
  });

  it('counts seven, not eight — the plan is not work', async () => {
    const kpis = await q.getKpis(UID);
    expect(kpis.total).toBe(7);
    expect(kpis.completed).toBe(5);
  });

  it('reports 71.4%, not 62.5%', async () => {
    const kpis = await q.getKpis(UID);
    expect(kpis.completionRate).toBe(71.4);
  });

  it('separates all five departments', async () => {
    const rows = await db.query(
      `select department, count(*)::int as n from tasks where owner_user_id = $1
         and work_kind <> 'PLANNED' group by 1 order by 1`, [UID]);
    // HR keeps a counted row — Priya's In Progress one — while her Planned
    // row is excluded, so all five departments still report.
    expect(rows.map((r: any) => r.department))
      .toEqual(['AI & Technology', 'HR', 'Marketing', 'Operations', 'Sales']);
    const all = await db.query(
      `select distinct department from tasks where owner_user_id = $1 order by 1`, [UID]);
    expect(all.map((r: any) => r.department))
      .toEqual(['AI & Technology', 'HR', 'Marketing', 'Operations', 'Sales']);
  });

  it('every panel agrees with the headline', async () => {
    const kpis = await q.getKpis(UID);
    const status = await q.getStatusDistribution(UID, {});
    const depts = await q.getDepartmentBreakdown(UID, {});
    const emps = await q.getEmployeeActivity(UID, { limit: 50 });
    for (const [name, total] of [
      ['status', status.reduce((a: number, s: any) => a + s.value, 0)],
      ['departments', depts.reduce((a: number, s: any) => a + s.total, 0)],
      ['employees', emps.reduce((a: number, s: any) => a + s.total, 0)]
    ] as const) {
      expect(total, String(name)).toBe(kpis.total);
    }
  });

  it('five people reported, counting the one whose only counted row is open', async () => {
    const kpis = await q.getKpis(UID);
    expect(kpis.employeesReporting).toBe(5);
  });
});

describe('one report, five departments', () => {
  it('does not label the report with whichever team had most rows', async () => {
    const { ingestDocument } = await import('../src/lib/core/ingest');
    const { extractPipeTables } = await import('../src/lib/core/html-table');
    const { seedMasters } = await import('../src/lib/seed');
    const { engineConfig } = await import('../src/lib/pipeline');

    // Case B's shape: five departments, two rows for one of them.
    const tables = extractPipeTables(
      'Date|Staff Member|Team / Division|Work Item|Current Status\n' +
      '30 Aug 2026|Ann Fielding|AI & Technology|AI integration|Completed\n' +
      '30 Aug 2026|Ann Fielding|AI & Technology|Dashboard work|Completed\n' +
      '30 Aug 2026|Ben Okoro|Sales|Client follow-up|Completed\n' +
      '30 Aug 2026|Cara Duval|HR|Employee onboarding|In Progress\n' +
      '30 Aug 2026|Dee Marsh|Operations|Vendor reconciliation|Pending\n' +
      '30 Aug 2026|Eve Lantry|Marketing|Campaign review|Completed\n');

    const res = ingestDocument({
      documentId: 'five-depts', subject: 'daily', sender: 'lead@co.com',
      receivedAt: '2026-08-30T09:00:00.000Z', tables
    }, seedMasters([]), engineConfig(), new Map());

    expect(res.accepted).toHaveLength(6);
    // The report has no single department, and says so rather than picking one.
    expect(res.department).toBe('');
    expect(res.departments?.sort()).toEqual(
      ['AI & Technology', 'HR', 'Marketing', 'Operations', 'Sales']);
    // Every row still carries its own.
    expect(new Set(res.accepted.map(a => a.department)).size).toBe(5);
  });

  it('names the department when every row agrees', async () => {
    const { ingestDocument } = await import('../src/lib/core/ingest');
    const { extractPipeTables } = await import('../src/lib/core/html-table');
    const { seedMasters } = await import('../src/lib/seed');
    const { engineConfig } = await import('../src/lib/pipeline');

    const tables = extractPipeTables(
      'Date|Employee|Dept|Task|Status\n' +
      '30 Aug 2026|Ann Fielding|Sales|Call a client|Completed\n' +
      '30 Aug 2026|Ben Okoro|Sales|Send the quote|Completed\n');
    const res = ingestDocument({
      documentId: 'one-dept', subject: 'daily', sender: 'lead@co.com',
      receivedAt: '2026-08-30T09:00:00.000Z', tables
    }, seedMasters([]), engineConfig(), new Map());

    expect(res.department).toBe('Sales');
    expect(res.departments).toEqual(['Sales']);
  });
});
