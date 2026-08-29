/**
 * THE PRODUCT FLOW, end to end.
 *
 * A connected inbox containing a mixture of real reports and ordinary mail is
 * read automatically, and the reports — inline HTML, an XLSX attachment and a
 * CSV attachment — become validated rows in Postgres. Nothing is labelled,
 * forwarded, uploaded or triggered by hand.
 *
 * Gmail and Google OAuth are mocked at the fetch boundary, so every line of our
 * own code runs for real: MIME walking, base64url decoding, attachment
 * download, detection, parsing, validation, deduplication and persistence.
 *
 * Needs TEST_DATABASE_URL; skipped otherwise.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;

process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';
process.env.TOKEN_ENCRYPTION_KEY = 'test-token-encryption-key-32-chars-min';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

/* ------------------------------------------------------------------ */
/* A fake mailbox                                                      */
/* ------------------------------------------------------------------ */
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

const REPORT_HTML =
  '<div dir="ltr"><p>Hi Sir, today\'s report.</p>' +
  '<table border="1"><tr><th>Date</th><th>Employee Name</th><th>Task</th>' +
  '<th>Status</th><th>Link</th></tr>' +
  '<tr><td>29 Aug 2026</td><td>Rahul Mehta</td><td>Update CRM</td><td>Completed</td>' +
  '<td><a href="https://crm.example.com/1">link</a></td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Priya Sharma</td><td>Follow up with Acme</td>' +
  '<td>In Progress</td><td></td></tr>' +
  '<tr><td>29 Aug 2026</td><td>Rohit Verma</td><td>Stock audit</td><td>Compleeted!!</td>' +
  '<td></td></tr></table>' +
  '<table><tr><td>Regards</td><td>Sales</td></tr></table></div>';

const NEWSLETTER_HTML =
  '<div><h1>Industry Weekly</h1><table><tr><th>Headline</th><th>Author</th></tr>' +
  '<tr><td>Markets rally</td><td>A. Writer</td></tr></table></div>';

const CSV_REPORT =
  'Date,Employee Name,Task,Status\n' +
  '29 Aug 2026,Neha Gupta,Write blog post: SEO basics,Done\n' +
  '29 Aug 2026,Arjun Patel,Google Ads campaign optimisation,WIP\n';

let XLSX_BUFFER: Buffer;

async function buildXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Operations');
  ws.addRow(['Date', 'Employee Name', 'Task', 'Status', 'Start Time', 'End Time']);
  ws.addRow([new Date(Date.UTC(2026, 7, 29)), 'Vikas Nair', 'Process customer orders', 'Completed', '08:45', '10:15']);
  ws.addRow([new Date(Date.UTC(2026, 7, 29)), 'Deepa Iyer', 'Prepare daily report', 'Done', '', '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

interface FakeMsg {
  id: string; subject: string; from: string; internalDate: string;
  html?: string; text?: string;
  attachments?: { filename: string; mimeType: string; id: string; data: Buffer }[];
}

let MAILBOX: FakeMsg[] = [];

function messagePayload(m: FakeMsg) {
  const parts: unknown[] = [];
  if (m.text) parts.push({ mimeType: 'text/plain', body: { data: b64(m.text) } });
  if (m.html) parts.push({ mimeType: 'text/html', body: { data: b64(m.html) } });
  const alternative = { mimeType: 'multipart/alternative', parts };
  const top: Record<string, unknown> = {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'Subject', value: m.subject },
      { name: 'From', value: m.from },
      { name: 'To', value: 'manager@company.com' }
    ],
    // Deliberately nested, because real mail is.
    parts: [alternative, ...(m.attachments || []).map(a => ({
      mimeType: a.mimeType, filename: a.filename,
      body: { attachmentId: a.id, size: a.data.length }
    }))]
  };
  return top;
}

