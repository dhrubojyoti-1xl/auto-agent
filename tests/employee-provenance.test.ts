/**
 * An employee the importer invented is not configuration.
 *
 * Production showed exactly why this matters: ten people carried a department
 * of "Operations" because that is the report they first appeared in, including
 * two who belong to Sales and Marketing. The demo tasks had been purged; the
 * invented employees survived, because a reset treated them as master data.
 * A real report from one of those people, arriving without a department column,
 * would then have been filed under Operations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('invented employees are marked, shown and purged', () => {
  let db: any, seedDb: any, queries: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    queries = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });

    // One configured by a person...
    await db.query(
      `insert into employees (employee_id, employee_name, name_aliases, department, active)
       values ('EMP-001','Configured Person','{}','Sales',true)`);
    // ...and two the importer met in a report and had to invent.
    await db.upsertEmployees([
      { id: 'EMP-AB12CD', name: 'Invented One', aliases: [], department: 'Operations' },
      { id: 'EMP-EF34AB', name: 'Invented Two', aliases: [], department: 'Operations' }
    ]);
    await db.query(
      `insert into tasks (task_id, task_date, department, employee_name, task,
                          task_normalized, task_status, duration_basis,
                          source_document_id, task_fingerprint, owner_user_id)
       values ('P-1', date '2026-08-12', 'Operations', 'Invented One', 'A task',
               'a task', 'Completed', 'Insufficient Data', 'P', 'p1', $1)`, [UID]);
  });

  afterAll(async () => { await db.getPool().end(); });

  it('marks the ones the importer created and leaves the configured one alone', async () => {
    const rows = await db.query(
      `select employee_name, auto_created from employees order by employee_name`);
    const by = Object.fromEntries(rows.map((r: any) => [r.employee_name, r.auto_created]));
    expect(by['Configured Person']).toBe(false);
    expect(by['Invented One']).toBe(true);
    expect(by['Invented Two']).toBe(true);
  });

  it('shows them with the department that was guessed for them', async () => {
    const invented = await queries.getAutoCreatedEmployees(UID);
    expect(invented.map((e: any) => e.name).sort()).toEqual(['Invented One', 'Invented Two']);
    const one = invented.find((e: any) => e.name === 'Invented One');
    expect(one.department).toBe('Operations');
    expect(one.tasks).toBe(1);
    expect(one.firstSeen).toContain('2026-08-12');
  });

  it('a purge removes the invented ones and keeps the configured one', async () => {
    await db.query('delete from tasks where owner_user_id = $1', [UID]);
    const wiped = await db.query(
      `delete from employees where auto_created returning employee_id`);
    expect(wiped.length).toBe(2);
    const left = await db.query('select employee_name from employees');
    expect(left.map((r: any) => r.employee_name)).toEqual(['Configured Person']);
  });

  it('the migration marks ids that were generated before the column existed', async () => {
    await db.query(
      `insert into employees (employee_id, employee_name, name_aliases, department, active)
       values ('EMP-9F1A2B','Legacy Invented','{}','Operations',true)`);
    await db.query(
      `update employees set auto_created = true
        where auto_created = false and employee_id ~ '^EMP-[0-9A-F]{6}$'`);
    const [row] = await db.query(
      `select auto_created from employees where employee_id = 'EMP-9F1A2B'`);
    expect(row.auto_created).toBe(true);

    const [cfg] = await db.query(
      `select auto_created from employees where employee_id = 'EMP-001'`);
    expect(cfg.auto_created).toBe(false);      // a seeded id is never swept up
  });
});
