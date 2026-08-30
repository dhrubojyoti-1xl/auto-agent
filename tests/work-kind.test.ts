/**
 * Yesterday's work, today's work, and tomorrow's plan are three different
 * things under three headings in the same report.
 *
 * Counting them as one stream inflates the figure management actually looks
 * at — today's completions — with work done yesterday and work nobody has
 * started. A plan counted as a completion is a false claim about people.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workKindFromHeader } from '../src/lib/core/semantic-headers';
import { extractTables } from '../src/lib/core/html-table';
import { ingestDocument } from '../src/lib/core/ingest';
import { seedMasters } from '../src/lib/seed';
import { engineConfig } from '../src/lib/pipeline';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

describe('reading the stream out of a heading', () => {
  const cases: [string, string][] = [
    ["Tomorrow's Plan", 'PLANNED'],
    ['Planned Work', 'PLANNED'],
    ['Next Day Activities', 'PLANNED'],
    ['Upcoming Tasks', 'PLANNED'],
    ["Yesterday's Work", 'PREVIOUS_DAY'],
    ['Previous Day Work', 'PREVIOUS_DAY'],
    ['Carried Forward Tasks', 'PREVIOUS_DAY'],
    ["Today's Work", 'COMPLETED_TODAY'],
    ['Work Completed', 'COMPLETED_TODAY'],
    ['Task', 'REPORTED'],
    ['Work Done', 'COMPLETED_TODAY'],
    ['Activity', 'REPORTED']
  ];
  for (const [header, kind] of cases) {
    it(`"${header}" is ${kind}`, () => expect(workKindFromHeader(header)).toBe(kind));
  }

  it('a plan is never mistaken for a completion, even when both words appear', () => {
    // "Completed / Planned" contains a completion word; it is still a plan
    // column, and reading it the other way overstates what the team did.
    expect(workKindFromHeader('Completed or Planned')).toBe('PLANNED');
    expect(workKindFromHeader('Task planned for tomorrow (completed?)')).toBe('PLANNED');
  });
});

describe('a report with a plan column', () => {
  const html = `<table>
    <tr><th>Date</th><th>Employee</th><th>Tomorrow's Plan</th><th>Status</th></tr>
    <tr><td>12 Aug 2026</td><td>Priya Sharma</td><td>Visit the client</td><td>Not Started</td></tr>
  </table>`;
  const res = ingestDocument({
    documentId: 'plan', subject: 's', sender: 'p@co.com',
    receivedAt: '2026-08-12T09:00:00.000Z', tables: extractTables(html)
  }, seedMasters([]), engineConfig(), new Map());

  it('is imported, not discarded', () => {
    expect(res.accepted).toHaveLength(1);
  });

  it('is marked as a plan', () => {
    expect(res.accepted[0].workKind).toBe('PLANNED');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
d('what the dashboard counts', () => {
  let db: any, seedDb: any, q: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    q = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });

    const rows: [string, string, string][] = [
      ['w-1', 'Completed', 'COMPLETED_TODAY'],
      ['w-2', 'Completed', 'REPORTED'],
      ['w-3', 'Pending', 'PREVIOUS_DAY'],
      // A plan somebody optimistically marked Completed. It has not happened.
      ['w-4', 'Completed', 'PLANNED'],
      ['w-5', 'Not Started', 'PLANNED']
    ];
    for (const [id, status, kind] of rows) {
      await db.query(
        `insert into tasks (task_id, task_date, department, employee_name, task,
                            task_normalized, task_status, duration_basis,
                            source_document_id, task_fingerprint, owner_user_id, work_kind)
         values ($1, date '2026-08-12', 'Sales', 'Priya Sharma', $2, $3, $4,
                 'Insufficient Data', 'D', $5, $6, $7)`,
        [id, 'Task ' + id, 'task ' + id, status, 'fp-' + id, UID, kind]);
    }
  });

  afterAll(async () => { await db.getPool().end(); });

  it('counts work that happened and ignores work that has not', async () => {
    const kpis = await q.getKpis(UID);
    expect(kpis.total).toBe(3);          // not 5
    expect(kpis.completed).toBe(2);      // the "Completed" plan is not one of them
  });

  it('keeps the completion rate honest', async () => {
    const kpis = await q.getKpis(UID);
    // 2 of 3, not 3 of 5 — a plan cannot raise or lower a completion rate.
    expect(kpis.completionRate).toBe(66.7);
  });

  it('excludes plans from every panel, not just the headline', async () => {
    const series = await q.getPeriodSeries(UID, 'daily', { limit: 30 });
    expect(series.reduce((a: number, p: any) => a + p.total, 0)).toBe(3);

    const status = await q.getStatusDistribution(UID, {});
    expect(status.reduce((a: number, s: any) => a + s.value, 0)).toBe(3);

    const depts = await q.getDepartmentBreakdown(UID, {});
    expect(depts.reduce((a: number, x: any) => a + x.total, 0)).toBe(3);

    const emps = await q.getEmployeeActivity(UID, { limit: 50 });
    expect(emps.reduce((a: number, x: any) => a + x.total, 0)).toBe(3);
  });

  it('still stores the plans, so nothing was thrown away', async () => {
    const [{ n }] = await db.query(
      `select count(*)::int as n from tasks where owner_user_id = $1
         and work_kind = 'PLANNED'`, [UID]);
    expect(n).toBe(2);
  });
});