function installFetchMock() {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const ok = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' }
    });

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = String(init?.body || '');
      if (body.includes('grant_type=refresh_token')) {
        return ok({ access_token: 'fake-access-token', expires_in: 3600, scope: 'gmail.readonly' });
      }
      return ok({
        access_token: 'fake-access-token', refresh_token: 'fake-refresh-token',
        expires_in: 3600,
        scope: 'openid https://www.googleapis.com/auth/gmail.readonly',
        id_token: 'x.' + Buffer.from(JSON.stringify({
          sub: 'google-sub-1', email: 'manager@company.com', name: 'Manager'
        })).toString('base64url') + '.y'
      });
    }

    if (url.includes('gmail.googleapis.com')) {
      if (init && (init.headers as Record<string, string>)?.authorization !== 'Bearer fake-access-token') {
        return new Response('unauthorised', { status: 401 });
      }
      if (url.includes('/messages?')) {
        return ok({ messages: MAILBOX.map(m => ({ id: m.id })) });
      }
      const att = url.match(/\/messages\/([^/]+)\/attachments\/([^?]+)/);
      if (att) {
        const msg = MAILBOX.find(m => m.id === att[1]);
        const a = msg?.attachments?.find(x => x.id === att[2]);
        if (!a) return new Response('not found', { status: 404 });
        return ok({ data: a.data.toString('base64url'), size: a.data.length });
      }
      const one = url.match(/\/messages\/([^?]+)/);
      if (one) {
        const m = MAILBOX.find(x => x.id === one[1]);
        if (!m) return new Response('not found', { status: 404 });
        return ok({
          id: m.id, threadId: 't-' + m.id, snippet: m.subject,
          internalDate: m.internalDate, labelIds: ['INBOX'], payload: messagePayload(m)
        });
      }
    }
    throw new Error('Unexpected fetch in test: ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/* ------------------------------------------------------------------ */

d('automatic Gmail ingestion', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any, sync: any, accounts: any, seedDb: any, crypto_: any;
  const internalDate = String(Date.UTC(2026, 7, 29, 9, 0, 0));

  beforeAll(async () => {
    XLSX_BUFFER = await buildXlsx();
    db = await import('../src/lib/db');
    sync = await import('../src/lib/sync');
    accounts = await import('../src/lib/accounts');
    seedDb = await import('../src/lib/seed-db');
    crypto_ = await import('../src/lib/crypto');

    await resetDatabase(db, seedDb);
  });

  afterAll(async () => { vi.unstubAllGlobals(); await db.getPool().end(); });

  beforeEach(() => {
    installFetchMock();
    MAILBOX = [
      { id: 'm-report-body', subject: 'Daily Report - Sales',
        from: 'Rahul Mehta <rahul@company.com>', internalDate, html: REPORT_HTML },
      { id: 'm-newsletter', subject: 'Industry Weekly',
        from: 'news@example.com', internalDate, html: NEWSLETTER_HTML },
      { id: 'm-plain-chat', subject: 'lunch?',
        from: 'friend@example.com', internalDate, text: 'are you free at 1' },
      { id: 'm-xlsx', subject: 'Operations report attached',
        from: 'Deepa Iyer <deepa@company.com>', internalDate,
        text: 'Please find attached.',
        attachments: [{ filename: 'ops.xlsx', id: 'att-1',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: XLSX_BUFFER }] },
      { id: 'm-csv', subject: 'Marketing numbers',
        from: 'Neha Gupta <neha@company.com>', internalDate,
        text: 'csv attached',
        attachments: [{ filename: 'marketing.csv', id: 'att-2',
          mimeType: 'text/csv', data: Buffer.from(CSV_REPORT, 'utf8') }] },
      { id: 'm-image', subject: 'team photo', from: 'hr@company.com', internalDate,
        text: 'nice day',
        attachments: [{ filename: 'photo.png', id: 'att-3', mimeType: 'image/png',
          data: Buffer.from('not an image really') }] }
    ];
  });

  async function connectedAccount() {
    const existing = await db.query('select * from gmail_accounts limit 1');
    if (existing.length) return existing[0];
    await db.query(
      `insert into gmail_accounts (email, google_sub, display_name, refresh_token_enc,
         scopes, sync_since, owner_user_id)
       values ($1,$2,$3,$4,$5,$6,1)`,
      ['manager@company.com', 'google-sub-1', 'Manager',
       crypto_.encryptSecret('fake-refresh-token'),
       ['https://www.googleapis.com/auth/gmail.readonly'], '2026-08-01']
    );
    return (await db.query('select * from gmail_accounts limit 1'))[0];
  }

  it('encrypts the refresh token at rest', async () => {
    const row = await connectedAccount();
    expect(String(row.refresh_token_enc)).not.toContain('fake-refresh-token');
    expect(String(row.refresh_token_enc).startsWith('v1.')).toBe(true);
    expect(crypto_.decryptSecret(row.refresh_token_enc)).toBe('fake-refresh-token');
  });

  it('reads the inbox and imports every report, with no user action', async () => {
    const row = await connectedAccount();
    const account = await accounts.getGmailAccount(Number(row.id), 1);
    const summary = await sync.syncAccount(account, 'test');

    expect(summary.status).toBe('OK');
    expect(summary.messagesScanned).toBe(6);
    // body report + xlsx + csv, but NOT the newsletter, chat or photo
    expect(summary.reportsFound).toBe(3);
    // 2 valid from the body (the third has an unmappable status), 2 xlsx, 2 csv
    expect(summary.rowsImported).toBe(6);
    expect(summary.rowsRejected).toBe(1);
  });

  it('routes the unmappable status to Data Quality rather than dropping it', async () => {
    const rows = await db.query(
      `select rejection_reason, raw_row->>'status' as status from data_quality`);
    expect(rows.length).toBe(1);
    expect(rows[0].rejection_reason).toBe('UNKNOWN_STATUS');
    expect(rows[0].status).toBe('Compleeted!!');
  });

  it('records what each message was, so nothing is re-read', async () => {
    const docs = await db.query(
      `select gmail_message_id, source, attachment_name, processing_status, rows_inserted
       from documents order by gmail_message_id`);
    expect(docs.length).toBe(6);
    const byId = Object.fromEntries(docs.map((r: Record<string, unknown>) => [r.gmail_message_id, r]));
    expect(byId['m-newsletter'].processing_status).toBe('NO_DATA');
    expect(byId['m-image'].processing_status).toBe('NO_DATA');
    expect(byId['m-xlsx'].source).toBe('attachment');
    expect(byId['m-xlsx'].attachment_name).toBe('ops.xlsx');
    expect(Number(byId['m-csv'].rows_inserted)).toBe(2);
  });

  it('attributes rows to the right department from the employee master', async () => {
    const rows = await db.query(
      `select department, count(*)::int as n from tasks group by 1 order by 1`);
    expect(rows).toEqual([
      { department: 'Marketing', n: 2 },
      { department: 'Operations', n: 2 },
      { department: 'Sales', n: 2 }
    ]);
  });

  it('derives duration from spreadsheet times, and refuses to invent the rest', async () => {
    const [withTimes] = await db.query(
      `select actual_duration, duration_basis, slow_task_flag from tasks
       where task = 'Process customer orders'`);
    expect(Number(withTimes.actual_duration)).toBe(1.5);
    expect(withTimes.duration_basis).toBe('Derived');
    const [without] = await db.query(
      `select duration_basis, slow_task_flag from tasks where task = 'Update CRM'`);
    expect(without.duration_basis).toBe('Insufficient Data');
    expect(without.slow_task_flag).toBe('INSUFFICIENT_DATA');
  });

  it('IDEMPOTENT: syncing again reads nothing and changes nothing', async () => {
    const row = await connectedAccount();
    const account = await accounts.getGmailAccount(Number(row.id), 1);
    const before = await db.query('select count(*)::int as n from tasks');
    const summary = await sync.syncAccount(account, 'test');
    const after = await db.query('select count(*)::int as n from tasks');

    expect(summary.messagesScanned).toBe(0);   // every message already recorded
    expect(summary.rowsImported).toBe(0);
    expect(after[0].n).toBe(before[0].n);
  });

  it('IDEMPOTENT: a re-sent report under a new message id imports nothing', async () => {
    MAILBOX.push({
      id: 'm-report-resent', subject: 'Fwd: Daily Report - Sales',
      from: 'Assistant <pa@company.com>', internalDate, html: REPORT_HTML
    });
    const row = await connectedAccount();
    const account = await accounts.getGmailAccount(Number(row.id), 1);
    const before = await db.query('select count(*)::int as n from tasks');
    const summary = await sync.syncAccount(account, 'test');
    const after = await db.query('select count(*)::int as n from tasks');

    expect(summary.messagesScanned).toBe(1);
    expect(summary.rowsImported).toBe(0);
    expect(summary.rowsDuplicate).toBe(2);
    expect(after[0].n).toBe(before[0].n);
  });

  it('writes a sync_runs row the dashboard can show', async () => {
    const runs = await db.query(
      `select trigger, status, messages_scanned, reports_found, rows_imported
       from sync_runs order by started_at`);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs[0].status).toBe('OK');
    expect(runs[0].reports_found).toBe(3);
  });

  it('a revoked Google grant surfaces as REAUTH_REQUIRED, not a crash', async () => {
    // A serverless invocation starts with no cached token; mirror that, or the
    // stale token hides the revocation.
    accounts.clearTokenCache();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      throw new Error('should not reach Gmail');
    }));
    const row = await connectedAccount();
    const account = await accounts.getGmailAccount(Number(row.id), 1);
    const summary = await sync.syncAccount(account, 'test');
    expect(summary.status).toBe('REAUTH_REQUIRED');

    const [acct] = await db.query('select last_sync_status from gmail_accounts limit 1');
    expect(acct.last_sync_status).toBe('REAUTH_REQUIRED');
  });

  it('analysis and the dashboard views reflect the imported mail', async () => {
    accounts.clearTokenCache();
    installFetchMock();
    await sync.rebuildAnalysisAfterSync(1);
    const [kpi] = await db.query(
      `select count(*)::int as total,
              count(*) filter (where task_status='Completed')::int as completed
       from tasks`);
    expect(kpi.total).toBe(6);
    expect(kpi.completed).toBeGreaterThan(0);
    const daily = await db.query(
      `select department, total_tasks from daily_summary order by department`);
    expect(daily.find((r: Record<string, unknown>) => r.department === 'ALL')?.total_tasks).toBe(6);
  });
});
