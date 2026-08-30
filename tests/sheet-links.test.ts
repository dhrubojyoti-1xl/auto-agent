/**
 * A report that arrives as a Google Sheets link.
 *
 * This is what a real inbox produced: an email reading "Please find my daily
 * working report" with nothing but a link. No table, no attachment — the
 * assistant scanned it, found nothing, and honestly reported zero reports
 * while the data sat one hop away.
 *
 * The sheet in that email also had no Employee column, because one person's
 * own report does not repeat their name on every line. Both had to be solved
 * for the message to become data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  exportUrlFor, fetchSheet, fetchSheetCsv, findSheetLinks, workbookUrlFor
} from '../src/lib/core/links';
import { senderDisplayName } from '../src/lib/core/ingest';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;

process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';
process.env.TOKEN_ENCRYPTION_KEY = 'sheet-link-test-key-at-least-32-chars!!';
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csec';

const SHEET_ID = '1lwMGOOrgerAeCUDyzoFufWcJg_tNZXiuL7Udh7jhkHA';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

// The real shape: Date, Day, no Employee, Task Name, Task Status.
const SHEET_CSV = [
  'Date,Day,Project Name,Task Name,Task Status,Detailed Description,Link 1',
  '06-Jul-2026,Monday,AI,Joining and Induction,Completed,,',
  '07-Jul-2026,Tuesday,AI,LinkedIn automation,Completed,"Built and configured outreach, then tested it",https://drive.google.com/x',
  '08-Jul-2026,Wednesday,AI,Creating Training Modules,Ongoing,Began drafting modules,',
  ''
].join('\n');

describe('finding a sheet link in a message', () => {
  it('finds the link whether it is an href or bare text', () => {
    const href = `<p>Report: <a href="https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing">here</a></p>`;
    const bare = `Please find my report\n\nhttps://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing\n`;
    expect(findSheetLinks(href, '')[0].id).toBe(SHEET_ID);
    expect(findSheetLinks('', bare)[0].id).toBe(SHEET_ID);
  });

  it('does not report the same sheet twice when both parts carry it', () => {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
    expect(findSheetLinks(`<a href="${url}">x</a>`, url)).toHaveLength(1);
  });

  it('keeps the tab when the link names one', () => {
    const links = findSheetLinks('', `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=87654321`);
    expect(links[0].gid).toBe('87654321');
    expect(links[0].exportUrl).toContain('gid=87654321');
  });

  it('ignores links that are not Google Sheets', () => {
    expect(findSheetLinks('', 'https://docs.google.com/document/d/abc123def456ghi789jkl/edit')).toHaveLength(0);
    expect(findSheetLinks('', 'https://example.com/report.xlsx')).toHaveLength(0);
  });

  it('builds the export URL that needs no Google permission', () => {
    expect(exportUrlFor(SHEET_ID))
      .toBe(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`);
  });
});

describe('opening a sheet that is not shared', () => {
  afterAll(() => vi.unstubAllGlobals());

  it('reads a shared sheet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SHEET_CSV, {
      status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } })));
    const got = await fetchSheetCsv(findSheetLinks('', `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`)[0]);
    expect(got.ok).toBe(true);
    if (got.ok && got.kind === 'csv') expect(got.csv).toContain('Joining and Induction');
  });

  it('says the sheet is not shared, and how to fix it', async () => {
    // Google answers a restricted file with 200 and a sign-in page, not a 403.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Sign in</html>', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })));
    const got = await fetchSheetCsv(findSheetLinks('', `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`)[0]);
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe('NOT_SHARED');
      expect(got.detail).toMatch(/Anyone with the link/);
    }
  });

  it('gives up rather than hanging', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort',
          () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })));
    const got = await fetchSheetCsv(
      findSheetLinks('', `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`)[0],
      { timeoutMs: 30 });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.detail).toMatch(/Timed out/);
  });
});

describe('who wrote a report with no employee column', () => {
  it('reads the person out of a From header', () => {
    expect(senderDisplayName('Dhrubo Ganguly <gangulydhrubo@gmail.com>')).toBe('Dhrubo Ganguly');
    expect(senderDisplayName('"Menon, Kavita" <k@co.com>')).toBe('Menon, Kavita');
  });

  it('falls back to the address when there is no display name', () => {
    expect(senderDisplayName('rahul.mehta@co.com')).toBe('Rahul Mehta');
    expect(senderDisplayName('<neha_gupta99@co.com>')).toBe('Neha Gupta');
  });

  it('returns nothing for nothing', () => {
    expect(senderDisplayName('')).toBe('');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
d('the whole message, end to end', () => {
  let db: any, sync: any, accounts: any, seedDb: any, users: any;
  let uid = 0, acctId = 0;
  let sheetResponse: () => Response;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    sync = await import('../src/lib/sync');
    accounts = await import('../src/lib/accounts');
    seedDb = await import('../src/lib/seed-db');
    users = await import('../src/lib/users');
    await resetDatabase(db, seedDb, { demo: false });

    const u = await users.upsertGoogleUser({ googleSub: 'sub-s', email: 's@co.com',
      displayName: 'S', pictureUrl: '' });
    uid = u.id;
    const a = await accounts.upsertGmailAccount({ ownerUserId: uid, email: 's@co.com',
      googleSub: 'sub-s', displayName: 'S', pictureUrl: '', refreshToken: 'rt',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    acctId = a.id;

    sheetResponse = () => new Response(SHEET_CSV, {
      status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } });

    const MAILBOX = [
      { id: 'sheet-mail', subject: 'Daily report Dhrubojyoti ai',
        from: 'Dhrubo Ganguly <gangulydhrubo@gmail.com>',
        text: 'Dear Sir,\n\nPlease find my daily working report\n\n' +
              `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing\n\n` +
              'Regards,\n\nDhrubo.' },
      { id: 'private-sheet', subject: 'my report',
        from: 'Someone Else <else@co.com>',
        text: 'https://docs.google.com/spreadsheets/d/PRIVATEsheetIDxxxxxxxxxxxx/edit' }
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      const ok = (b: unknown) => new Response(JSON.stringify(b), {
        status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return ok({ access_token: 'tok', expires_in: 3600, scope: 'gmail.readonly' });
      }
      if (url.includes('docs.google.com')) {
        return url.includes('PRIVATE')
          ? new Response('<html>Sign in</html>',
              { status: 200, headers: { 'content-type': 'text/html' } })
          : sheetResponse();
      }
      if (url.includes('/messages?')) return ok({ messages: MAILBOX.map(m => ({ id: m.id })) });
      const one = url.match(/\/messages\/([^?]+)/);
      const m = MAILBOX.find(x => x.id === one?.[1]);
      if (!m) return new Response('nf', { status: 404 });
      return ok({
        id: m.id, threadId: 't', snippet: '', internalDate: String(Date.UTC(2026, 7, 30)),
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }],
          parts: [{ mimeType: 'text/plain', body: { data: b64(m.text) } }]
        }
      });
    }));

    accounts.clearTokenCache();
    await sync.syncAccount(await accounts.getGmailAccount(acctId, uid), 'sheet-test');
  });

  afterAll(async () => { vi.unstubAllGlobals(); await db.getPool().end(); });

  it('imports the sheet the email only linked to', async () => {
    const rows = await db.query(
      `select task, task_status, task_date, employee_name from tasks
       where owner_user_id = $1 order by task_date`, [uid]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r: any) => r.task)).toEqual(
      ['Joining and Induction', 'LinkedIn automation', 'Creating Training Modules']);
  });

  it('attributes the rows to the sender, since the sheet names no employee', async () => {
    const rows = await db.query(
      `select distinct employee_name from tasks where owner_user_id = $1`, [uid]);
    expect(rows.map((r: any) => r.employee_name)).toEqual(['Dhrubo Ganguly']);
  });

  it('reads the date column, not the weekday column beside it', async () => {
    const rows = await db.query(
      `select min(task_date) as a, max(task_date) as b from tasks where owner_user_id = $1`, [uid]);
    expect(String(rows[0].a)).toContain('2026-07-06');
    expect(String(rows[0].b)).toContain('2026-07-08');
  });

  it('normalises the statuses this sheet actually uses', async () => {
    const rows = await db.query(
      `select task_status, count(*)::int as n from tasks where owner_user_id = $1
       group by 1 order by 1`, [uid]);
    expect(Object.fromEntries(rows.map((r: any) => [r.task_status, r.n])))
      .toEqual({ Completed: 2, 'In Progress': 1 });     // "Ongoing" -> In Progress
  });

  it('keeps a description containing a comma in one field', async () => {
    const [row] = await db.query(
      `select task from tasks where owner_user_id = $1 and task like 'LinkedIn%'`, [uid]);
    expect(row.task).toBe('LinkedIn automation');
  });

  it('reports the sheet it could not open, by name and with the fix', async () => {
    const rows = await db.query(
      `select rejection_reason, rejection_detail from data_quality
       where owner_user_id = $1 and rejection_reason like 'SHEET%'`, [uid]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rejection_reason).toBe('SHEET_NOT_SHARED');
    expect(rows[0].rejection_detail).toMatch(/Anyone with the link/);
  });

  it('does not import the same sheet again on the next sync', async () => {
    accounts.clearTokenCache();
    const summary = await sync.syncAccount(
      await accounts.getGmailAccount(acctId, uid), 'sheet-test-2');
    expect(summary.rowsImported).toBe(0);
    const [{ n }] = await db.query(
      `select count(*)::int as n from tasks where owner_user_id = $1`, [uid]);
    expect(n).toBe(3);
  });
});

describe('statuses this team actually writes', () => {
  it('recognises work that is finished but not yet approved', async () => {
    const { seedMasters } = await import('../src/lib/seed');
    const { normalizeStatus } = await import('../src/lib/core/normalize');
    const masters = seedMasters([]);
    // Six rows of a real report were rejected for exactly this word.
    for (const s of ['In Review', 'in review', 'UNDER REVIEW', 'Reviewing',
                     'For Review', 'In Testing', 'In QA']) {
      expect(normalizeStatus(s, masters), s).toBe('In Progress');
    }
  });

  it('still refuses a status nobody has defined', async () => {
    const { seedMasters } = await import('../src/lib/seed');
    const { normalizeStatus } = await import('../src/lib/core/normalize');
    const masters = seedMasters([]);
    // Adding aliases must not turn the mapper into a guesser.
    for (const s of ['Compleeted!!', 'Frobnicated', 'maybe?']) {
      expect(normalizeStatus(s, masters), s).toBeNull();
    }
  });
});

describe('a sheet with more than one tab', () => {
  const link = findSheetLinks('', `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`)[0];

  afterAll(() => vi.unstubAllGlobals());

  it('asks for the whole workbook, not just the first tab', () => {
    expect(workbookUrlFor(SHEET_ID)).toContain('format=xlsx');
  });

  it('reads every worksheet a team keeps', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    for (const dept of ['Sales', 'Marketing']) {
      const ws = wb.addWorksheet(dept);
      ws.addRow(['Date', 'Employee Name', 'Department', 'Task', 'Status']);
      ws.addRow(['12 Aug 2026', `${dept} Person`, dept, `${dept} work`, 'Completed']);
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    vi.stubGlobal('fetch', vi.fn(async (u: string | URL | Request) =>
      String(u).includes('format=xlsx')
        ? new Response(buf, { status: 200, headers: {
            'content-type':
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })
        : new Response('not used', { status: 200, headers: { 'content-type': 'text/csv' } })));

    const got = await fetchSheet(link);
    expect(got.ok).toBe(true);
    if (!got.ok || got.kind !== 'workbook') throw new Error('expected a workbook');

    const { attachmentToTables } = await import('../src/lib/core/attachments');
    const tables = await attachmentToTables('sheet.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', got.workbook);
    expect(tables).toHaveLength(2);        // both tabs, not just the first
  });

  it('falls back to the single-tab CSV when the workbook cannot be had', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string | URL | Request) =>
      String(u).includes('format=xlsx')
        ? new Response('<html>Sign in</html>',
            { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response(SHEET_CSV,
            { status: 200, headers: { 'content-type': 'text/csv' } })));

    const got = await fetchSheet(link);
    expect(got.ok).toBe(true);
    if (got.ok && got.kind === 'csv') expect(got.csv).toContain('Joining and Induction');
  });

  it('honours a link that names one tab, rather than taking the workbook', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string | URL | Request) => {
      calls.push(String(u));
      return new Response(SHEET_CSV,
        { status: 200, headers: { 'content-type': 'text/csv' } });
    }));
    const tabbed = findSheetLinks('',
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=555`)[0];
    await fetchSheet(tabbed);
    expect(calls.some(c => c.includes('format=xlsx'))).toBe(false);
    expect(calls.some(c => c.includes('gid=555'))).toBe(true);
  });

  it('reports a sheet that is shared with nobody, whichever export is tried', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Sign in</html>',
      { status: 200, headers: { 'content-type': 'text/html' } })));
    const got = await fetchSheet(link);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('NOT_SHARED');
  });
});
