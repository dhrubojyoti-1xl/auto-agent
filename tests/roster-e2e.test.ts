/**
 * The whole chain Harshal actually needs, against a real database.
 *
 * He pastes a team list; his teams keep sending the same reports they always
 * sent, with no department column in them. The work must arrive filed under
 * Management and SOP rather than piled into Unassigned — which is what he saw
 * on the demo call, 47 rows of it.
 *
 * This is deliberately end-to-end: parse the paste, write it, reload masters
 * from the database, ingest a report through the real pipeline, and look at
 * the department on the stored rows. Every one of those steps has been wrong
 * at some point; testing them separately would have missed it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';
import { parseRoster, rosterDepartmentId, rosterEmployeeId } from '../src/lib/roster';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('roster to dashboard, end to end', () => {
  let db: any, seedDb: any, ingest: any, pipeline: any;

  const SHEET = [
    'ONEXCELL INDIA — TEAM LIST',
    'Team\tStaff Member\tMail ID\tAlso known as\tReporting Manager',
    'Management\tUsman Khan\tusman@1xl.com\tUsman\t',
    'SOP\tRahul Koli\trahul.koli@1xl.com\tRahul K; R Koli\tUsman Khan'
  ].join('\n');

  const report = (docId: string, rows: string[][]) => ({
    documentId: docId,
    subject: 'Daily report',
    sender: 'Team <team@1xl.com>',
    receivedAt: '2026-08-31T04:00:00.000Z',
    html: `<p>Today's update.</p><table>${
      rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`
  });

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    ingest = await import('../src/lib/core/ingest');
    pipeline = await import('../src/lib/pipeline');
    await resetDatabase(db, seedDb, { demo: false });

    const parsed = parseRoster(SHEET);
    await db.upsertRoster(
      parsed.people.map(p => ({ ...p, id: rosterEmployeeId(p.name) })),
      parsed.departments.map(x => ({ ...x, id: rosterDepartmentId(x.name) }))
    );
  });

  afterAll(async () => { await db.getPool().end(); });

  it('stores the pasted roster, acronyms intact', async () => {
    const { people, departments } = await db.loadRoster();
    expect(people.map((p: any) => p.name).sort()).toEqual(['Rahul Koli', 'Usman Khan']);
    // The seed already ships common departments, so the import must ADD to the
    // list rather than replace it — a manager who imports a partial sheet must
    // not lose the departments they already had.
    const names = departments.map((x: any) => x.name);
    expect(names).toContain('SOP');
    expect(names).toContain('Management');
    const rahul = people.find((p: any) => p.name === 'Rahul Koli');
    expect(rahul.department).toBe('SOP');
    expect(rahul.autoCreated).toBe(false);
  });

  it('records the manager separately from the employees', async () => {
    const { departments } = await db.loadRoster();
    const sop = departments.find((x: any) => x.name === 'SOP');
    expect(sop.manager).toBe('Usman Khan');
  });

  it('files a department-less report to the right departments', async () => {
    const masters = await db.loadMasters();
    const r = ingest.ingestDocument(
      report('e2e-1', [
        ['Date', 'Employee', 'Task', 'Status'],
        ['30 Aug 2026', 'Usman Khan', 'Approved the quarter plan', 'Completed'],
        ['30 Aug 2026', 'Rahul K', 'Updated the SOP index', 'In Progress']
      ]),
      masters, pipeline.engineConfig(), new Map()
    );

    const byName = Object.fromEntries(r.accepted.map((t: any) => [t.employeeName, t.department]));
    expect(byName['Usman Khan']).toBe('Management');
    expect(byName['Rahul Koli']).toBe('SOP');
    expect(Object.values(byName)).not.toContain('Unassigned');
  });

  it('re-importing a corrected sheet updates people instead of duplicating them', async () => {
    const parsed = parseRoster([
      'Team,Staff Member,Mail ID',
      'Operations,Rahul Koli,rahul.koli@1xl.com'      // he has moved team
    ].join('\n'));
    await db.upsertRoster(
      parsed.people.map(p => ({ ...p, id: rosterEmployeeId(p.name) })),
      parsed.departments.map(x => ({ ...x, id: rosterDepartmentId(x.name) }))
    );

    const { people } = await db.loadRoster();
    const rahuls = people.filter((p: any) => p.name === 'Rahul Koli');
    expect(rahuls).toHaveLength(1);
    expect(rahuls[0].department).toBe('Operations');
    // The names he is known by survive the move — losing them would quietly
    // send "Rahul K" back to Unassigned.
    expect(rahuls[0].aliases.sort()).toEqual(['R Koli', 'Rahul K']);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
d('the roster is applied to work that is already imported', () => {
  let db: any, seedDb: any, ingest: any, pipeline: any, refile: any;
  const UID = 1;

  const report = (docId: string, rows: string[][]) => ({
    documentId: docId,
    subject: 'Daily report',
    sender: 'Team <team@1xl.com>',
    receivedAt: '2026-08-31T04:00:00.000Z',
    html: `<p>Today's update.</p><table>${
      rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`
  });

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    ingest = await import('../src/lib/core/ingest');
    pipeline = await import('../src/lib/pipeline');
    refile = await import('../src/lib/refile');
    await resetDatabase(db, seedDb, { demo: false });

    // Reports arrive BEFORE anybody has told the product who these people are —
    // which is the order it happens in real life.
    const masters = await db.loadMasters();
    const r = ingest.ingestDocument(
      report('before-roster', [
        ['Date', 'Employee', 'Task', 'Status'],
        ['30 Aug 2026', 'Usman Khan', 'Approved the quarter plan', 'Completed'],
        ['30 Aug 2026', 'Usman Khan', 'Signed off the budget', 'Completed'],
        ['30 Aug 2026', 'Rahul Koli', 'Updated the SOP index', 'In Progress']
      ]),
      masters, pipeline.engineConfig(), new Map()
    );
    await db.upsertDocument({
      ownerUserId: UID, reportId: r.reportId, documentId: 'before-roster',
      source: 'test', subject: 'Daily report', sender: 'team@1xl.com',
      senderDomain: '1xl.com', department: r.department, reportDate: r.reportDate,
      receivedAt: '2026-08-31T04:00:00.000Z', status: r.status,
      tablesFound: r.tablesFound, rowsExtracted: r.rowsExtracted,
      rowsInserted: r.accepted.length, rowsSkipped: r.skippedIdempotent,
      rowsRejected: r.rejected.length, error: ''
    });
    await db.insertTasks(r.accepted, UID);
  });

  afterAll(async () => { await db.getPool().end(); });

  it('starts out unassigned, which is the problem being fixed', async () => {
    const rows = await db.query(
      `select coalesce(nullif(department,''),'Unassigned') as d, count(*)::int as n
         from tasks where owner_user_id = $1 group by 1`, [UID]);
    const unassigned = rows.find((x: any) => x.d === 'Unassigned' || x.d === null);
    expect(unassigned?.n).toBe(3);
  });

  it('moves the existing rows once the roster arrives', async () => {
    const parsed = parseRoster([
      'Team,Staff Member',
      'Management,Usman Khan',
      'SOP,Rahul Koli'
    ].join('\n'));
    await db.upsertRoster(
      parsed.people.map((p: any) => ({ ...p, id: rosterEmployeeId(p.name) })),
      parsed.departments.map((x: any) => ({ ...x, id: rosterDepartmentId(x.name) }))
    );

    const result = await refile.refileByRoster(UID);
    expect(result.moved).toBe(3);

    const rows = await db.query(
      `select department as d, count(*)::int as n
         from tasks where owner_user_id = $1 group by 1 order by 1`, [UID]);
    const byDept = Object.fromEntries(rows.map((r: any) => [r.d, r.n]));
    expect(byDept['Management']).toBe(2);
    expect(byDept['SOP']).toBe(1);
    expect(byDept['Unassigned']).toBeUndefined();
  });

  it('recomputes the fingerprints, so the same report cannot import twice', async () => {
    // The identity of a row includes its department. Had refiling left the old
    // fingerprints behind, this second copy would not recognise itself.
    const masters = await db.loadMasters();
    const fingerprints = await db.loadFingerprints(UID);
    const again = ingest.ingestDocument(
      report('same-report-resent', [
        ['Date', 'Employee', 'Task', 'Status'],
        ['30 Aug 2026', 'Usman Khan', 'Approved the quarter plan', 'Completed'],
        ['30 Aug 2026', 'Usman Khan', 'Signed off the budget', 'Completed'],
        ['30 Aug 2026', 'Rahul Koli', 'Updated the SOP index', 'In Progress']
      ]),
      masters, pipeline.engineConfig(), fingerprints
    );

    // Nothing gets in. Arriving under a different message id, these are
    // rejected as duplicates rather than skipped as a safe re-run of the same
    // document — which is the distinction the Data Quality page relies on.
    expect(again.accepted).toHaveLength(0);
    expect(again.rejected).toHaveLength(3);
    expect(again.rejected.map((x: any) => x.reason)).toContain('DUPLICATE_ACROSS_DOCUMENTS');
  });

  it('is idempotent — re-filing again moves nothing', async () => {
    const result = await refile.refileByRoster(UID);
    expect(result.moved).toBe(0);
  });
});
