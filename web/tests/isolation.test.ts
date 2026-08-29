/**
 * PHASE 30 — multi-user isolation, and PHASE 6/29 — a realistic mixed inbox
 * across four departments.
 *
 * Two managers connect their own mailboxes. Neither may see the other's
 * reports, tasks, dashboard numbers or Gmail connection — and crucially, the
 * same report existing in both mailboxes is two independent facts, not a
 * duplicate.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;

process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';
process.env.TOKEN_ENCRYPTION_KEY = 'isolation-test-key-at-least-32-chars-long';
process.env.GOOGLE_CLIENT_ID = 'cid';
process.env.GOOGLE_CLIENT_SECRET = 'csec';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function reportHtml(dept: string, rows: [string, string, string][]) {
  return `<div><p>${dept} report</p><table>` +
    '<tr><th>Date</th><th>Employee Name</th><th>Task</th><th>Status</th></tr>' +
    rows.map(([emp, task, status]) =>
      `<tr><td>29 Aug 2026</td><td>${emp}</td><td>${task}</td><td>${status}</td></tr>`).join('') +
    '</table></div>';
}

/** Four departments, as the spec requires. */
const DEPT_REPORTS: Record<string, [string, string, string][]> = {
  HR: [['Kavita Menon', 'Screen candidates for ops role', 'Completed'],
       ['Kavita Menon', 'Update induction pack', 'In Progress']],
  Sales: [['Rahul Mehta', 'Update CRM', 'Completed'],
          ['Priya Sharma', 'Follow up with Acme', 'Pending']],
  Marketing: [['Neha Gupta', 'Write blog post', 'Done']],
  Operations: [['Vikas Nair', 'Process customer orders', 'Completed']]
};

/** 10 messages: 4 reports, 6 that must be ignored. */
function buildMailbox(prefix: string) {
  const msgs: { id: string; subject: string; from: string; html?: string; text?: string }[] = [];
  Object.entries(DEPT_REPORTS).forEach(([dept, rows]) => {
    msgs.push({
      id: `${prefix}-rep-${dept}`, subject: `Daily Report - ${dept}`,
      from: `${dept.toLowerCase()}@company.com`, html: reportHtml(dept, rows)
    });
  });
  msgs.push(
    { id: `${prefix}-news`, subject: 'Industry Weekly',
      from: 'news@example.com',
      html: '<table><tr><th>Headline</th><th>Author</th></tr><tr><td>X</td><td>Y</td></tr></table>' },
    { id: `${prefix}-ad`, subject: '50% off hosting!', from: 'deals@example.com',
      html: '<div><h1>Sale</h1><p>Buy now</p></div>' },
    { id: `${prefix}-personal`, subject: 'lunch tomorrow?',
      from: 'friend@example.com', text: 'are you free at 1' },
    { id: `${prefix}-thread`, subject: 'Re: contract wording',
      from: 'legal@example.com', text: 'Clause 4 looks fine to me.' },
    { id: `${prefix}-invoice`, subject: 'Invoice 4471', from: 'billing@example.com',
      html: '<table><tr><th>Item</th><th>Amount</th></tr><tr><td>Hosting</td><td>500</td></tr></table>' },
    { id: `${prefix}-photo`, subject: 'team photo', from: 'hr@company.com',
      text: 'nice day out' }
  );
  return msgs;
}

const MAILBOXES: Record<string, ReturnType<typeof buildMailbox>> = {
  'alice-token': buildMailbox('a'),
  'bob-token': buildMailbox('b')
};

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const ok = (b: unknown) => new Response(JSON.stringify(b), {
      status: 200, headers: { 'content-type': 'application/json' } });

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = String(init?.body || '');
      const who = body.includes('alice') ? 'alice' : 'bob';
      return ok({ access_token: `${who}-access`, expires_in: 3600, scope: 'gmail.readonly' });
    }
    if (url.includes('gmail.googleapis.com')) {
      const auth = (init?.headers as Record<string, string>)?.authorization || '';
      const who = auth.includes('alice') ? 'alice-token' : 'bob-token';
      const box = MAILBOXES[who];
      if (url.includes('/messages?')) return ok({ messages: box.map(m => ({ id: m.id })) });
      const one = url.match(/\/messages\/([^?]+)/);
      const m = box.find(x => x.id === one?.[1]);
      if (!m) return new Response('nf', { status: 404 });
      const parts: unknown[] = [];
      if (m.text) parts.push({ mimeType: 'text/plain', body: { data: b64(m.text) } });
      if (m.html) parts.push({ mimeType: 'text/html', body: { data: b64(m.html) } });
      return ok({
        id: m.id, threadId: 't', snippet: '', internalDate: String(Date.UTC(2026, 7, 29, 9)),
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/alternative',
          headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }],
          parts
        }
      });
    }
    throw new Error('unexpected fetch ' + url);
  }));
}

