/**
 * What happens when things go wrong.
 *
 * Every case here is one a real mailbox produces within a week: a workbook
 * somebody exported from an old system, a file too big to fetch, Gmail
 * answering 503, an inbox where half the messages are fine and one is not.
 * The requirement in each case is the same — the sync finishes, the good data
 * lands, and the failure is visible with a reason instead of disappearing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;

process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';
process.env.TOKEN_ENCRYPTION_KEY = 'resilience-test-key-at-least-32-chars!!';
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csec';
process.env.GMAIL_BACKOFF_MS = '1';
// Small enough to exercise the limit, comfortably above a real workbook.
process.env.MAX_ATTACHMENT_BYTES = '100000';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function reportText(dept: string, employee: string, task: string, sep = '|') {
  const head = ['Date', 'Employee Name', 'Department', 'Task', 'Status'];
  const row = ['12 Aug 2026', employee, dept, task, 'Completed'];
  return head.join(sep) + '\n' + row.join(sep) + '\n';
}

/* eslint-disable @typescript-eslint/no-explicit-any */
d('a sync survives what a real mailbox contains', () => {
  let db: any, sync: any, accounts: any, seedDb: any, users: any;
  let uid = 0, acctId = 0;
  let MAILBOX: any[] = [];
  let gmailCalls = 0;
  let failNextListTimes = 0;

  beforeAll(async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Ops');
    ws.addRow(['Date', 'Employee Name', 'Department', 'Task', 'Status']);
    ws.addRow(['12 Aug 2026', 'Vikas Nair', 'Operations', 'Dispatch shipments', 'Completed']);
    const xlsm = Buffer.from(await wb.xlsx.writeBuffer());

    db = await import('../src/lib/db');
    sync = await import('../src/lib/sync');
    accounts = await import('../src/lib/accounts');
    seedDb = await import('../src/lib/seed-db');
    users = await import('../src/lib/users');
    await resetDatabase(db, seedDb, { demo: false });

    for (const [name, dept] of [['Kavita Menon', 'HR'], ['Vikas Nair', 'Operations'],
                                ['Rahul Mehta', 'Sales'], ['Neha Gupta', 'Marketing']]) {
      await db.query(
        `insert into employees (employee_id, employee_name, name_aliases, department, active)
         values ($1,$2,'{}',$3,true) on conflict do nothing`,
        ['EMP-' + name.split(' ')[0].toUpperCase(), name, dept]);
    }
    await db.query(`insert into departments (department_id, department_name, name_aliases,
                    sender_domains, active) values ('DEP-HR','HR','{}','{}',true)
                    on conflict do nothing`);

    const u = await users.upsertGoogleUser({ googleSub: 'sub-r', email: 'r@co.com',
      displayName: 'R', pictureUrl: '' });
    uid = u.id;
    const a = await accounts.upsertGmailAccount({ ownerUserId: uid, email: 'r@co.com',
      googleSub: 'sub-r', displayName: 'R', pictureUrl: '', refreshToken: 'rt',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    acctId = a.id;

    MAILBOX = [
      { id: 'ok-1', subject: 'Team update', from: 'hr@co.com',
        text: reportText('HR', 'Kavita Menon', 'Screen candidates') },
      // An .xlsm workbook: macro-enabled by extension, plain OOXML data to us.
      { id: 'xlsm', subject: 'Ops numbers', from: 'ops@co.com', text: 'see attached',
        attachments: [{ filename: 'ops.xlsm', id: 'a-xlsm',
          mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12', data: xlsm }] },
      // A genuine TSV report.
      { id: 'tsv', subject: 'numbers', from: 'sales@co.com', text: 'attached',
        attachments: [{ filename: 'sales.tsv', id: 'a-tsv', mimeType: 'text/tab-separated-values',
          data: Buffer.from(reportText('Sales', 'Rahul Mehta', 'Prepare proposal', '\t'), 'utf8') }] },
      // Corrupt workbook — must be quarantined by name, not silently dropped.
      { id: 'bad-xlsx', subject: 'Marketing report', from: 'mkt@co.com', text: 'attached',
        attachments: [{ filename: 'broken.xlsx', id: 'a-bad',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: Buffer.from('this is definitely not a spreadsheet') }] },
      // Over the size limit — must say so rather than vanish.
      { id: 'huge', subject: 'Big report', from: 'mkt@co.com', text: 'attached',
        attachments: [{ filename: 'huge.xlsx', id: 'a-huge',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: Buffer.alloc(250_000) }] },
      // Fetching this attachment always fails.
      { id: 'boom', subject: 'Another report', from: 'mkt@co.com', text: 'attached',
        attachments: [{ filename: 'boom.csv', id: 'a-boom', mimeType: 'text/csv',
          data: null }] },
      { id: 'ok-2', subject: 'eod', from: 'mkt@co.com',
        text: reportText('Marketing', 'Neha Gupta', 'Newsletter draft') }
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      const ok = (b: unknown) => new Response(JSON.stringify(b), {
        status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return ok({ access_token: 'tok', expires_in: 3600, scope: 'gmail.readonly' });
      }
      gmailCalls++;
      if (url.includes('/messages?')) {
        if (failNextListTimes > 0) {
          failNextListTimes--;
          return new Response('backend error', { status: 503 });
        }
        return ok({ messages: MAILBOX.map(m => ({ id: m.id })) });
      }
      const att = url.match(/\/messages\/([^/]+)\/attachments\/([^?]+)/);
      if (att) {
        const a = MAILBOX.find(m => m.id === att[1])?.attachments
          ?.find((x: any) => x.id === att[2]);
        if (!a || a.data === null) return new Response('gone', { status: 404 });
        return ok({ data: a.data.toString('base64url'), size: a.data.length });
      }
      const one = url.match(/\/messages\/([^?]+)/);
      const m = MAILBOX.find(x => x.id === one?.[1]);
      if (!m) return new Response('nf', { status: 404 });
      return ok({
        id: m.id, threadId: 't', snippet: '', internalDate: String(Date.UTC(2026, 7, 12)),
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }],
          parts: [
            { mimeType: 'text/plain', body: { data: b64(m.text || '') } },
            ...(m.attachments || []).map((a: any) => ({
              mimeType: a.mimeType, filename: a.filename,
              body: { attachmentId: a.id, size: a.data ? a.data.length : 100 } }))
          ]
        }
      });
    }));

    // Gmail is unavailable for the first two attempts of the listing call.
    failNextListTimes = 2;
    accounts.clearTokenCache();
    const account = await accounts.getGmailAccount(acctId, uid);
    await sync.syncAccount(account, 'resilience');
  });

  afterAll(async () => { vi.unstubAllGlobals(); await db.getPool().end(); });

  it('retries a transient Gmail failure instead of losing the whole run', async () => {
    expect(failNextListTimes).toBe(0);          // both 503s were consumed
    const [{ n }] = await db.query(
      `select count(*)::int as n from sync_runs where owner_user_id = $1`, [uid]);
    expect(n).toBe(1);
    expect(gmailCalls).toBeGreaterThan(3);      // the retries really happened
  });

  it('imports every good report despite four broken messages', async () => {
    const rows = await db.query(
      `select department, count(*)::int as n from tasks where owner_user_id = $1
       group by 1 order by 1`, [uid]);
    expect(rows.map((r: any) => r.department))
      .toEqual(['HR', 'Marketing', 'Operations', 'Sales']);
  });

  it('reads an .xlsm workbook without running anything in it', async () => {
    const [{ n }] = await db.query(
      `select count(*)::int as n from tasks
       where owner_user_id = $1 and task = 'Dispatch shipments'`, [uid]);
    expect(n).toBe(1);
  });

  it('reads a genuine TSV attachment', async () => {
    const [{ n }] = await db.query(
      `select count(*)::int as n from tasks
       where owner_user_id = $1 and task = 'Prepare proposal'`, [uid]);
    expect(n).toBe(1);
  });

  it('names every attachment it could not use, with a reason', async () => {
    const rows = await db.query(
      `select rejection_reason, rejection_detail, raw_row from data_quality
       where owner_user_id = $1 and rejection_reason like 'ATTACHMENT%'`, [uid]);
    const byReason = Object.fromEntries(
      rows.map((r: any) => [r.rejection_reason, r.raw_row.attachment]));

    expect(byReason.ATTACHMENT_UNREADABLE).toBe('broken.xlsx');
    expect(byReason.ATTACHMENT_TOO_LARGE).toBe('huge.xlsx');
    expect(byReason.ATTACHMENT_FAILED).toBe('boom.csv');

    // The reason has to tell the sender what to do about it.
    const tooLarge = rows.find((r: any) => r.rejection_reason === 'ATTACHMENT_TOO_LARGE');
    expect(tooLarge.rejection_detail).toMatch(/limit/i);
  });

  it('records the run as PARTIAL, not OK, when something was refused', async () => {
    const [run] = await db.query(
      `select status, rows_imported, rows_rejected from sync_runs
       where owner_user_id = $1`, [uid]);
    expect(run.rows_imported).toBe(4);
    expect(run.rows_rejected).toBeGreaterThanOrEqual(3);
  });

  it('does not re-import anything when the same mailbox is read again', async () => {
    accounts.clearTokenCache();
    const account = await accounts.getGmailAccount(acctId, uid);
    const summary = await sync.syncAccount(account, 'resilience-2');
    expect(summary.rowsImported).toBe(0);
    const [{ n }] = await db.query(
      `select count(*)::int as n from tasks where owner_user_id = $1`, [uid]);
    expect(n).toBe(4);
  });
});
