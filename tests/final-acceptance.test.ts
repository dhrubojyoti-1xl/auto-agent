/**
 * THE MANAGEMENT ACCEPTANCE SCENARIO.
 *
 * Four reports where the identifying information lives in the covering
 * sentence rather than the table, alongside seven messages that are not
 * reports. Nothing about a subject, a filename, a column name, a column order
 * or a file type is allowed to matter, and every message must end with a
 * verdict a manager can read.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;

process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';
process.env.TOKEN_ENCRYPTION_KEY = 'final-acceptance-key-at-least-32-chars!';
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csec';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const SHEET_ID = 'HRsheetIDforFinalAcceptance123456789';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('a week of real reporting mail', () => {
  let db: any, sync: any, accounts: any, seedDb: any, users: any, queries: any, analytics: any;
  let uid = 0, acctId = 0;

  beforeAll(async () => {
    // Sales: XLSX, unusual column names, no department or date column at all.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Who', 'Work completed', 'Current situation']);
    ws.addRow(['Rahul Mehta', 'Call the client', 'Done']);
    ws.addRow(['Priya Sharma', 'Prepare the quote', 'Ongoing']);
    const salesXlsx = Buffer.from(await wb.xlsx.writeBuffer());

    // An unrelated workbook, to be ruled out.
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
    analytics = await import('../src/lib/analytics');
    await resetDatabase(db, seedDb, { demo: false });

    const u = await users.upsertGoogleUser({ googleSub: 'sub-f', email: 'mgr@co.com',
      displayName: 'Manager', pictureUrl: '' });
    uid = u.id;
    const a = await accounts.upsertGmailAccount({ ownerUserId: uid, email: 'mgr@co.com',
      googleSub: 'sub-f', displayName: 'Manager', pictureUrl: '', refreshToken: 'rt',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    acctId = a.id;

    const MAILBOX = [
      // 1. Everything identifying it is in the covering sentence.
      { id: 'r-sales', subject: 'FYI', from: 'Team Lead <lead@co.com>',
        text: 'Sales team update for yesterday.',
        attachments: [{ filename: 'update.xlsx', id: 'a1', size: salesXlsx.length,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: salesXlsx }] },
      // 2. CSV, different headings again, department only in the body.
      { id: 'r-ops', subject: 'Monday', from: 'ops.lead@co.com',
        text: 'Operations update for 28 Aug 2026.',
        attachments: [{ filename: 'data.csv', id: 'a2', mimeType: 'text/csv', size: 200,
          data: Buffer.from(
            'Person,Activity,Progress\n' +
            'Vikas Nair,"Process orders, batch 2",Completed\n', 'utf8') }] },
      // 3. Google Sheet link, department stated in the body.
      { id: 'r-hr', subject: 'Re: yesterday', from: 'hr.lead@co.com',
        text: `HR report attached. https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` },
      // 4. HTML table in the body, department in a column.
      { id: 'r-mkt', subject: 'Weekly work', from: 'neha@co.com',
        html: '<table><tr><th>Report Date</th><th>Staff</th><th>Dept</th>' +
              '<th>Work done</th><th>State</th></tr>' +
              '<tr><td>27 Aug 2026</td><td>Neha Gupta</td><td>Marketing</td>' +
              '<td>Write the newsletter</td><td>Finished</td></tr></table>' },
      // 5-11. Not reports, or not readable.
      { id: 'n-news', subject: 'Industry Weekly', from: 'news@x.com',
        html: '<table><tr><th>Headline</th><th>Author</th></tr><tr><td>A</td><td>B</td></tr></table>' },
      { id: 'n-invoice', subject: 'Invoice 991', from: 'billing@x.com',
        html: '<table><tr><th>Item</th><th>Quantity</th><th>Amount</th></tr>' +
              '<tr><td>Hosting</td><td>2</td><td>500</td></tr></table>' },
      { id: 'n-ad', subject: '50% off', from: 'deals@x.com', html: '<h1>Sale</h1>' },
      { id: 'n-personal', subject: 'lunch?', from: 'friend@x.com', text: 'free at 1?' },
      { id: 'n-budget', subject: 'budget', from: 'fin@co.com', text: 'attached',
        attachments: [{ filename: 'budget.xlsx', id: 'a3', size: budget.length,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: budget }] },
      { id: 'x-image', subject: 'todays work', from: 'x@co.com', text: 'see image',
        attachments: [{ filename: 'report.png', id: 'a4', mimeType: 'image/png',
          size: 300_000, data: Buffer.alloc(10) }] },
      { id: 'x-pdf', subject: 'Daily Report', from: 'y@co.com', text: 'attached',
        attachments: [{ filename: 'Daily Report.pdf', id: 'a5',
          mimeType: 'application/pdf', size: 90_000, data: Buffer.alloc(10) }] }
    ];

    const HR_CSV =
      'Report Date,Employee Name,Task,Status\n' +
      '28 Aug 2026,Kavita Menon,Screen candidates,Completed\n';

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      const ok = (b: unknown) => new Response(JSON.stringify(b), {
        status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return ok({ access_token: 'tok', expires_in: 3600, scope: 'gmail.readonly' });
      }
      if (url.includes('docs.google.com')) {
        return url.includes('format=xlsx')
          ? new Response('<html>Sign in</html>',
              { status: 200, headers: { 'content-type': 'text/html' } })
          : new Response(HR_CSV, { status: 200, headers: { 'content-type': 'text/csv' } });
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
        id: m.id, threadId: 't', snippet: '', internalDate: String(Date.UTC(2026, 7, 30)),
        labelIds: ['INBOX'],
        payload: { mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }],
          parts: [...parts, ...(m.attachments || []).map((a: any) => ({
            mimeType: a.mimeType, filename: a.filename,
            body: { attachmentId: a.id, size: a.size } }))] }
      });
    }));

    accounts.clearTokenCache();
    await sync.syncAccount(await accounts.getGmailAccount(acctId, uid), 'final');
    await sync.rebuildAnalysisAfterSync(uid);
  });

  afterAll(async () => { vi.unstubAllGlobals(); await db.getPool().end(); });

  it('reads a report whose table names neither its department nor its date', async () => {
    const rows = await db.query(
      `select employee_name, department, task, task_status, task_date from tasks
       where owner_user_id = $1 and department = 'Sales' order by employee_name`, [uid]);
    expect(rows).toHaveLength(2);
    // "Sales team update for yesterday", sent 30 Aug.
    expect(String(rows[0].task_date)).toContain('2026-08-29');
    expect(rows.map((r: any) => r.employee_name)).toEqual(['Priya Sharma', 'Rahul Mehta']);
    expect(rows[0].task_status).toBe('In Progress');   // "Ongoing"
  });

  it('takes an explicit date out of the covering sentence', async () => {
    const [row] = await db.query(
      `select task_date, task from tasks where owner_user_id = $1
         and department = 'Operations'`, [uid]);
    expect(String(row.task_date)).toContain('2026-08-28');
    expect(row.task).toBe('Process orders, batch 2');   // the comma survived
  });

  it('reads a report that only exists behind a link', async () => {
    const [row] = await db.query(
      `select employee_name, task_date from tasks where owner_user_id = $1
         and department = 'HR'`, [uid]);
    expect(row.employee_name).toBe('Kavita Menon');
    expect(String(row.task_date)).toContain('2026-08-28');
  });

  it('separates all four departments', async () => {
    const rows = await db.query(
      `select distinct department from tasks where owner_user_id = $1 order by 1`, [uid]);
    expect(rows.map((r: any) => r.department))
      .toEqual(['HR', 'Marketing', 'Operations', 'Sales']);
  });

  it('rules out every message that is not a report', async () => {
    const rows = await db.query(
      `select gmail_message_id from documents where owner_user_id = $1
         and classification = 'NON_REPORT' order by 1`, [uid]);
    expect(rows.map((r: any) => r.gmail_message_id))
      .toEqual(['n-ad', 'n-budget', 'n-invoice', 'n-news', 'n-personal']);
  });

  it('routes what it cannot read to review, saying a report was detected', async () => {
    const rows = await db.query(
      `select gmail_message_id, classification, evidence from documents
       where owner_user_id = $1
         and classification in ('REVIEW_REQUIRED','UNSUPPORTED_FORMAT') order by 1`, [uid]);
    expect(rows.map((r: any) => r.gmail_message_id)).toEqual(['x-image', 'x-pdf']);
    for (const r of rows) {
      expect(r.evidence, r.gmail_message_id).toMatch(/report/i);
      expect(r.evidence, r.gmail_message_id).not.toMatch(/^No table found/);
    }
  });

  it('leaves no message without a verdict', async () => {
    const [{ n }] = await db.query(
      `select count(*)::int as n from documents where owner_user_id = $1
         and classification is not null`, [uid]);
    expect(n).toBe(11);
  });

  it('the canonical figures agree with the rows', async () => {
    const c = await analytics.getCoverage(uid);
    const [{ total }] = await db.query(
      `select count(*)::int as total from tasks where owner_user_id = $1`, [uid]);
    expect(total).toBe(5);
    expect(c.rowsImported).toBe(total);
    expect(c.reportsProcessed).toBe(4);
    expect(c.messagesScanned).toBe(11);

    for (const grain of ['daily', 'weekly', 'monthly'] as const) {
      const series = await queries.getPeriodSeries(uid, grain, {});
      expect(series.reduce((a: number, p: any) => a + p.total, 0), grain).toBe(total);
    }
  });

  it('the whole mailbox again imports nothing', async () => {
    accounts.clearTokenCache();
    const summary = await sync.syncAccount(
      await accounts.getGmailAccount(acctId, uid), 'final-2');
    expect(summary.rowsImported).toBe(0);
    const [{ n }] = await db.query(
      `select count(*)::int as n from tasks where owner_user_id = $1`, [uid]);
    expect(n).toBe(5);
  });

  it('the management insight states only what the data supports', async () => {
    const { buildInsight } = await import('../src/lib/insight');
    const kpis = await queries.getKpis(uid);
    const series = await queries.getPeriodSeries(uid, 'daily', { limit: 30 });
    const insight = buildInsight(kpis, series, await analytics.getCoverage(uid), 'day');
    expect(insight.headline).toContain('5 tasks');
    expect(insight.headline).toContain('4 departments');
    // Nothing about a best department, and no trend from a handful of rows.
    expect(JSON.stringify(insight)).not.toMatch(/best|top performer|most productive/i);
  });
});
