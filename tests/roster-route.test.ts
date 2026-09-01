/**
 * The roster endpoint, executed rather than read.
 *
 * A route that exists is not a route that works: this project has already
 * shipped one endpoint whose every query named a table that did not exist, and
 * ten tests passed on it because they inspected the source instead of running
 * it. So these call the real handlers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

/* eslint-disable @typescript-eslint/no-explicit-any */
d('POST /api/roster', () => {
  let db: any, seedDb: any, route: any;
  let signedIn = true;

  const post = (body: unknown) => route.POST(
    new Request('http://localhost/api/roster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }));

  beforeAll(async () => {
    vi.doMock('@/lib/auth', () => ({
      getSession: async () => (signedIn ? { userId: 1, email: 'a@b.c' } : null)
    }));
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    await resetDatabase(db, seedDb, { demo: false });
    route = await import('../src/app/api/roster/route');
  });

  afterAll(async () => { vi.doUnmock('@/lib/auth'); await db.getPool().end(); });

  it('refuses a caller with no session', async () => {
    signedIn = false;
    const res = await post({ text: 'Department,Employee\nSales,A Person' });
    expect(res.status).toBe(401);
    signedIn = true;
  });

  it('asks for content rather than failing obscurely on an empty paste', async () => {
    const res = await post({ text: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/paste/i);
  });

  it('refuses a paste far larger than any staff list', async () => {
    const res = await post({ text: 'x'.repeat(500_001) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/staff list/i);
  });

  it('explains itself when no usable columns are present', async () => {
    const res = await post({ text: 'Price,Quantity\n10,2' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name column|could be read/i);
  });

  it('previews without writing anything', async () => {
    const res = await post({
      text: 'Team,Staff Member\nSOP,Rahul Koli', preview: true
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preview).toBe(true);
    expect(body.people).toHaveLength(1);

    const { people } = await db.loadRoster();
    expect(people.find((p: any) => p.name === 'Rahul Koli')).toBeUndefined();
  });

  it('writes on a real save, and says what it read each column as', async () => {
    const res = await post({ text: 'Team,Staff Member,Mail ID\nSOP,Rahul Koli,r@1xl.com' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.written.people).toBe(1);
    expect(Object.values(body.mapping)).toContain('department');

    const { people } = await db.loadRoster();
    const rahul = people.find((p: any) => p.name === 'Rahul Koli');
    expect(rahul.department).toBe('SOP');
    expect(rahul.autoCreated).toBe(false);
  });

  it('GET returns the roster it just saved', async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.people.map((p: any) => p.name)).toContain('Rahul Koli');
  });

  it('never returns a stack trace or connection string', async () => {
    const res = await post({ text: 'Team,Staff Member\nSOP,Someone Else' });
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/postgres:\/\/|at Object\.|node_modules/);
  });
});
