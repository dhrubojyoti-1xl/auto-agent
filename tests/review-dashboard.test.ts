/**
 * The 28-09-2026 review, against the dashboard queries and the database.
 *
 * The data here is what the review's screenshots show: real people beside task
 * titles that an older import recorded as names ("Content Team", "Hr Meeting").
 * None of those rows is changed. They stay in every department total and are
 * kept out of lists of people only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';
import { summariseDepartmentDay, departmentDayAsText } from '../src/lib/core/department-day';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

// employee, department, task, status, date, hours
const ROWS: [string, string, string, string, string, number | null][] = [
  ['Asha Rao', 'SOP', 'Prepared the SOP index', 'Completed', '2026-09-26', 1.5],
  ['Asha Rao', 'SOP', 'Reviewed two SOP drafts', 'In Progress', '2026-09-26', null],
  ['Meera Iyer', 'SOP', 'Audit of the store SOP', 'Blocked', '2026-09-26', 2],
  ['Content Team', 'SOP', 'Blog calendar', 'Completed', '2026-09-26', null],
  ['Vikram Nair', 'Content', 'Wrote two product pages', 'Completed', '2026-09-26', 3],
  ['Hr Meeting', 'Content', 'Weekly HR sync', 'Completed', '2026-09-26', null],
  ['Vikram Nair', 'Content', 'Edited the brochure', 'Pending', '2026-09-25', null],
  ['Karan Mehta', 'Support', 'Closed ten tickets', 'Completed', '2026-09-26', null]
];

/* eslint-disable @typescript-eslint/no-explicit-any */
d('the review fixes, end to end', () => {
  let db: any, seedDb: any, q: any;
  const UID = 1;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    q = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });
    for (let i = 0; i < ROWS.length; i++) {
      const [emp, dept, task, status, date, hours] = ROWS[i];
      await db.query(
        `insert into tasks (task_id, task_date, department, employee_name, task,
                            task_normalized, task_status, duration_basis, actual_duration,
                            source_document_id, task_fingerprint, owner_user_id, work_kind)
         values ($1, $2::date, $3, $4, $5, lower($5), $6, 'Insufficient Data', $7,
                 'REVIEW', $8, $9, 'REPORTED')`,
        ['R' + i, date, dept, emp, task, status, hours, 'r' + i, UID]);
    }
    // Two people on the roster for SOP; one of them sent nothing on the 26th.
    await db.upsertRoster(
      [{ id: 'EMP-R1', name: 'Asha Rao', department: 'SOP', email: 'asha.rao@example.com', aliases: [], role: '' },
       { id: 'EMP-R2', name: 'Neha Kulkarni', department: 'SOP', email: 'neha@example.com', aliases: [], role: '' }],
      [{ id: 'DEP-SOP', name: 'SOP', manager: '', managerEmail: '' }]);
  });

  afterAll(async () => { await db.getPool().end(); });

  it('lists people in the Employee drop-down, never task titles', async () => {
    const all = await q.getFilterOptions(UID);
    expect(all.employees).toEqual(['Asha Rao', 'Karan Mehta', 'Meera Iyer', 'Vikram Nair']);
  });

  it('narrows the Employee drop-down to the chosen department', async () => {
    const sop = await q.getFilterOptions(UID, { department: 'SOP' });
    expect(sop.employees).toEqual(['Asha Rao', 'Meera Iyer']);
    // Departments are unaffected by the choice.
    expect(sop.departments).toEqual(['Content', 'SOP', 'Support']);
  });

  it('ranks people only, and says what it left out', async () => {
    const panel = await q.getEmployeeActivityPanel(UID, { limit: 10 });
    expect(panel.rows.map((r: any) => r.employee)).not.toContain('Content Team');
    expect(panel.rows.map((r: any) => r.employee)).not.toContain('Hr Meeting');
    expect(panel.hiddenNames).toBe(2);
    expect(panel.hiddenTasks).toBe(2);
  });

  it('changes no figure: the hidden rows still count in the totals', async () => {
    const kpis = await q.getKpis(UID);
    expect(kpis.total).toBe(ROWS.length);
    const depts = await q.getDepartmentBreakdown(UID);
    const sop = depts.find((x: any) => x.department === 'SOP');
    expect(sop.total).toBe(4);
    // ...while the headcount beside them counts people.
    expect(sop.employees).toBe(2);
    expect(kpis.employeesReporting).toBe(4);
    const [{ n }] = await db.query(`select count(*)::int as n from tasks`);
    expect(n).toBe(ROWS.length);
  });

  it('summarises each department for the latest day', async () => {
    const day = await q.getDepartmentDay(UID);
    expect(day.date).toBe('2026-09-26');
    expect(day.available).toEqual(['2026-09-26', '2026-09-25']);
    const days = summariseDepartmentDay(day.rows, day.roster, day.isPerson);
    const sop = days.find(x => x.department === 'SOP')!;
    expect(sop.total).toBe(4);
    expect(sop.completed).toBe(2);
    expect(sop.completionRate).toBe(50);
    expect(sop.blocked).toBe(1);
    expect(sop.hours).toBe(3.5);
    expect(sop.notReported).toEqual(['Neha Kulkarni']);
    expect(sop.unattributed).toBe(1);
    expect(sop.headline).toBe('2 of 2 people reported 4 tasks; 2 completed (50%).');
    expect(sop.points.join(' ')).toMatch(/1 task blocked: “Audit of the store SOP” \(Meera Iyer\)/);
    expect(sop.points.join(' ')).toMatch(/No report from Neha Kulkarni/);
    const text = departmentDayAsText(day.date, days);
    expect(text).toMatch(/^Department summaries — 2026-09-26/);
    expect(text).toMatch(/Content: 1 person reported 2 tasks; 2 completed \(100%\)\./);
  });

  it('summarises a chosen earlier day', async () => {
    const day = await q.getDepartmentDay(UID, '2026-09-25');
    const days = summariseDepartmentDay(day.rows, day.roster, day.isPerson);
    expect(days.map(x => x.department)).toEqual(['Content']);
    expect(days[0].notDone).toBe(1);
  });

  describe('only reports are ever shown', () => {
    // [message id, source, subject, status, tables, inserted, rejected, classification, evidence]
    const DOCS: [string, string, string, string, number, number, number, string, string][] = [
      ['m1', 'email', 'DWR Asha Rao 26/09', 'SUCCESS', 1, 3, 0, 'DEPARTMENTAL_REPORT', 'report table'],
      ['m2', 'email', 'Diwali sale — 50% off everything', 'NO_DATA', 0, 0, 0, 'NON_REPORT', 'No table found'],
      ['m3', 'email', 'Personal: dinner on Friday?', 'NO_DATA', 0, 0, 0, 'NON_REPORT', 'No table found'],
      ['m4', 'email', 'Invoice INV-2231.pdf', 'NO_DATA', 0, 0, 0, 'UNSUPPORTED_FORMAT', 'PDF not parsed'],
      ['m5', 'email', 'Budget sheet link', 'NO_DATA', 0, 0, 0, 'REVIEW_REQUIRED',
       'Google Sheet 1abc…: the sheet is not shared'],
      ['m6', 'email', 'DWR screenshot Ravi', 'NO_DATA', 0, 0, 0, 'REVIEW_REQUIRED',
       'A report was detected in dwr.png and could not be transcribed.'],
      ['m7', 'email', 'DWR Meera — every row wrong', 'PARTIAL', 1, 0, 4, 'REVIEW_REQUIRED', '4 rejected']
    ];

    beforeAll(async () => {
      for (const [id, source, subject, status, tables, inserted, rejected, cls, evidence] of DOCS) {
        await db.query(
          `insert into documents (report_id, document_id, source, subject, sender, processing_status,
                                  tables_found, rows_inserted, rows_rejected, classification, evidence,
                                  gmail_message_id, owner_user_id, received_at)
           values ($1, $2, $3, $4, 'someone@example.com', $5, $6, $7, $8, $9, $10, $11, $12,
                   now())`,
          ['DOC-' + id, 'gmail:' + id, source, subject, status, tables, inserted, rejected,
           cls, evidence, id, UID]);
      }
      // Skipped attachments are logged against the message: one on a report,
      // one on a newsletter.
      for (const [id, reason] of [['m1', 'ATTACHMENT_NOT_A_REPORT'], ['m2', 'ATTACHMENT_NOT_A_REPORT'],
                                  ['m6', 'IMAGE_REVIEW_REQUIRED']]) {
        await db.query(
          `insert into data_quality (report_id, document_id, table_index, row_index,
                                     rejection_reason, rejection_detail, raw_row, owner_user_id)
           values ($1, $2, 0, 0, $3, 'detail', $4, $5)`,
          ['GM-' + id, `gmail:${id}:file.xlsx`, reason,
           JSON.stringify({ subject: 'subject of ' + id }), UID]);
      }
    });

    const shownSubjects = (rows: any[]) => rows.map(r => r.subject).sort();

    it('the Inbox lists reports and nothing else', async () => {
      expect(shownSubjects(await q.getInboxMessages(UID, 50))).toEqual([
        'DWR Asha Rao 26/09', 'DWR Meera — every row wrong', 'DWR screenshot Ravi'
      ]);
      expect(await q.getOtherMessageCount(UID)).toEqual({ total: 4, unreadable: 2 });
    });

    it('Data quality lists reports that need a person, never other mail', async () => {
      expect(shownSubjects(await q.getMessageOutcomes(UID, 50)))
        .toEqual(['DWR Meera — every row wrong', 'DWR screenshot Ravi']);
      const docs = await q.getDocuments(UID, 50);
      expect(docs.map((x: any) => x.subject)).not.toContain('Personal: dinner on Friday?');
      const rejections = await q.getRejections(UID);
      const fromMessages = rejections.filter((r: any) => r.documentId.startsWith('gmail:'));
      expect(fromMessages.map((r: any) => r.documentId).sort())
        .toEqual(['gmail:m1:file.xlsx', 'gmail:m6:file.xlsx']);
    });

    it('the charting view carries reports only', async () => {
      const rows = await db.query(`select subject from bi_messages where owner_user_id = $1`, [UID]);
      expect(shownSubjects(rows)).toEqual([
        'DWR Asha Rao 26/09', 'DWR Meera — every row wrong', 'DWR screenshot Ravi'
      ]);
    });

    it('hides without deleting: every message record is still there', async () => {
      const [{ n }] = await db.query(`select count(*)::int as n from documents where owner_user_id = $1`, [UID]);
      expect(n).toBe(DOCS.length);
    });
  });

  it('ROSTER_ONLY narrows every list of people to the roster', async () => {
    process.env.ROSTER_ONLY = 'true';
    try {
      const opts = await q.getFilterOptions(UID);
      expect(opts.employees).toEqual(['Asha Rao']);
    } finally {
      delete process.env.ROSTER_ONLY;
    }
  });
});