d('multi-user isolation and a mixed four-department inbox', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, sync: any, accounts: any, seedDb: any, users: any, crypto_: any, queries: any;
  let alice = 0, bob = 0, aliceAcct = 0, bobAcct = 0;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    sync = await import('../src/lib/sync');
    accounts = await import('../src/lib/accounts');
    seedDb = await import('../src/lib/seed-db');
    users = await import('../src/lib/users');
    crypto_ = await import('../src/lib/crypto');
    queries = await import('../src/lib/queries');
    await resetDatabase(db, seedDb, { demo: false });

    // HR is not in the seeded department list; add it, as an admin would.
    await db.query(
      `insert into departments (department_id, department_name, name_aliases, sender_domains, active)
       values ('DEP-04','HR','{human resources,people}','{}',true)
       on conflict do nothing`);
    for (const [name, dept] of [
      ['Kavita Menon', 'HR'], ['Rahul Mehta', 'Sales'], ['Priya Sharma', 'Sales'],
      ['Neha Gupta', 'Marketing'], ['Vikas Nair', 'Operations']
    ]) {
      await db.query(
        `insert into employees (employee_id, employee_name, name_aliases, department, active)
         values ($1,$2,'{}',$3,true) on conflict do nothing`,
        ['EMP-' + name.split(' ')[0].toUpperCase(), name, dept]);
    }

    const a = await users.upsertGoogleUser({
      googleSub: 'sub-alice', email: 'alice@company.com',
      displayName: 'Alice', pictureUrl: '' });
    const b = await users.upsertGoogleUser({
      googleSub: 'sub-bob', email: 'bob@other.com',
      displayName: 'Bob', pictureUrl: '' });
    alice = a.id; bob = b.id;
    expect(alice).not.toBe(bob);

    const acctA = await accounts.upsertGmailAccount({
      ownerUserId: alice, email: 'alice@company.com', googleSub: 'sub-alice',
      displayName: 'Alice', pictureUrl: '', refreshToken: 'alice-refresh',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    const acctB = await accounts.upsertGmailAccount({
      ownerUserId: bob, email: 'bob@other.com', googleSub: 'sub-bob',
      displayName: 'Bob', pictureUrl: '', refreshToken: 'bob-refresh',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    aliceAcct = acctA.id; bobAcct = acctB.id;
    // Make the mocked token endpoint able to tell them apart.
    await db.query(`update gmail_accounts set refresh_token_enc = $2 where id = $1`,
      [aliceAcct, crypto_.encryptSecret('alice-refresh')]);
    await db.query(`update gmail_accounts set refresh_token_enc = $2 where id = $1`,
      [bobAcct, crypto_.encryptSecret('bob-refresh')]);

    installFetch();
    accounts.clearTokenCache();
    await sync.syncAllAccounts('test', alice);
    accounts.clearTokenCache();
    await sync.syncAllAccounts('test', bob);
  });

  afterAll(async () => { vi.unstubAllGlobals(); await db.getPool().end(); });

  it('PHASE 6: 10 messages in, 4 reports processed, 6 ignored', async () => {
    const rows = await db.query(
      `select processing_status, count(*)::int as n from documents
       where owner_user_id = $1 group by 1 order by 1`, [alice]);
    const byStatus = Object.fromEntries(rows.map((r: any) => [r.processing_status, r.n]));
    expect(byStatus.NO_DATA).toBe(6);
    expect((byStatus.SUCCESS || 0) + (byStatus.PARTIAL || 0)).toBe(4);
    const total = await db.query(
      `select count(*)::int as n from documents where owner_user_id = $1`, [alice]);
    expect(total[0].n).toBe(10);
  });

  it('PHASE 29: all four departments land, correctly separated', async () => {
    const rows = await db.query(
      `select department, count(*)::int as n from tasks
       where owner_user_id = $1 group by 1 order by 1`, [alice]);
    expect(rows).toEqual([
      { department: 'HR', n: 2 },
      { department: 'Marketing', n: 1 },
      { department: 'Operations', n: 1 },
      { department: 'Sales', n: 2 }
    ]);
  });

  it('each user sees only their own tasks', async () => {
    const a = await db.query(`select count(*)::int as n from tasks where owner_user_id=$1`, [alice]);
    const b = await db.query(`select count(*)::int as n from tasks where owner_user_id=$1`, [bob]);
    expect(a[0].n).toBe(6);
    expect(b[0].n).toBe(6);
    const kpiA = await queries.getKpis(alice);
    const kpiB = await queries.getKpis(bob);
    expect(kpiA.total).toBe(6);
    expect(kpiB.total).toBe(6);
  });

  it('identical reports in two mailboxes are NOT treated as duplicates', async () => {
    // Both inboxes contain the same Sales report. Deduplication is per user;
    // treating them as one would silently delete a real manager's data.
    const fps = await db.query(
      `select task_fingerprint, count(distinct owner_user_id)::int as owners
       from tasks group by 1 having count(distinct owner_user_id) > 1`);
    expect(fps.length).toBeGreaterThan(0);
    const dupes = await db.query(
      `select count(*)::int as n from data_quality
       where rejection_reason = 'DUPLICATE_ACROSS_DOCUMENTS'`);
    expect(dupes[0].n).toBe(0);
  });

  it('every dashboard query is scoped: no cross-user leakage', async () => {
    for (const [uid, other] of [[alice, bob], [bob, alice]] as [number, number][]) {
      const depts = await queries.getDepartments(uid);
      const emps = await queries.getEmployees(uid);
      const docs = await queries.getDocuments(uid, 100);
      const rejects = await queries.getRejections(uid);
      const repeats = await queries.getRepeatGroups(uid);
      expect(docs.every((d: any) => d.documentId.startsWith(uid === alice ? 'gmail:a' : 'gmail:b')))
        .toBe(true);
      expect(depts.length).toBe(4);
      expect(emps.length).toBeGreaterThan(0);
      expect(rejects.length).toBe(0);
      expect(Array.isArray(repeats)).toBe(true);
      const otherDocs = await queries.getDocuments(other, 100);
      expect(docs.map((d: any) => d.documentId)
        .some((id: string) => otherDocs.map((o: any) => o.documentId).includes(id))).toBe(false);
    }
  });

  it("one user cannot read or disconnect another's Gmail connection", async () => {
    expect(await accounts.getGmailAccount(bobAcct, alice)).toBeNull();
    expect(await accounts.getGmailAccount(aliceAcct, bob)).toBeNull();

    await accounts.disconnectGmailAccount(bobAcct, alice);   // wrong owner: no-op
    const stillActive = await db.query(
      `select active from gmail_accounts where id = $1`, [bobAcct]);
    expect(stillActive[0].active).toBe(true);

    const aliceList = await accounts.listGmailAccounts(alice);
    expect(aliceList.map((a: any) => a.email)).toEqual(['alice@company.com']);
  });

  it("one user's analysis rebuild does not wipe another's", async () => {
    await sync.rebuildAnalysisAfterSync(alice);
    const bobGroups = await db.query(
      `select count(*)::int as n from repeat_groups where owner_user_id = $1`, [bob]);
    const bobTasks = await db.query(
      `select count(*)::int as n from tasks where owner_user_id = $1`, [bob]);
    expect(bobTasks[0].n).toBe(6);
    expect(bobGroups[0].n).toBeGreaterThanOrEqual(0);
  });

  it('the cron sweep covers every user without mixing their data', async () => {
    accounts.clearTokenCache();
    installFetch();
    const summaries = await sync.syncAllAccounts('cron', null);
    expect(summaries.length).toBe(2);
    // Everything was already ingested, so a second sweep changes nothing.
    expect(summaries.every((s: any) => s.rowsImported === 0)).toBe(true);
    const totals = await db.query(
      `select owner_user_id, count(*)::int as n from tasks group by 1 order by 1`);
    expect(totals.map((r: any) => r.n)).toEqual([6, 6]);
  });
});
