/**
 * When the assistant learns to recognise something new, the mail already in
 * the mailbox has to benefit too.
 *
 * This is what happened in production: a report arrived as a Google Sheets
 * link, was scanned before links were followed, and was recorded as "not a
 * report". Shipping link support could not reach it — the message was marked
 * seen, and seen was for ever. Pressing Sync now scanned zero messages and
 * imported nothing, correctly and uselessly.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;

process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';
process.env.TOKEN_ENCRYPTION_KEY = 'detector-version-key-at-least-32-chars!';
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csec';

const SHEET_ID = '1lwMGOOrgerAeCUDyzoFufWcJg_tNZXiuL7Udh7jhkHA';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const SHEET_CSV = [
  'Date,Day,Project Name,Task Name,Task Status',
  '06-Jul-2026,Monday,AI,Joining and Induction,Completed',
  '07-Jul-2026,Tuesday,AI,LinkedIn automation,In Review',
  ''
].join('\n');

/* eslint-disable @typescript-eslint/no-explicit-any */
d('a smarter detector reconsiders what the old one passed over', () => {
  let db: any, sync: any, accounts: any, seedDb: any, users: any, detect: any;
  let uid = 0, acctId = 0;
  let scannedIds: string[] = [];

  beforeAll(async () => {
    db = await import('../src/lib/db');
    sync = await import('../src/lib/sync');
    accounts = await import('../src/lib/accounts');
    seedDb = await import('../src/lib/seed-db');
    users = await import('../src/lib/users');
    detect = await import('../src/lib/core/detect');
    await resetDatabase(db, seedDb, { demo: false });

    const u = await users.upsertGoogleUser({ googleSub: 'sub-d', email: 'd@co.com',
      displayName: 'D', pictureUrl: '' });
    uid = u.id;
    const a = await accounts.upsertGmailAccount({ ownerUserId: uid, email: 'd@co.com',
      googleSub: 'sub-d', displayName: 'D', pictureUrl: '', refreshToken: 'rt',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    acctId = a.id;

    const MAILBOX = [
      { id: 'linked-report', subject: 'Daily report',
        from: 'Dhrubo Ganguly <g@gmail.com>',
        text: `Please find my daily working report\n\nhttps://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing\n` },
      { id: 'genuine-junk', subject: 'lunch?', from: 'friend@x.com', text: 'free at 1?' }
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      const ok = (b: unknown) => new Response(JSON.stringify(b), {
        status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return ok({ access_token: 'tok', expires_in: 3600, scope: 'gmail.readonly' });
      }
      if (url.includes('docs.google.com')) {
        return new Response(SHEET_CSV,
          { status: 200, headers: { 'content-type': 'text/csv' } });
      }
      if (url.includes('/messages?')) return ok({ messages: MAILBOX.map(m => ({ id: m.id })) });
      const one = url.match(/\/messages\/([^?]+)/);
      const m = MAILBOX.find(x => x.id === one?.[1]);
      if (!m) return new Response('nf', { status: 404 });
      scannedIds.push(m.id);
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
  });

  afterAll(async () => { vi.unstubAllGlobals(); await db.getPool().end(); });

  async function runSync(trigger: string) {
    scannedIds = [];
    accounts.clearTokenCache();
    return sync.syncAccount(await accounts.getGmailAccount(acctId, uid), trigger);
  }

  it('reproduces the production state: judged by an older detector', async () => {
    // Both messages recorded as "not a report" by version 1, exactly as the
    // deployed code did before it could follow links.
    for (const id of ['linked-report', 'genuine-junk']) {
      await db.query(
        `insert into documents (report_id, document_id, source, subject, sender,
           received_at, processing_status, tables_found, rows_extracted, rows_inserted,
           rows_skipped_idempotent, rows_rejected, gmail_account_id, gmail_message_id,
           owner_user_id, detector_version)
         values ($1,$2,'email','old','x@y.com',now(),'NO_DATA',0,0,0,0,0,$3,$4,$5,1)`,
        [`GM-${id}`, `gmail:${id}`, acctId, id, uid]);
    }
    const [{ n }] = await db.query(
      `select count(*)::int as n from documents where owner_user_id = $1
        and processing_status = 'NO_DATA'`, [uid]);
    expect(n).toBe(2);
  });

  it('re-reads them, because this detector is newer than the one that judged them', async () => {
    expect(detect.DETECTOR_VERSION).toBeGreaterThan(1);
    const summary = await runSync('after-upgrade');
    expect(scannedIds.sort()).toEqual(['genuine-junk', 'linked-report']);
    expect(summary.rowsImported).toBe(2);
  });

  it('imports the report the link pointed at', async () => {
    const rows = await db.query(
      `select task, task_status, employee_name from tasks where owner_user_id = $1
       order by task_date`, [uid]);
    expect(rows.map((r: any) => r.task))
      .toEqual(['Joining and Induction', 'LinkedIn automation']);
    expect(rows[1].task_status).toBe('In Progress');       // "In Review"
    expect(rows[0].employee_name).toBe('Dhrubo Ganguly');  // from the sender
  });

  it('stamps its own version, so the next sync leaves them alone', async () => {
    const summary = await runSync('steady-state');
    expect(scannedIds).toEqual([]);          // nothing re-read
    expect(summary.messagesScanned).toBe(0);
    expect(summary.rowsImported).toBe(0);
  });

  it('the message that really is junk stays recorded as junk', async () => {
    const [row] = await db.query(
      `select processing_status, detector_version from documents
        where owner_user_id = $1 and gmail_message_id = 'genuine-junk'`, [uid]);
    expect(row.processing_status).toBe('NO_DATA');
    expect(row.detector_version).toBe(detect.DETECTOR_VERSION);
  });

  it('a message that produced data is never re-read, whatever the version', async () => {
    await db.query(
      `update documents set detector_version = 0
        where owner_user_id = $1 and processing_status <> 'NO_DATA'`, [uid]);
    const summary = await runSync('data-is-final');
    expect(scannedIds).toEqual([]);
    expect(summary.rowsImported).toBe(0);
  });
});
