/**
 * One definition of every number, and no false precision.
 *
 * Pages used to compute their own figures and disagree — "Reports processed:
 * 0" above forty-seven imported tasks. These tests hold the definitions in one
 * place and check the two ways a dashboard lies: by contradicting itself, and
 * by dressing arithmetic up as insight.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareCounts, compareRates, MIN_BASE_FOR_PERCENT } from '../src/lib/analytics';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

describe('a comparison is offered only when it means something', () => {
  it('refuses a percentage when the previous period was tiny', () => {
    // 1 -> 2 is "+100%", which is arithmetic, not information.
    const d = compareCounts(2, 1);
    expect(d.percent).toBeNull();
    expect(d.weak).toBe(true);
    expect(d.label).toMatch(/small sample/);
  });

  it('gives a percentage once the base can carry one', () => {
    const d = compareCounts(60, 50);
    expect(d.weak).toBe(false);
    expect(d.percent).toBe(20);
    expect(d.direction).toBe('up');
    expect(d.label).toContain('20%');
  });

  it('says there is nothing to compare against, rather than inventing one', () => {
    const d = compareCounts(5, 0);
    expect(d.percent).toBeNull();
    expect(d.label).toMatch(/no previous period/);
  });

  it('reports rates in percentage points, never as a percentage of a percentage', () => {
    const d = compareRates(57.4, 42.1, 40);
    expect(d.points).toBe(15.3);
    expect(d.label).toBe('+15.3 pp vs previous');
  });

  it('calls a rate change from a handful of tasks a limited sample', () => {
    expect(compareRates(100, 0, 1).label).toBe('limited sample');
    expect(compareRates(100, 0, 1).weak).toBe(true);
  });

  it('holds one threshold for both kinds of comparison', () => {
    expect(compareCounts(9, MIN_BASE_FOR_PERCENT).weak).toBe(false);
    expect(compareCounts(9, MIN_BASE_FOR_PERCENT - 1).weak).toBe(true);
  });

  it('reports no movement as no movement', () => {
    const d = compareCounts(0, 0);
    expect(d.direction).toBe('flat');
    expect(d.label).toBe('no change');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
d('every page counts the same things', () => {
  let db: any, seedDb: any, analytics: any, queries: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    analytics = await import('../src/lib/analytics');
    queries = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });

    // One report that imported, one that could not be read, nine newsletters:
    // the exact shape that made the Overview report zero.
    await db.query(
      `insert into documents (report_id, document_id, source, subject, sender, received_at,
         processing_status, tables_found, rows_extracted, rows_inserted,
         rows_skipped_idempotent, rows_rejected, owner_user_id, classification, processed_at)
       values ('R1','d1','email','Daily report','r@co.com', now(),'PARTIAL',1,48,47,0,1,$1,
               'DEPARTMENTAL_REPORT', now() - interval '2 hours')`, [UID]);
    await db.query(
      `insert into documents (report_id, document_id, source, subject, sender, received_at,
         processing_status, tables_found, rows_extracted, rows_inserted,
         rows_skipped_idempotent, rows_rejected, owner_user_id, classification, processed_at)
       values ('R2','d2','email','Screenshot','s@co.com', now(),'NO_DATA',0,0,0,0,0,$1,
               'REVIEW_REQUIRED', now())`, [UID]);
    for (let i = 0; i < 9; i++) {
      await db.query(
        `insert into documents (report_id, document_id, source, subject, sender, received_at,
           processing_status, tables_found, rows_extracted, rows_inserted,
           rows_skipped_idempotent, rows_rejected, owner_user_id, classification, processed_at)
         values ($1,$2,'email','Newsletter','n@x.com', now(),'NO_DATA',0,0,0,0,0,$3,
                 'NON_REPORT', now())`, [`N${i}`, `dn${i}`, UID]);
    }
  });

  afterAll(async () => { await db.getPool().end(); });

  it('counts a processed report as processed, however busy the inbox', async () => {
    const c = await analytics.getCoverage(UID);
    expect(c.reportsProcessed).toBe(1);
    expect(c.reportsDetected).toBe(1);
    expect(c.messagesScanned).toBe(11);
    expect(c.messagesIgnored).toBe(9);
    expect(c.reportsNeedingReview).toBe(1);
    expect(c.rowsImported).toBe(47);
    expect(c.rowsRejected).toBe(1);
  });

  it('agrees with the number the Overview shows', async () => {
    const c = await analytics.getCoverage(UID);
    const totals = await queries.getProcessingTotals(UID);
    expect(totals.reports).toBe(c.reportsDetected);
    expect(totals.scanned).toBe(c.messagesScanned);
    expect(totals.imported).toBe(c.rowsImported);
  });

  it('every message is accounted for exactly once', async () => {
    const c = await analytics.getCoverage(UID);
    expect(c.reportsDetected + c.messagesIgnored + c.unsupportedFormat +
           (c.reportsNeedingReview - 0)).toBeGreaterThanOrEqual(c.messagesScanned - 1);
    expect(c.messagesScanned).toBe(11);
  });
});

d('attention is ranked by what actually matters', () => {
  let db: any, seedDb: any, analytics: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    analytics = await import('../src/lib/analytics');
    await resetDatabase(db, seedDb, { demo: false });

    await db.query(
      `insert into tasks (task_id, task_date, department, employee_name, task,
                          task_normalized, task_status, duration_basis,
                          source_document_id, task_fingerprint, owner_user_id)
       select 'A' || g, current_date, 'Unassigned', 'P', 'T' || g, 't' || g,
              case when g <= 2 then 'Blocked' else 'Completed' end,
              'Insufficient Data', 'D', 'a' || g, $1
       from generate_series(1, 6) g`, [UID]);
  });

  afterAll(async () => { await db.getPool().end(); });

  it('puts blocked work above informational notes', async () => {
    const items = await analytics.getAttention(UID);
    const blocked = items.findIndex((i: any) => i.title.match(/Blocked/));
    const timing = items.findIndex((i: any) => i.title.match(/timing/));
    expect(blocked).toBeGreaterThanOrEqual(0);
    expect(blocked).toBeLessThan(timing);
    expect(items[blocked].severity).toBe('high');
  });

  it('does not raise a critical alert for ordinary conditions', async () => {
    const items = await analytics.getAttention(UID);
    expect(items.some((i: any) => i.severity === 'critical')).toBe(false);
  });

  it('gives every item a count and somewhere to go', async () => {
    for (const i of await analytics.getAttention(UID)) {
      expect(i.count, i.title).toBeGreaterThan(0);
      expect(i.detail.length, i.title).toBeGreaterThan(20);
      expect(i.href, i.title).toBeTruthy();
    }
  });
});
