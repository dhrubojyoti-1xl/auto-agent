/**
 * A completion rate that is low only because nobody could read the status.
 *
 * Harshal's report: tasks arrive, but the completion rate does not. The cause
 * is not a calculation — it is that a team writes "Done ✔" or "Complete-ish",
 * the importer refuses to guess and records the row as Pending, and then says
 * so only in a note on the row itself. The dashboard shows a low percentage
 * with no reason attached, which is indistinguishable from a team that is
 * genuinely behind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('unreadable statuses explain the completion rate', () => {
  let db: any, seedDb: any, analytics: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    analytics = await import('../src/lib/analytics');
    await resetDatabase(db, seedDb, { demo: false });

    await db.query(
      `insert into tasks (task_id, owner_user_id, task_date, department, employee_name,
                          task, task_normalized, task_status, task_fingerprint,
                          source_document_id, data_quality_status, data_quality_notes)
       values
        ('U1',$1,'2026-08-20','SOP','A Person','Did a thing','did a thing','Pending','f1','d1',
         'Review','Unrecognised status "Done ✔" defaulted to Pending'),
        ('U2',$1,'2026-08-20','SOP','A Person','Did another','did another','Pending','f2','d1',
         'Review','Unrecognised status "Complete-ish" defaulted to Pending'),
        ('U3',$1,'2026-08-20','SOP','A Person','Third thing','third thing','Completed','f3','d1',
         'OK',null)`,
      [UID]);
  });

  afterAll(async () => { await db.getPool().end(); });

  it('raises it, rather than leaving a low percentage unexplained', async () => {
    const items = await analytics.getAttention(UID);
    const item = items.find((i: any) => /could not be read/i.test(i.title));
    expect(item).toBeTruthy();
    expect(item.count).toBe(2);
    expect(item.severity).toBe('high');
  });

  it('names the actual words, so the fix is a conversation not an investigation', async () => {
    const items = await analytics.getAttention(UID);
    const item = items.find((i: any) => /could not be read/i.test(i.title));
    expect(item.detail).toContain('Done ✔');
    expect(item.detail).toContain('Complete-ish');
  });

  it('says which words the team should use instead', async () => {
    const items = await analytics.getAttention(UID);
    const item = items.find((i: any) => /could not be read/i.test(i.title));
    for (const word of ['Completed', 'In Progress', 'Pending', 'Blocked']) {
      expect(item.detail).toContain(word);
    }
  });

  it('stays quiet when every status was understood', async () => {
    await db.query(
      `update tasks set data_quality_notes = null where owner_user_id = $1`, [UID]);
    const items = await analytics.getAttention(UID);
    expect(items.find((i: any) => /could not be read/i.test(i.title))).toBeUndefined();
  });
});
