/**
 * Every message ends with a decision a person can read.
 *
 * "Scanned 2 messages, found 0 reports" is true and tells a manager nothing.
 * The three outcomes that matter are processed, decided against, and could not
 * be finished — and only the last needs anyone's attention. A message that
 * carried a PDF report and one that carried a newsletter must not look the
 * same afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;

process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';
process.env.TOKEN_ENCRYPTION_KEY = 'classification-key-at-least-32-chars!!!';
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csec';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/* eslint-disable @typescript-eslint/no-explicit-any */
d('what happened to each message', () => {
  let db: any, sync: any, accounts: any, seedDb: any, users: any, queries: any;
  let uid = 0, acctId = 0;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    sync = await import('../src/lib/sync');
    accounts = await import('../src/lib/accounts');
    seedDb = await import('../src/lib/seed-db');
    users = await import('../src/lib/users');
    queries = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });

    const u = await users.upsertGoogleUser({ googleSub: 'sub-c', email: 'c@co.com',
      displayName: 'C', pictureUrl: '' });
    uid = u.id;
    const a = await accounts.upsertGmailAccount({ ownerUserId: uid, email: 'c@co.com',
      googleSub: 'sub-c', displayName: 'C', pictureUrl: '', refreshToken: 'rt',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    acctId = a.id;

    const MAILBOX = [
      // A real report, in wording nobody configured.
      { id: 'good', subject: 'FYI', from: 'Priya Sharma <p@co.com>',
        text: 'Reporting Dt|Staff Member|Division|Work Done Today|Current State\n' +
              '12 Aug 2026|Priya Sharma|Sales|Call the client|Completed\n' },
      // A newsletter with a table: decided against, finished with.
      { id: 'news', subject: 'Industry Weekly', from: 'news@x.com',
        html: '<table><tr><th>Headline</th><th>Author</th></tr><tr><td>A</td><td>B</td></tr></table>' },
      // A PDF report: unreadable format, and it must say so.
      { id: 'pdf', subject: 'Daily Report', from: 'ops@co.com', text: 'attached',
        attachments: [{ filename: 'Daily Report.pdf', id: 'a-pdf',
          mimeType: 'application/pdf', size: 90_000 }] },
      // A screenshot of a table: needs a person, not a guess from pixels.
      { id: 'shot', subject: 'todays work', from: 'hr@co.com', text: 'see image',
        attachments: [{ filename: 'report.png', id: 'a-png',
          mimeType: 'image/png', size: 250_000 }] },
      // A signature logo: genuinely not a report, and not worth mentioning.
      { id: 'logo', subject: 'thanks', from: 'friend@x.com', text: 'cheers',
        attachments: [{ filename: 'logo.png', id: 'a-logo',
          mimeType: 'image/png', size: 3_000 }] }
    ];

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      const ok = (b: unknown) => new Response(JSON.stringify(b), {
        status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return ok({ access_token: 'tok', expires_in: 3600, scope: 'gmail.readonly' });
      }
      if (url.includes('/messages?')) return ok({ messages: MAILBOX.map(m => ({ id: m.id })) });
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
    await sync.syncAccount(await accounts.getGmailAccount(acctId, uid), 'classify');
  });

  afterAll(async () => { vi.unstubAllGlobals(); await db.getPool().end(); });

  it('reads a report whose every column name is unconfigured wording', async () => {
    const rows = await db.query(
      `select employee_name, department, task, task_status from tasks
       where owner_user_id = $1`, [uid]);
    expect(rows).toHaveLength(1);
    expect(rows[0].employee_name).toBe('Priya Sharma');
    expect(rows[0].department).toBe('Sales');
    expect(rows[0].task).toBe('Call the client');
    expect(rows[0].task_status).toBe('Completed');
  });

  it('gives every message a classification', async () => {
    const rows = await db.query(
      `select gmail_message_id, classification from documents
       where owner_user_id = $1 order by gmail_message_id`, [uid]);
    const by = Object.fromEntries(rows.map((r: any) => [r.gmail_message_id, r.classification]));
    expect(by.good).toBe('DEPARTMENTAL_REPORT');
    expect(by.news).toBe('NON_REPORT');
    expect(by.pdf).toBe('UNSUPPORTED_FORMAT');
    expect(by.shot).toBe('REVIEW_REQUIRED');
    expect(by.logo).toBe('NON_REPORT');       // a small logo is not a report
  });

  it('tells the manager what to do about the PDF', async () => {
    const [row] = await db.query(
      `select evidence from documents where owner_user_id = $1
         and gmail_message_id = 'pdf'`, [uid]);
    expect(row.evidence).toMatch(/\.xlsx|spreadsheet/i);
  });

  it('does not pretend it can read a screenshot', async () => {
    const [row] = await db.query(
      `select evidence from documents where owner_user_id = $1
         and gmail_message_id = 'shot'`, [uid]);
    expect(row.evidence).toMatch(/screenshot/i);
    expect(row.evidence).not.toMatch(/no report table/i);
  });

  it('separates what needs a person from what was decided', async () => {
    const outcomes = await queries.getMessageOutcomes(uid, 50);
    const review = outcomes.filter((o: any) =>
      ['REVIEW_REQUIRED', 'UNSUPPORTED_FORMAT', 'POSSIBLE_REPORT'].includes(o.classification));
    expect(review.map((o: any) => o.subject).sort())
      .toEqual(['Daily Report', 'todays work']);
    // The processed report is not in this list at all.
    expect(outcomes.some((o: any) => o.classification === 'DEPARTMENTAL_REPORT')).toBe(false);
  });

  it('says nothing about a signature logo', async () => {
    const rows = await db.query(
      `select rejection_reason from data_quality where owner_user_id = $1
         and document_id like '%logo.png%'`, [uid]);
    expect(rows).toHaveLength(0);
  });

  it('every message has an outcome — none was silently dropped', async () => {
    const [{ n }] = await db.query(
      `select count(*)::int as n from documents where owner_user_id = $1
         and classification is not null`, [uid]);
    expect(n).toBe(5);
  });
});
