/**
 * The Overview page told a manager four untrue things at once.
 *
 * It said "Reports processed 0" above forty-seven imported tasks; it listed
 * eight newsletters under "Recent imports" while the actual import was not
 * shown; it printed a last sync of "2026" under a date of "Sun Aug 30"; and
 * it captioned a fourteen-day chart in a way that contradicted the total
 * above it. None of these were parsing failures — the data was right and the
 * page was wrong about it, which is worse, because it is not visible as a bug.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatDay, formatStamp, formatTime } from '../src/lib/format-date';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

describe('timestamps survive whatever the driver returns', () => {
  const iso = '2026-08-30T07:09:00.000Z';
  const asDate = new Date(iso);

  it('formats a Date object, which is what the driver actually returns', () => {
    // String(asDate) is "Sat Aug 30 2026 07:09:00 GMT…", and slicing that by
    // ISO offsets is what produced "2026" as a time.
    expect(formatStamp(asDate)).toBe('2026-08-30 07:09');
    expect(formatDay(asDate)).toBe('2026-08-30');
    expect(formatTime(asDate)).toBe('07:09');
  });

  it('formats an ISO string identically', () => {
    expect(formatStamp(iso)).toBe('2026-08-30 07:09');
    expect(formatStamp(asDate)).toBe(formatStamp(iso));
  });

  it('never prints a year where a time belongs', () => {
    for (const v of [asDate, iso, String(asDate)]) {
      expect(formatTime(v), String(v)).toMatch(/^\d{2}:\d{2}$/);
      expect(formatDay(v), String(v)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('says so plainly when there is nothing to show', () => {
    expect(formatStamp(null)).toBe('—');
    expect(formatStamp(undefined, 'never')).toBe('never');
    expect(formatStamp('not a date')).toBe('—');
    expect(formatStamp('')).toBe('—');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
d('what the Overview counts', () => {
  let db: any, seedDb: any, q: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    q = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });

    // One real report, then twelve newsletters that arrived afterwards —
    // exactly the shape that made the page report zero.
    await db.query(
      `insert into documents (report_id, document_id, source, subject, sender,
         received_at, processing_status, tables_found, rows_extracted, rows_inserted,
         rows_skipped_idempotent, rows_rejected, owner_user_id, processed_at)
       values ('R-1','d-1','email','Daily report','r@co.com', now() - interval '2 hours',
               'SUCCESS', 1, 47, 47, 0, 1, $1, now() - interval '2 hours')`, [UID]);
    for (let i = 0; i < 12; i++) {
      await db.query(
        `insert into documents (report_id, document_id, source, subject, sender,
           received_at, processing_status, tables_found, rows_extracted, rows_inserted,
           rows_skipped_idempotent, rows_rejected, owner_user_id, processed_at)
         values ($1,$2,'email',$3,'news@x.com', now(), 'NO_DATA',0,0,0,0,0,$4, now())`,
        [`N-${i}`, `d-n-${i}`, `New SaaS listing ${i}`, UID]);
    }
  });

  it('counts reports over every message, not over the rows it displays', async () => {
    const totals = await q.getProcessingTotals(UID);
    expect(totals.reports).toBe(1);      // not 0
    expect(totals.scanned).toBe(13);
    expect(totals.imported).toBe(47);
  });

  it('shows the import under "Recent imports", not the newsletters', async () => {
    const imports = await q.getRecentImports(UID, 8);
    expect(imports).toHaveLength(1);
    expect(imports[0].subject).toBe('Daily report');
    expect(imports.every((d: any) => d.status !== 'NO_DATA')).toBe(true);
  });

  it('does not let a busy inbox hide the one report of the day', async () => {
    // Twelve newer messages sit above it by time; it must still be listed.
    const imports = await q.getRecentImports(UID, 8);
    expect(imports.map((d: any) => d.subject)).toContain('Daily report');
  });
});

d('repeated work is described as work, not as a fault', () => {
  let db: any, seedDb: any, q: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    q = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });

    // Five instances of one recurring project, as the real report had.
    for (let i = 0; i < 5; i++) {
      await db.query(
        `insert into tasks (task_id, task_date, department, employee_name, task,
                            task_normalized, task_status, duration_basis,
                            source_document_id, task_fingerprint, owner_user_id,
                            repeated_task_flag, repeat_classification)
         values ($1, (date '2026-08-10' + ($2 || ' days')::interval)::date,
                 'Unassigned', 'Dhrubo Ganguly',
                 'AI integration in SAAS', 'ai integration in saas', 'Completed',
                 'Insufficient Data', 'D', $3, $4, true, 'Recurring / Legitimate')`,
        ['T' + i, i, 'fp' + i, UID]);
    }
    await db.query(
      `insert into repeat_groups (repeat_key, employee, department, task,
         normalized_task, occurrence_count, distinct_dates, max_same_day_count,
         first_date, last_date, classification, classification_reason, owner_user_id)
       values ('k1','Dhrubo Ganguly','Unassigned','AI integration in SAAS',
               'ai integration in saas',5,5,1,
               date '2026-08-10', date '2026-08-14','Recurring / Legitimate','routine',$1)`,
      [UID]);
  });

  afterAll(async () => { await db.getPool().end(); });

  it('reports the instances and the number of distinct recurring items', async () => {
    const kpis = await q.getKpis(UID);
    expect(kpis.repeatedTasks).toBe(5);   // instances
    expect(kpis.repeatGroups).toBe(1);    // one piece of recurring work
  });

  it('counts none as worth attention when all are legitimate', async () => {
    const kpis = await q.getKpis(UID);
    expect(kpis.repeatAttention).toBe(0);
  });
});

d('the Inbox shows the report, not the marketing', () => {
  let db: any, seedDb: any, q: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    q = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });

    // The report arrives first; nine newsletters arrive after it.
    await db.query(
      `insert into documents (report_id, document_id, source, subject, sender, received_at,
         processing_status, tables_found, rows_extracted, rows_inserted,
         rows_skipped_idempotent, rows_rejected, owner_user_id, classification, processed_at)
       values ('R1','d1','email','Daily report','r@co.com', now() - interval '3 hours',
               'SUCCESS',1,47,47,0,0,$1,'DEPARTMENTAL_REPORT', now() - interval '3 hours')`,
      [UID]);
    await db.query(
      `insert into documents (report_id, document_id, source, subject, sender, received_at,
         processing_status, tables_found, rows_extracted, rows_inserted,
         rows_skipped_idempotent, rows_rejected, owner_user_id, classification, processed_at)
       values ('R2','d2','email','Screenshot of report','s@co.com', now() - interval '2 hours',
               'NO_DATA',0,0,0,0,0,$1,'REVIEW_REQUIRED', now() - interval '2 hours')`, [UID]);
    for (let i = 0; i < 9; i++) {
      await db.query(
        `insert into documents (report_id, document_id, source, subject, sender, received_at,
           processing_status, tables_found, rows_extracted, rows_inserted,
           rows_skipped_idempotent, rows_rejected, owner_user_id, classification, processed_at)
         values ($1,$2,'email',$3,'news@x.com', now(),'NO_DATA',0,0,0,0,0,$4,
                 'NON_REPORT', now())`,
        [`N${i}`, `dn${i}`, `New SaaS listing ${i}`, UID]);
    }
  });

  it('lists the report first even though it is the oldest message', async () => {
    const msgs = await q.getInboxMessages(UID, 15);
    expect(msgs[0].subject).toBe('Daily report');
    expect(msgs[0].classification).toBe('DEPARTMENTAL_REPORT');
  });

  it('puts what needs a person above what was ruled out', async () => {
    const msgs = await q.getInboxMessages(UID, 15);
    const review = msgs.findIndex((m: any) => m.classification === 'REVIEW_REQUIRED');
    const ignored = msgs.findIndex((m: any) => m.classification === 'NON_REPORT');
    expect(review).toBeLessThan(ignored);
  });

  it('still shows the newsletters, so nothing looks hidden', async () => {
    const msgs = await q.getInboxMessages(UID, 15);
    expect(msgs.filter((m: any) => m.classification === 'NON_REPORT').length).toBe(9);
  });
});
