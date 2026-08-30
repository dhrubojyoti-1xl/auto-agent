/**
 * THE UNIVERSAL INGESTION ACCEPTANCE TEST.
 *
 * Ten messages, no two alike: four real reports in four formats with four
 * different column vocabularies and four different subject styles, five
 * messages that are not reports, and one that looks like a report and cannot
 * be finished. Nothing about a subject line, a column name, a column order or
 * a file type is allowed to matter.
 *
 * The requirement is not merely that the four reports import. It is that the
 * six others end with a decision a manager can read, and that resending
 * everything changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;

process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';
process.env.TOKEN_ENCRYPTION_KEY = 'universal-acceptance-key-32-chars-min!!';
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csec';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const SHEET_ID = 'OPSsheetIDforAcceptanceTesting1234567';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('ten messages, four reports, nothing silently lost', () => {
  let db: any, sync: any, accounts: any, seedDb: any, users: any, queries: any;
  let uid = 0, acctId = 0;
  let MAILBOX: any[] = [];

  beforeAll(async () => {
    // Marketing's report: XLSX, columns in an order nobody agreed, wording
    // nobody configured, and a title row above the header.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('August');
    ws.addRow(['MARKETING — DAILY REPORT']);
    ws.addRow([]);
    ws.addRow(['Current State', 'Work Done Today', 'Staff Member', 'Reporting Dt', 'Division']);
    ws.addRow(['Done', 'Write the newsletter', 'Neha Gupta',
               new Date(Date.UTC(2026, 7, 12)), 'Marketing']);
    ws.addRow(['Ongoing', 'Draft the campaign brief', 'Neha Gupta',
               new Date(Date.UTC(2026, 7, 12)), 'Marketing']);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());

    // An unrelated workbook: a real spreadsheet that is not a report.
    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet('Budget');
    ws2.addRow(['Item', 'Quantity', 'Unit Price', 'Amount']);
    ws2.addRow(['Hosting', 2, 250, 500]);
    const budget = Buffer.from(await wb2.xlsx.writeBuffer());

    db = await import('../src/lib/db');
    sync = await import('../src/lib/sync');
    accounts = await import('../src/lib/accounts');
    seedDb = await import('../src/lib/seed-db');
    users = await import('../src/lib/users');
    queries = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });

    const u = await users.upsertGoogleUser({ googleSub: 'sub-u', email: 'mgr@co.com',
      displayName: 'Manager', pictureUrl: '' });
    uid = u.id;
    const a = await accounts.upsertGmailAccount({ ownerUserId: uid, email: 'mgr@co.com',
      googleSub: 'sub-u', displayName: 'Manager', pictureUrl: '', refreshToken: 'rt',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    acctId = a.id;

    MAILBOX = [
      // 1. Sales: HTML, a signature table after it, subject says nothing.
      { id: 'r-sales', subject: 'FYI', from: 'Rahul Mehta <rahul@co.com>',
        html: '<p>Hi</p><table>' +
          '<tr><th>Date</th><th>Assigned To</th><th>Dept</th>' +
          '<th>Activity</th><th>Progress</th></tr>' +
          '<tr><td>12 Aug 2026</td><td>Rahul Mehta</td><td>Sales</td>' +
          '<td>Call the client</td><td>Done</td></tr></table>' +
          '<table><tr><td>Phone</td><td>555</td></tr></table>' },
      // 2. Marketing: XLSX with a title row and reordered, unconfigured columns.
      { id: 'r-mkt', subject: 'Monday', from: 'neha@co.com', text: 'attached',
        attachments: [{ filename: 'aug.xlsx', id: 'a-mkt', size: xlsx.length,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: xlsx }] },
      // 3. HR: CSV, no employee column at all — the sender is the author.
      { id: 'r-hr', subject: 'Re: yesterday', from: 'Kavita Menon <kavita@co.com>',
        text: 'attached', attachments: [{ filename: 'hr.csv', id: 'a-hr',
          mimeType: 'text/csv', size: 200,
          data: Buffer.from(
            'Work Date,Job Description,Current State,Team\n' +
            '12 Aug 2026,"Screen candidates, round 2",Completed,HR\n', 'utf8') }] },
      // 4. Operations: a linked Google Sheet, subject entirely unhelpful.
      { id: 'r-ops', subject: 'Fwd: Hi', from: 'Vikas Nair <vikas@co.com>',
        text: `report: https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing` },
      // 5-9. Not reports.
      { id: 'n-news', subject: 'Industry Weekly', from: 'news@x.com',
        html: '<table><tr><th>Headline</th><th>Author</th></tr>' +
              '<tr><td>A</td><td>B</td></tr></table>' },
      { id: 'n-invoice', subject: 'Invoice 991', from: 'billing@x.com',
        html: '<table><tr><th>Item</th><th>Quantity</th><th>Amount</th></tr>' +
              '<tr><td>Hosting</td><td>2</td><td>500</td></tr></table>' },
      { id: 'n-ad', subject: '50% off hosting', from: 'deals@x.com',
        html: '<div><h1>Sale</h1></div>' },
      { id: 'n-personal', subject: 'lunch?', from: 'friend@x.com', text: 'free at 1?' },
      { id: 'n-budget', subject: 'budget sheet', from: 'fin@co.com', text: 'see attached',
        attachments: [{ filename: 'budget.xlsx', id: 'a-bud', size: budget.length,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: budget }] },
      // 10. Looks like a report, cannot be finished: a screenshot.
      { id: 'ambiguous', subject: 'todays work', from: 'ops2@co.com', text: 'see image',
        attachments: [{ filename: 'report.png', id: 'a-img',
          mimeType: 'image/png', size: 300_000, data: Buffer.alloc(10) }] }
    ];

    const SHEET_CSV =
      'Reporting Date,Employee Name,Department,Task Name,Task Status\n' +
      '12 Aug 2026,Vikas Nair,Operations,Process customer orders,Completed\n' +
      '12 Aug 2026,Deepa Iyer,Operations,Dispatch shipments,In Review\n';

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      const ok = (b: unknown) => new Response(JSON.stringify(b), {
        status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return ok({ access_token: 'tok', expires_in: 3600, scope: 'gmail.readonly' });
      }
      if (url.includes('docs.google.com')) {
        return new Response(SHEET_CSV, { status: 200, headers: { 'content-type': 'text/csv' } });
      }
      if (url.includes('/messages?')) return ok({ messages: MAILBOX.map(m => ({ id: m.id })) });
      const att = url.match(/\/messages\/([^/]+)\/attachments\/([^?]+)/);
      if (att) {
        const a = MAILBOX.find(m => m.id === att[1])?.attachments
          ?.find((x: any) => x.id === att[2]);
        return a ? ok({ data: a.data.toString('base64url'), size: a.data.length })
                 : new Response('nf', { status: 404 });
      }
      const one = url.match(/\/messages\/([^?]+)/);
      const m = MAILBOX.find(x => x.id === one?.[1]);
      if (!m) return new Response('nf', { status: 404 });
      const parts: unknown[] = [];
      if (m.text) parts.push({ mimeType: 'text/plain', body: { data: b64(m.text) } });
      if (m.html) parts.push({ mimeType: 'text/html', body: { data: b64(m.html) } });
      return ok({
        id: m.id, threadId: 't', snippet: '', internalDate: String(Date.UTC(2026, 7, 12)),
        labelIds: ['INBOX'],
        payload: { mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }],
          parts: [...parts, ...(m.attachments || []).map((a: any) => ({
            mimeType: a.mimeType, filename: a.filename,
            body: { attachmentId: a.id, size: a.size } }))] }
      });
    }));

    accounts.clearTokenCache();
    await sync.syncAccount(await accounts.getGmailAccount(acctId, uid), 'universal');
    await sync.rebuildAnalysisAfterSync(uid);
  });

  afterAll(async () => { vi.unstubAllGlobals(); await db.getPool().end(); });

  it('processes exactly the four reports', async () => {
    const rows = await db.query(
      `select gmail_message_id from documents where owner_user_id = $1
         and classification = 'DEPARTMENTAL_REPORT' order by 1`, [uid]);
    expect(rows.map((r: any) => r.gmail_message_id))
      .toEqual(['r-hr', 'r-mkt', 'r-ops', 'r-sales']);
  });

  it('identifies all four departments, from four different column wordings', async () => {
    const rows = await db.query(
      `select department, count(*)::int as n from tasks where owner_user_id = $1
       group by 1 order by 1`, [uid]);
    expect(rows.map((r: any) => r.department))
      .toEqual(['HR', 'Marketing', 'Operations', 'Sales']);
  });

  it('reads a column order nobody agreed, under a title row', async () => {
    const rows = await db.query(
      `select task, task_status, employee_name from tasks
       where owner_user_id = $1 and department = 'Marketing' order by task`, [uid]);
    expect(rows.map((r: any) => r.task))
      .toEqual(['Draft the campaign brief', 'Write the newsletter']);
    expect(rows[0].employee_name).toBe('Neha Gupta');
    expect(rows[0].task_status).toBe('In Progress');   // "Ongoing"
  });

  it('attributes a report with no employee column to its sender', async () => {
    const rows = await db.query(
      `select employee_name, task from tasks where owner_user_id = $1
         and department = 'HR'`, [uid]);
    expect(rows).toHaveLength(1);
    expect(rows[0].employee_name).toBe('Kavita Menon');
    expect(rows[0].task).toBe('Screen candidates, round 2');   // comma survived
  });

  it('ignores every message that is not a report', async () => {
    const rows = await db.query(
      `select gmail_message_id from documents where owner_user_id = $1
         and classification = 'NON_REPORT' order by 1`, [uid]);
    expect(rows.map((r: any) => r.gmail_message_id))
      .toEqual(['n-ad', 'n-budget', 'n-invoice', 'n-news', 'n-personal']);
  });

  it('routes the one it could not finish to review, with a reason', async () => {
    const [row] = await db.query(
      `select classification, evidence from documents where owner_user_id = $1
         and gmail_message_id = 'ambiguous'`, [uid]);
    expect(row.classification).toBe('REVIEW_REQUIRED');
    expect(row.evidence).toMatch(/screenshot/i);
  });

  it('leaves no message without an outcome', async () => {
    const [{ n }] = await db.query(
      `select count(*)::int as n from documents where owner_user_id = $1
         and classification is not null`, [uid]);
    expect(n).toBe(10);
  });

  it('the analytics reconcile with the rows', async () => {
    const [{ total }] = await db.query(
      `select count(*)::int as total from tasks where owner_user_id = $1`, [uid]);
    expect(total).toBe(6);
    for (const grain of ['daily', 'weekly', 'monthly'] as const) {
      const series = await queries.getPeriodSeries(uid, grain, {});
      expect(series.reduce((a: number, p: any) => a + p.total, 0), grain).toBe(total);
    }
  });

  it('resending every report imports nothing', async () => {
    accounts.clearTokenCache();
    const summary = await sync.syncAccount(
      await accounts.getGmailAccount(acctId, uid), 'universal-2');
    expect(summary.rowsImported).toBe(0);
    const [{ n }] = await db.query(
      `select count(*)::int as n from tasks where owner_user_id = $1`, [uid]);
    expect(n).toBe(6);
  });

  it('the same report in a different format is still the same report', async () => {
    // Sales' HTML report, re-sent as CSV with different column wording.
    const { ingestDocument } = await import('../src/lib/core/ingest');
    const { csvToTables } = await import('../src/lib/core/attachments');
    const { seedMasters } = await import('../src/lib/seed');
    const { engineConfig } = await import('../src/lib/pipeline');
    const fingerprints = await db.loadFingerprints(uid);

    const res = ingestDocument({
      documentId: 'gmail:resent-as-csv', subject: 'again', sender: 'rahul@co.com',
      receivedAt: '2026-08-12T10:00:00.000Z',
      tables: csvToTables(
        'Reporting Dt,Staff,Division,Work Done,Current State\n' +
        '12 Aug 2026,Rahul Mehta,Sales,Call the client,Completed\n', 'x.csv')
    }, seedMasters([]), engineConfig(), fingerprints);

    expect(res.accepted).toHaveLength(0);
    expect(res.rejected.map((r: any) => r.reason)).toContain('DUPLICATE_ACROSS_DOCUMENTS');
  });
});
