/**
 * Harshal's whole journey, in the order he lives it.
 *
 * Every other suite here proves one part works. This one exists because the
 * parts have failed at their joins: a roster that saved but changed nothing on
 * the dashboard, a department that was right on import and wrong on refile,
 * figures that agreed with each other only until a filter was applied. So this
 * runs the real pipeline against a real database from an empty start, and
 * checks the numbers a manager would actually read.
 *
 * It cannot press buttons in his browser. Everything below the browser is here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';
import { parseRoster, rosterDepartmentId, rosterEmployeeId } from '../src/lib/roster';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('the complete Harshal journey', () => {
  let db: any, seedDb: any, queries: any, ingest: any, pipeline: any, refile: any, analytics: any;
  const UID = 1;

  const report = (id: string, rows: string[][], subject = 'Daily report') => ({
    documentId: id, subject, sender: 'Team <team@1xl.com>',
    receivedAt: '2026-08-31T04:00:00.000Z',
    html: `<p>Today's update.</p><table>${
      rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`
  });

  async function ingestAndStore(doc: any) {
    const masters = await db.loadMasters();
    const fps = await db.loadFingerprints(UID);
    const r = ingest.ingestDocument(doc, masters, pipeline.engineConfig(), fps);
    await db.upsertDocument({
      ownerUserId: UID, reportId: r.reportId, documentId: doc.documentId,
      source: 'test', subject: doc.subject, sender: 'team@1xl.com',
      senderDomain: '1xl.com', department: r.department, reportDate: r.reportDate,
      receivedAt: doc.receivedAt, status: r.status, tablesFound: r.tablesFound,
      rowsExtracted: r.rowsExtracted, rowsInserted: r.accepted.length,
      rowsSkipped: r.skippedIdempotent, rowsRejected: r.rejected.length, error: ''
    });
    if (r.newEmployees.length) await db.upsertEmployees(r.newEmployees);
    if (r.accepted.length) await db.insertTasks(r.accepted, UID);
    if (r.rejected.length) await db.insertRejections(r.rejected, r.rejected.map(() => null), UID);
    return r;
  }

  const HEAD = ['Date', 'Employee', 'Task', 'Status'];

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    queries = await import('../src/lib/queries');
    ingest = await import('../src/lib/core/ingest');
    pipeline = await import('../src/lib/pipeline');
    refile = await import('../src/lib/refile');
    analytics = await import('../src/lib/analytics');
    await resetDatabase(db, seedDb, { demo: false });
  }, 60_000);

  afterAll(async () => { await db.getPool().end(); });

  it('1. starts empty, and says so rather than showing zeros as facts', async () => {
    const kpis = await queries.getKpis(UID);
    expect(kpis.total).toBe(0);
    expect(await queries.getDepartmentBreakdown(UID)).toEqual([]);
  });

  it('2. imports reports that name nobody\'s department', async () => {
    const r1 = await ingestAndStore(report('m1', [
      HEAD,
      ['28 Aug 2026', 'Usman Khan', 'Approved the quarter plan', 'Completed'],
      ['28 Aug 2026', 'Usman Khan', 'Reviewed the vendor contract', 'Completed'],
      ['28 Aug 2026', 'Rahul Koli', 'Updated the SOP index', 'In Progress']
    ]));
    const r2 = await ingestAndStore(report('m2', [
      HEAD,
      ['29 Aug 2026', 'Rahul K', 'Updated the SOP index', 'Completed'],
      ['29 Aug 2026', 'Arjun Sen', 'Drafted the newsletter', 'Pending']
    ]));
    expect(r1.accepted).toHaveLength(3);
    expect(r2.accepted).toHaveLength(2);
    expect(await queries.getKpis(UID).then((k: any) => k.total)).toBe(5);
  });

  it('3. shows that work as unassigned — the problem, stated honestly', async () => {
    const depts = await queries.getDepartmentBreakdown(UID);
    const named = depts.filter((x: any) => x.department && x.department !== 'Unassigned');
    expect(named).toHaveLength(0);
  });

  it('4. accepts the organisation\'s roster, managers included', async () => {
    const parsed = parseRoster([
      'ONEXCELL INDIA TEAM LIST',
      'Team\tStaff Member\tMail ID\tAlso known as\tReporting Manager',
      'Management\tUsman Khan\tusman@1xl.com\tUsman\t',
      'SOP\tRahul Koli\trahul.koli@1xl.com\tRahul K; R Koli\tUsman Khan',
      'Content\tArjun Sen\tarjun@1xl.com\t\tMita Roy'
    ].join('\n'));
    expect(parsed.rejected).toEqual([]);
    await db.upsertRoster(
      parsed.people.map((p: any) => ({ ...p, id: rosterEmployeeId(p.name) })),
      parsed.departments.map((x: any) => ({ ...x, id: rosterDepartmentId(x.name) }))
    );

    const { people, departments } = await db.loadRoster();
    expect(people.filter((p: any) => !p.autoCreated).length).toBeGreaterThanOrEqual(3);
    expect(departments.find((x: any) => x.name === 'SOP').manager).toBe('Usman Khan');
    expect(departments.find((x: any) => x.name === 'Content').manager).toBe('Mita Roy');
  });

  it('5. re-files the work already imported, losing nothing', async () => {
    const before = await queries.getKpis(UID);
    const result = await refile.refileByRoster(UID);
    const after = await queries.getKpis(UID);

    expect(result.moved).toBe(5);
    expect(after.total).toBe(before.total);          // nothing created, nothing deleted

    const depts = await queries.getDepartmentBreakdown(UID);
    const byName = Object.fromEntries(depts.map((x: any) => [x.department, x.total]));
    expect(byName['Management']).toBe(2);
    expect(byName['SOP']).toBe(2);                    // both spellings of Rahul
    expect(byName['Content']).toBe(1);
    expect(byName['Unassigned']).toBeUndefined();
  });

  it('6. files a NEW report the same way on the way in', async () => {
    const r = await ingestAndStore(report('m3', [
      HEAD, ['30 Aug 2026', 'R Koli', 'Filed the audit note', 'Completed']
    ]));
    expect(r.accepted[0].department).toBe('SOP');
    // The historical path and the live path must agree, or the dashboard tells
    // two stories about the same person depending on when they reported.
    const depts = await queries.getDepartmentBreakdown(UID);
    expect(depts.find((x: any) => x.department === 'SOP').total).toBe(3);
  });

  it('7. refuses the same report a second time', async () => {
    const again = await ingestAndStore(report('m3-resent', [
      HEAD, ['30 Aug 2026', 'R Koli', 'Filed the audit note', 'Completed']
    ]));
    expect(again.accepted).toHaveLength(0);
    expect(await queries.getKpis(UID).then((k: any) => k.total)).toBe(6);
  });

  it('8. reconciles: the departments add up to the headline figure', async () => {
    const kpis = await queries.getKpis(UID);
    const depts = await queries.getDepartmentBreakdown(UID);
    const sum = depts.reduce((a: number, x: any) => a + x.total, 0);
    expect(sum).toBe(kpis.total);
  });

  it('9. reconciles under a filter, too', async () => {
    const all = await queries.getPeriodSeries(UID, 'daily', {});
    const sop = await queries.getPeriodSeries(UID, 'daily', { department: 'SOP' });
    const total = (s: any[]) => s.reduce((a, p) => a + p.total, 0);
    expect(total(sop)).toBe(3);
    expect(total(sop)).toBeLessThan(total(all));

    const emp = await queries.getEmployeeActivity(UID, { department: 'SOP' });
    expect(emp.map((e: any) => e.employee)).toEqual(['Rahul Koli']);
  });

  it('10. finds repeated work and explains it', async () => {
    await pipeline.rebuildAnalysis(UID);
    const groups = await queries.getRepeatGroups(UID);
    const sop = groups.find((g: any) => /SOP index/i.test(g.task));
    expect(sop).toBeTruthy();
    expect(sop.occurrences).toBeGreaterThanOrEqual(2);
    expect(sop.reason).toBeTruthy();
    expect(sop.department).toBe('SOP');
  });

  it('11. filters repeated work rather than showing everything', async () => {
    expect(await queries.getRepeatGroups(UID, { department: 'Content' })).toHaveLength(0);
    expect((await queries.getRepeatGroups(UID, { department: 'SOP' })).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('12. says slow work cannot be measured instead of inventing a number', async () => {
    const kpis = await queries.getKpis(UID);
    expect(await queries.getSlowTasks(UID)).toEqual([]);
    expect(kpis.insufficientDuration).toBe(kpis.total);
  });

  it('13. keeps a rejected row visible, with its values and a reason', async () => {
    const r = await ingestAndStore(report('m4', [
      HEAD, ['30 Aug 2026', 'Usman Khan', 'x', 'Completed']   // task too short
    ]));
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    const rejections = await queries.getRejections(UID);
    expect(rejections.length).toBeGreaterThanOrEqual(1);
    expect(rejections[0].reason).toBeTruthy();
  });

  it('14. counts coverage from every message, not from a display window', async () => {
    const coverage = await analytics.getCoverage(UID);
    // Five messages arrived. Three carried work that got in; one was the same
    // report sent again, one had a row too short to be a task. Neither of those
    // two is "processed", and neither is silently dropped — they are the two
    // waiting for a person to look. Reading them as failures, or as successes,
    // would both be wrong.
    expect(coverage.messagesScanned).toBe(5);
    expect(coverage.reportsProcessed).toBe(3);
    expect(coverage.reportsNeedingReview).toBe(2);
    expect(coverage.rowsImported).toBe(6);
    expect(coverage.duplicatesBlocked + coverage.rowsRejected).toBeGreaterThanOrEqual(2);
  });

  it('15. never lets another account see any of it', async () => {
    const other = 999;
    expect(await queries.getKpis(other).then((k: any) => k.total)).toBe(0);
    expect(await queries.getDepartmentBreakdown(other)).toEqual([]);
    expect(await queries.getRepeatGroups(other)).toEqual([]);
    expect(await queries.getRejections(other)).toEqual([]);
  });
});
