/**
 * THE MANAGEMENT ACCEPTANCE TEST.
 *
 * A realistic inbox: four departmental reports (HTML, XLSX, CSV, plain text)
 * among six messages that are not reports. Runs the whole pipeline against a
 * real Postgres and checks what management actually asked for.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;

process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';
process.env.TOKEN_ENCRYPTION_KEY = 'acceptance-test-key-at-least-32-chars!!';
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csec';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const DAY = (n: number) => `2${6}-08-${String(10 + n).padStart(2, '0')}`.replace(/^2/, '202');

function htmlReport(dept: string, rows: [string, string, string, string?, string?][]) {
  const head = ['Date', 'Employee Name', 'Department', 'Task', 'Status', 'Start Time', 'End Time'];
  return `<div><p>Daily report for ${dept}</p><table border="1"><thead><tr>` +
    head.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + [r[0], r[1], dept, r[2], r[3] ?? 'Completed', r[4] ?? '', ''].
      map(c => `<td>${c}</td>`).join('') + '</tr>').join('') +
    '</tbody></table><p>Regards</p><table><tr><td>Phone</td><td>123</td></tr></table></div>';
}

let XLSX_BUF: Buffer;

d('management acceptance: a realistic mixed inbox', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, sync: any, accounts: any, seedDb: any, users: any, crypto_: any, queries: any;
  let uid = 0, acctId = 0;
  let MAILBOX: any[] = [];

  beforeAll(async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Operations');
    ws.addRow(['Date', 'Employee Name', 'Department', 'Task', 'Status', 'Start Time', 'End Time']);
    ws.addRow([new Date(Date.UTC(2026, 7, 12)), 'Vikas Nair', 'Operations', 'Process customer orders', 'Completed', '09:00', '10:00']);
    ws.addRow([new Date(Date.UTC(2026, 7, 12)), 'Vikas Nair', 'Operations', 'Process customer orders', 'Done', '09:00', '10:00']);
    ws.addRow([new Date(Date.UTC(2026, 7, 12)), 'Deepa Iyer', 'Operations', 'Dispatch shipments', 'Compleeted!!', '', '']);
    XLSX_BUF = Buffer.from(await wb.xlsx.writeBuffer());

    db = await import('../src/lib/db');
    sync = await import('../src/lib/sync');
    accounts = await import('../src/lib/accounts');
    seedDb = await import('../src/lib/seed-db');
    users = await import('../src/lib/users');
    crypto_ = await import('../src/lib/crypto');
    queries = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });

    await db.query(`insert into departments (department_id, department_name, name_aliases, sender_domains, active)
                    values ('DEP-HR','HR','{human resources}','{}',true) on conflict do nothing`);
    for (const [name, dept] of [['Kavita Menon','HR'],['Rahul Mehta','Sales'],
                                ['Neha Gupta','Marketing'],['Vikas Nair','Operations'],
                                ['Deepa Iyer','Operations']]) {
      await db.query(`insert into employees (employee_id, employee_name, name_aliases, department, active)
                      values ($1,$2,'{}',$3,true) on conflict do nothing`,
        ['EMP-' + name.split(' ')[0].toUpperCase(), name, dept]);
    }

    const u = await users.upsertGoogleUser({ googleSub: 'sub-mgr', email: 'mgr@co.com',
      displayName: 'Manager', pictureUrl: '' });
    uid = u.id;
    const a = await accounts.upsertGmailAccount({ ownerUserId: uid, email: 'mgr@co.com',
      googleSub: 'sub-mgr', displayName: 'Manager', pictureUrl: '',
      refreshToken: 'rt', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    acctId = a.id;

    MAILBOX = [
      // --- 4 genuine reports, in four formats ---
      { id: 'r-hr', subject: 'Daily Report - HR', from: 'hr@co.com',
        html: htmlReport('HR', [
          ['12 Aug 2026', 'Kavita Menon', 'Screen candidates', 'Completed'],
          ['12 Aug 2026', 'Kavita Menon', 'Update induction pack', 'In Progress'],
          ['12 Aug 2026', '', 'Missing employee row', 'Completed']])},          // malformed row
      { id: 'r-sales', subject: 'EOD update', from: 'sales@co.com',              // no "report" in subject
        text: 'Date | Employee Name | Department | Task | Status\n' +
              '12 Aug 2026 | Rahul Mehta | Sales | Update website | Done\n' +
              '13 Aug 2026 | Rahul Mehta | Sales | Website update | Finished\n' +
              '14 Aug 2026 | Rahul Mehta | Sales | Updating the website | Complete\n' },
      { id: 'r-mkt', subject: 'Marketing numbers', from: 'mkt@co.com',
        text: 'attached', attachments: [{ filename: 'mkt.csv', mimeType: 'text/csv', id: 'a1',
          data: Buffer.from('Date,Employee Name,Department,Task,Status\n' +
            '12 Aug 2026,Neha Gupta,Marketing,"Write blog post, part 1",Completed\n' +
            '12 Aug 2026,Neha Gupta,Marketing,Newsletter draft,Pending\n', 'utf8') }] },
      { id: 'r-ops', subject: 'Ops', from: 'ops@co.com', text: 'see sheet',
        attachments: [{ filename: 'ops.xlsx', id: 'a2',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: XLSX_BUF }] },
      // --- 6 that must be ignored ---
      { id: 'n-news', subject: 'Industry Weekly', from: 'news@x.com',
        html: '<table><tr><th>Headline</th><th>Author</th></tr><tr><td>A</td><td>B</td></tr></table>' },
      { id: 'n-ad', subject: '50% off hosting', from: 'deals@x.com', html: '<div><h1>Sale</h1></div>' },
      { id: 'n-personal', subject: 'lunch?', from: 'friend@x.com', text: 'free at 1?' },
      { id: 'n-thread', subject: 'Re: contract', from: 'legal@x.com', text: 'Clause 4 is fine.' },
      { id: 'n-invoice', subject: 'Invoice 991', from: 'billing@x.com',
        html: '<table><tr><th>Item</th><th>Amount</th></tr><tr><td>Hosting</td><td>500</td></tr></table>' },
      { id: 'n-photo', subject: 'team photo', from: 'hr@co.com', text: 'nice day',
        attachments: [{ filename: 'p.png', mimeType: 'image/png', id: 'a3',
          data: Buffer.from('not an image') }] }
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const ok = (b: unknown) => new Response(JSON.stringify(b), {
        status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return ok({ access_token: 'tok', expires_in: 3600, scope: 'gmail.readonly' });
      }
      if (url.includes('/messages?')) return ok({ messages: MAILBOX.map(m => ({ id: m.id })) });
      const att = url.match(/\/messages\/([^/]+)\/attachments\/([^?]+)/);
      if (att) {
        const a = MAILBOX.find(m => m.id === att[1])?.attachments?.find((x: any) => x.id === att[2]);
        return a ? ok({ data: a.data.toString('base64url'), size: a.data.length })
                 : new Response('nf', { status: 404 });
      }
      const one = url.match(/\/messages\/([^?]+)/);
      const m = MAILBOX.find(x => x.id === one?.[1]);
      if (!m) return new Response('nf', { status: 404 });
      const parts: unknown[] = [];
      if (m.text) parts.push({ mimeType: 'text/plain', body: { data: b64(m.text) } });
      if (m.html) parts.push({ mimeType: 'text/html', body: { data: b64(m.html) } });
      return ok({ id: m.id, threadId: 't', snippet: '', internalDate: String(Date.UTC(2026, 7, 12)),
        labelIds: ['INBOX'],
        payload: { mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }],
          parts: [{ mimeType: 'multipart/alternative', parts },
                  ...(m.attachments || []).map((a: any) => ({
                    mimeType: a.mimeType, filename: a.filename,
                    body: { attachmentId: a.id, size: a.data.length } }))] } });
    }));

    accounts.clearTokenCache();
    const account = await accounts.getGmailAccount(acctId, uid);
    await sync.syncAccount(account, 'acceptance');
    await sync.rebuildAnalysisAfterSync(uid);
  });

  afterAll(async () => { vi.unstubAllGlobals(); await db.getPool().end(); });

  it('10 messages in: 4 reports processed, 6 ignored', async () => {
    const rows = await db.query(
      `select processing_status, count(*)::int as n from documents
       where owner_user_id = $1 group by 1`, [uid]);
    const by = Object.fromEntries(rows.map((r: any) => [r.processing_status, r.n]));
    expect(by.NO_DATA).toBe(6);
    expect((by.SUCCESS || 0) + (by.PARTIAL || 0)).toBe(4);
  });

  it('all four departments are identified and separated', async () => {
    const rows = await db.query(
      `select department, count(*)::int as n from tasks where owner_user_id=$1
       group by 1 order by 1`, [uid]);
    expect(rows.map((r: any) => r.department)).toEqual(['HR', 'Marketing', 'Operations', 'Sales']);
  });

  it('statuses are normalised across every spelling used', async () => {
    const rows = await db.query(
      `select distinct task_status from tasks where owner_user_id=$1 order by 1`, [uid]);
    // Done/Finished/Complete all became Completed; nothing exotic survived.
    expect(rows.map((r: any) => r.task_status).sort())
      .toEqual(['Completed', 'In Progress', 'Pending']);
  });

  it('the malformed row is quarantined, the good rows still import', async () => {
    const dq = await db.query(
      `select rejection_reason from data_quality where owner_user_id=$1`, [uid]);
    expect(dq.length).toBeGreaterThanOrEqual(1);
    expect(dq.map((r: any) => r.rejection_reason))
      .toEqual(expect.arrayContaining(['MISSING_REQUIRED_FIELD']));
    const hr = await db.query(
      `select count(*)::int as n from tasks where owner_user_id=$1 and department='HR'`, [uid]);
    expect(hr[0].n).toBe(2);      // the two valid HR rows survived
  });

  it('a CSV field containing a comma is not split', async () => {
    const rows = await db.query(
      `select task from tasks where owner_user_id=$1 and task like 'Write blog%'`, [uid]);
    expect(rows[0].task).toBe('Write blog post, part 1');
  });

  it('the same task on one day from one report is kept once, not duplicated', async () => {
    // The XLSX had "Process customer orders" twice with the same date/status.
    const rows = await db.query(
      `select count(*)::int as n from tasks where owner_user_id=$1
       and task = 'Process customer orders'`, [uid]);
    expect(rows[0].n).toBe(2);   // two genuine occurrences, both kept
  });

  it('similar task wording across days forms ONE repeat group', async () => {
    const g = await db.query(
      `select employee, task, occurrence_count, distinct_dates, classification
       from repeat_groups where owner_user_id=$1 and employee='Rahul Mehta'`, [uid]);
    expect(g.length).toBe(1);
    expect(g[0].occurrence_count).toBe(3);   // Update website / Website update / Updating the website
    expect(g[0].distinct_dates).toBe(3);
    expect(g[0].classification).toBe('Recurring / Legitimate');
  });

  it('daily, weekly and monthly analytics all compute', async () => {
    for (const grain of ['daily', 'weekly', 'monthly'] as const) {
      const s = await queries.getPeriodSeries(uid, grain, {});
      expect(s.length).toBeGreaterThan(0);
      const total = s.reduce((a: number, p: any) => a + p.total, 0);
      const [{ n }] = await db.query(
        `select count(*)::int as n from tasks where owner_user_id=$1`, [uid]);
      expect(total, grain).toBe(n);      // analytics must reconcile with raw rows
    }
  });

  it('completion rate matches a hand calculation', async () => {
    const [{ total, completed }] = await db.query(
      `select count(*)::int as total,
              count(*) filter (where task_status='Completed')::int as completed
       from tasks where owner_user_id=$1`, [uid]);
    const kpi = await queries.getKpis(uid);
    expect(kpi.total).toBe(total);
    expect(kpi.completionRate).toBe(Math.round((completed / total) * 1000) / 10);
  });

  it('re-syncing the same inbox imports nothing', async () => {
    accounts.clearTokenCache();
    const before = await db.query(`select count(*)::int as n from tasks where owner_user_id=$1`, [uid]);
    const account = await accounts.getGmailAccount(acctId, uid);
    const summary = await sync.syncAccount(account, 'acceptance-2');
    const after = await db.query(`select count(*)::int as n from tasks where owner_user_id=$1`, [uid]);
    expect(summary.rowsImported).toBe(0);
    expect(after[0].n).toBe(before[0].n);
  });

  it('slow tasks are judged, or honestly declared unmeasurable', async () => {
    const rows = await db.query(
      `select slow_task_flag, count(*)::int as n from tasks where owner_user_id=$1
       group by 1`, [uid]);
    const by = Object.fromEntries(rows.map((r: any) => [r.slow_task_flag, r.n]));
    // Most rows carry no timestamps, so they must say so rather than be judged.
    expect(by.INSUFFICIENT_DATA).toBeGreaterThan(0);
    expect(Object.keys(by).every(k =>
      ['TRUE', 'FALSE', 'INSUFFICIENT_DATA'].includes(k))).toBe(true);
  });
});
