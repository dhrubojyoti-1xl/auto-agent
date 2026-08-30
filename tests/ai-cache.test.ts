/**
 * The AI key is billed per call, so commentary already written for exactly
 * these figures must not be written again.
 *
 * The cache branch returns before an Anthropic client is even constructed, so
 * `generator === 'ai:cached'` is proof that no request was made — nothing else
 * in the function produces that value. Going the other way, a cache miss with
 * an unusable key surfaces as OK_AI_UNAVAILABLE, which is equally unambiguous.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from './helpers';

const DB = process.env.TEST_DATABASE_URL;
const d = DB ? describe : describe.skip;
process.env.DATABASE_URL = DB || 'postgres://localhost/does-not-exist';

const STORED = {
  summary: 'Four tasks were reported and two were completed.',
  overall_completion_rate: 50,
  department_observations: [], attention_items: [],
  slow_tasks: [], repeated_tasks: [], trends: [], data_quality: []
};

/* eslint-disable @typescript-eslint/no-explicit-any */
d('AI commentary is reused while the figures hold still', () => {
  let db: any, seedDb: any, reporting: any;
  const UID = 1;
  const REPORT_ID = 'DAILY-2026-08-12-u1';

  async function storeCommentary(fingerprint: string) {
    await db.query(
      `insert into ai_reports (report_id, report_type, period_start, period_end,
         generator, model, status, summary, human_report, dataset_json, ai_json,
         validation_error, owner_user_id, dataset_fingerprint)
       values ($1,'DAILY',date '2026-08-12',date '2026-08-12','ai:anthropic','test-model',
               'OK_AI',$2,'stored report','{}',$3,null,$4,$5)
       on conflict (report_id) do update set
         ai_json = excluded.ai_json, dataset_fingerprint = excluded.dataset_fingerprint,
         generator = excluded.generator, summary = excluded.summary,
         human_report = excluded.human_report`,
      [REPORT_ID, STORED.summary, JSON.stringify(STORED), UID, fingerprint]);
  }

  beforeAll(async () => {
    db = await import('../src/lib/db');
    seedDb = await import('../src/lib/seed-db');
    reporting = await import('../src/lib/reporting');
    await resetDatabase(db, seedDb, { demo: false });
    await db.query(
      `insert into tasks (task_id, task_date, department, employee_name, task,
                          task_normalized, task_status, duration_basis,
                          source_document_id, task_fingerprint, owner_user_id)
       select 'C-' || g, date '2026-08-12', 'Sales', 'Rahul Mehta',
              'Client call ' || g, 'client call ' || g,
              case when g % 2 = 0 then 'Completed' else 'Pending' end,
              'Insufficient Data', 'C-DOC', 'c-' || g, $1
       from generate_series(1, 4) g`, [UID]);
  });

  afterAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await db.getPool().end();
  });

  it('fingerprints the dataset stably, ignoring the generation timestamp', async () => {
    const a = await reporting.generateReport('DAILY', UID, '2026-08-12', false);
    const b = await reporting.generateReport('DAILY', UID, '2026-08-12', false);
    const fa = reporting.datasetFingerprint(a.dataset);
    const fb = reporting.datasetFingerprint(b.dataset);
    expect(fa).toBe(fb);
    expect(fa).toMatch(/^[0-9a-f]{40}$/);
  });

  it('serves the stored commentary without contacting the model', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-deliberately-invalid-key';
    const dry = await reporting.generateReport('DAILY', UID, '2026-08-12', false);
    await storeCommentary(reporting.datasetFingerprint(dry.dataset));

    const r = await reporting.generateReport('DAILY', UID, '2026-08-12', true);
    // Only the cache branch can produce this, and it returns before a client
    // is constructed. An unusable key would otherwise give OK_AI_UNAVAILABLE.
    expect(r.generator).toBe('ai:cached');
    expect(r.commentary?.summary).toBe(STORED.summary);
    // Re-validated on the way out, not trusted because it was stored.
    expect(r.commentary?.overallCompletionRate).toBe(50);
  });

  it('stops using the cache the moment a task changes the figures', async () => {
    await db.query(
      `insert into tasks (task_id, task_date, department, employee_name, task,
                          task_normalized, task_status, duration_basis,
                          source_document_id, task_fingerprint, owner_user_id)
       values ('C-9', date '2026-08-12', 'Sales', 'Rahul Mehta', 'New work',
               'new work', 'Completed', 'Insufficient Data', 'C-DOC', 'c-9', $1)`,
      [UID]);
    const r = await reporting.generateReport('DAILY', UID, '2026-08-12', true);
    expect(r.generator).not.toBe('ai:cached');
    expect(r.status).toBe('OK_AI_UNAVAILABLE');    // it did try, and the key is bad
    expect(r.dataset.totals.total).toBe(5);        // and the figures are still right
  }, 60_000);

  it('ignores the cache when a rewrite is explicitly requested', async () => {
    const dry = await reporting.generateReport('DAILY', UID, '2026-08-12', false);
    await storeCommentary(reporting.datasetFingerprint(dry.dataset));
    const cached = await reporting.generateReport('DAILY', UID, '2026-08-12', true);
    expect(cached.generator).toBe('ai:cached');

    const forced = await reporting.generateReport(
      'DAILY', UID, '2026-08-12', true, { force: true });
    expect(forced.generator).not.toBe('ai:cached');
  }, 60_000);

  it('never reaches the cache, or the model, when AI is switched off', async () => {
    const r = await reporting.generateReport('DAILY', UID, '2026-08-12', false);
    expect(r.generator).toBe('deterministic');
    expect(r.status).toBe('OK_NO_AI');
    expect(r.humanReport.length).toBeGreaterThan(200);
  });
});
