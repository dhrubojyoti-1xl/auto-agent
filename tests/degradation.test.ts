/**
 * The product has to keep working when a part of it does not.
 *
 * The AI is a paid third-party service and the database is a free-tier one;
 * both will be unavailable sometimes. Neither may take the dashboard down with
 * it, and neither may produce a page that quietly shows wrong numbers instead
 * of saying what happened.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';
import { LIMITS, rateLimit, resetRateLimits } from '../src/lib/rate-limit';
import { findDepartmentInText } from '../src/lib/core/normalize';
import { seedMasters } from '../src/lib/seed';
import { engineConfig } from '../src/lib/pipeline';
import { safeErrorMessage } from '../src/lib/safe-error';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

describe('a subject line cannot invent a department', () => {
  const cfg = engineConfig();
  const masters = seedMasters();

  it('ignores forwarding and reply prefixes', () => {
    for (const subject of ['Fwd: Daily Report', 'Re: Daily Report',
                           'FW: Daily report - updated', 'Daily Report']) {
      const found = findDepartmentInText(subject, masters, cfg);
      expect(['', ...masters.departments.map(x => x.name)], subject).toContain(found);
      expect(['Fwd', 'Re', 'FW', 'Daily'], subject).not.toContain(found);
    }
  });

  it('still finds a department that is genuinely named', () => {
    const hr = masters.departments.find(x => /hr|human/i.test(x.name));
    if (!hr) return;
    expect(findDepartmentInText(`Daily Report - ${hr.name}`, masters, cfg)).toBe(hr.name);
  });

  it('does not invent a department from an unknown word', () => {
    expect(findDepartmentInText('Daily Report - Frobnication', masters, cfg)).toBe('');
  });
});

describe('rate limits protect quota without obstructing a person', () => {
  it('allows a burst a human can produce, then asks them to wait', () => {
    resetRateLimits();
    const { limit, windowMs } = LIMITS.sync;
    for (let i = 0; i < limit; i++) {
      expect(rateLimit('sync:1', limit, windowMs).ok, `attempt ${i + 1}`).toBe(true);
    }
    const blocked = rateLimit('sync:1', limit, windowMs);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts each user separately, so one cannot lock out another', () => {
    resetRateLimits();
    for (let i = 0; i < LIMITS.sync.limit + 3; i++) rateLimit('sync:1', LIMITS.sync.limit, 60_000);
    expect(rateLimit('sync:2', LIMITS.sync.limit, 60_000).ok).toBe(true);
  });

  it('lets the window expire rather than blocking for ever', () => {
    resetRateLimits();
    expect(rateLimit('sync:3', 1, 1).ok).toBe(true);
    expect(rateLimit('sync:3', 1, 1).ok).toBe(false);
    return new Promise<void>(r => setTimeout(() => {
      expect(rateLimit('sync:3', 1, 1).ok).toBe(true);
      r();
    }, 12));
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
d('the product without its AI', () => {
  let db: any, seedDb: any, reporting: any;
  const UID = 1;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    reporting = await import('../src/lib/reporting');
    await resetDatabase(db, seedDb, { demo: false });
    await db.query(
      `insert into tasks (task_id, task_date, department, employee_name, task,
                          task_normalized, task_status, duration_basis,
                          source_document_id, task_fingerprint, owner_user_id)
       select 'D-' || g, date '2026-08-12', 'Sales', 'Rahul Mehta',
              'Client call ' || g, 'client call ' || g,
              case when g % 2 = 0 then 'Completed' else 'Pending' end,
              'Insufficient Data', 'D-DOC', 'd-' || g, $1
       from generate_series(1, 6) g`, [UID]);
  });

  afterAll(async () => {
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    await db.getPool().end();
  });

  it('still produces a complete report with no API key at all', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await reporting.generateReport('DAILY', UID, '2026-08-12', true);
    expect(r.status).toBe('OK_NO_AI');
    expect(r.humanReport.length).toBeGreaterThan(200);
    // The numbers are computed either way; only the commentary is missing.
    expect(r.dataset.totals.total).toBe(6);
    expect(r.dataset.totals.completed).toBe(3);
    expect(r.dataset.totals.completionRate).toBe(50);
    expect(r.commentary).toBeNull();
  });

  it('says the AI is unavailable rather than reporting nothing', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-not-a-real-key-for-tests';
    const r = await reporting.generateReport('DAILY', UID, '2026-08-12', true, { force: true });
    expect(r.status).toBe('OK_AI_UNAVAILABLE');
    expect(r.validationError).toMatch(/AI unavailable/);
    expect(r.dataset.totals.total).toBe(6);        // the figures are still right
    expect(r.humanReport).toContain('6');
  }, 60_000);

  it('a dashboard query still answers while the AI is down', async () => {
    const q = await import('../src/lib/queries');
    const kpis = await q.getKpis(UID);
    expect(kpis.total).toBe(6);
    expect(kpis.completionRate).toBe(50);
  });
});

describe('an error on screen never carries a credential', () => {
  it('redacts the password out of a Postgres URL', () => {
    const msg = safeErrorMessage(new Error(
      'connect ECONNREFUSED for postgresql://postgres.abc:hunter2@aws-0.pooler.supabase.com:6543/postgres'));
    expect(msg).not.toContain('hunter2');
    expect(msg).toContain('***:***@');
    expect(msg).toContain('ECONNREFUSED');       // still says what went wrong
  });

  it('redacts an Anthropic key and a bearer token', () => {
    expect(safeErrorMessage(new Error('401 from sk-ant-api03-abcdefghijklmnop')))
      .not.toMatch(/abcdefghijklmnop/);
    expect(safeErrorMessage(new Error('Authorization: Bearer ya29.a0AfB_xyz123456')))
      .not.toMatch(/ya29/);
  });

  it('redacts a labelled secret in any casing', () => {
    for (const s of ['password=hunter2', 'API_KEY: abc123xyz', 'token=zzzzzzzzz']) {
      expect(safeErrorMessage(new Error(s)), s).toMatch(/\*\*\*/);
    }
  });

  it('leaves an ordinary message alone', () => {
    expect(safeErrorMessage(new Error('relation "tasks" does not exist')))
      .toBe('relation "tasks" does not exist');
  });

  it('bounds the length, so a huge driver dump cannot fill the page', () => {
    expect(safeErrorMessage(new Error('x'.repeat(5000))).length).toBe(300);
  });
});
