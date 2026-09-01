/**
 * The two detail pages a manager reaches for when something looks wrong.
 *
 * Filtering by department on the dashboard used to narrow everything, and then
 * clicking through to repeated or slow work showed the whole organisation again
 * with nothing on screen admitting the filter had been dropped. These tests pin
 * the filters at the query, not the markup: a page that fetches every row and
 * hides some in the browser still sends them all to whoever asked, and would
 * count its own summary from a list the reader cannot see.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('repeated and slow work filter in SQL', () => {
  let db: any, seedDb: any, queries: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    queries = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });

    await db.query(
      `insert into repeat_groups
         (repeat_key, owner_user_id, employee, department, task, normalized_task,
          occurrence_count, distinct_dates, max_same_day_count, first_date, last_date,
          classification, classification_reason)
       values
         ('k1',$1,'Usman Khan','Management','Approve invoices','approve invoices',5,5,1,'2026-08-01','2026-08-10','Recurring / Legitimate','x'),
         ('k2',$1,'Rahul Koli','SOP','Update the checklist','update the checklist',4,4,1,'2026-08-05','2026-08-20','Recurring / Legitimate','x'),
         ('k3',$1,'Arjun Sen','Content','Draft the newsletter','draft the newsletter',3,3,1,'2026-08-25','2026-08-28','Recurring / Legitimate','x')`,
      [UID]);

    // slow_tasks is a view over tasks, so the rows go in where they really
    // live — which also means these exercise the same path the importer writes.
    await db.query(
      `insert into tasks
         (task_id, owner_user_id, task_date, department, employee_name, task,
          task_normalized, task_category, task_status, task_fingerprint, source_document_id,
          expected_duration, actual_duration, slow_task_flag, slow_variance_hours,
          duration_basis, slow_baseline_source, slow_baseline_sample, slow_reason)
       values
         ('T1',$1,'2026-08-02','Management','Usman Khan','Approve invoices','approve invoices','admin','Completed','fp1','doc-1',2,9,'TRUE',7,'timestamps','configured',0,'r'),
         ('T2',$1,'2026-08-12','SOP','Rahul Koli','Update the checklist','update the checklist','admin','Completed','fp2','doc-1',2,8,'TRUE',6,'timestamps','configured',0,'r'),
         ('T3',$1,'2026-08-26','Content','Arjun Sen','Draft the newsletter','draft the newsletter','admin','Completed','fp3','doc-1',2,7,'TRUE',5,'timestamps','configured',0,'r')`,
      [UID]);
  });

  afterAll(async () => { await db.getPool().end(); });

  describe('repeated work', () => {
    it('returns everything when nothing is chosen', async () => {
      expect(await queries.getRepeatGroups(UID)).toHaveLength(3);
    });
    it('narrows to one department', async () => {
      const r = await queries.getRepeatGroups(UID, { department: 'SOP' });
      expect(r.map((x: any) => x.department)).toEqual(['SOP']);
    });
    it('narrows to one employee', async () => {
      const r = await queries.getRepeatGroups(UID, { employee: 'Usman Khan' });
      expect(r).toHaveLength(1);
    });
    it('keeps a group whose span overlaps the window, not only one inside it', async () => {
      // Rahul's group runs 05–20 August. A window of 18–22 contains none of its
      // endpoints but does overlap it, and dropping it would tell a manager the
      // repetition stopped.
      const r = await queries.getRepeatGroups(UID, { from: '2026-08-18', to: '2026-08-22' });
      expect(r.map((x: any) => x.employee)).toEqual(['Rahul Koli']);
    });
    it('searches the task text', async () => {
      const r = await queries.getRepeatGroups(UID, { search: 'checklist' });
      expect(r).toHaveLength(1);
      expect(r[0].task).toBe('Update the checklist');
    });
    it('combines filters', async () => {
      expect(await queries.getRepeatGroups(UID, { department: 'SOP', search: 'newsletter' }))
        .toHaveLength(0);
    });
  });

  describe('slow work', () => {
    it('returns everything when nothing is chosen', async () => {
      expect(await queries.getSlowTasks(UID)).toHaveLength(3);
    });
    it('narrows to one department', async () => {
      const r = await queries.getSlowTasks(UID, { department: 'Content' });
      expect(r.map((x: any) => x.employee)).toEqual(['Arjun Sen']);
    });
    it('narrows to a date range', async () => {
      const r = await queries.getSlowTasks(UID, { from: '2026-08-10', to: '2026-08-20' });
      expect(r.map((x: any) => x.task)).toEqual(['Update the checklist']);
    });
    it('searches the task text, case-insensitively', async () => {
      const r = await queries.getSlowTasks(UID, { search: 'INVOICES' });
      expect(r).toHaveLength(1);
    });
    it('combines filters and can legitimately return nothing', async () => {
      expect(await queries.getSlowTasks(UID, { department: 'SOP', employee: 'Usman Khan' }))
        .toHaveLength(0);
    });
    it('is still scoped to its owner', async () => {
      expect(await queries.getSlowTasks(999)).toHaveLength(0);
      expect(await queries.getRepeatGroups(999)).toHaveLength(0);
    });
  });
});
