/**
 * Orchestration: document -> database -> analysis -> flags.
 *
 * Kept separate from both the engine (pure) and the routes (HTTP) so the whole
 * flow can be tested against a real Postgres without a server.
 */
import { analyze } from './core/analysis';
import { ingestDocument } from './core/ingest';
import { DEFAULT_ENGINE_CONFIG } from './core/types';
import type { EngineConfig, IngestResult, SourceDocument } from './core/types';
import { parseDate } from './core/normalize';
import {
  insertRejections, insertTasks, loadFingerprints, loadMasters, loadTasks,
  logEvent, replaceRepeatGroups, upsertDocument, upsertEmployees, writeAnalysisFlags
} from './db';

export function engineConfig(): EngineConfig {
  return {
    ...DEFAULT_ENGINE_CONFIG,
    slowTaskMultiplier: Number(process.env.SLOW_TASK_MULTIPLIER || DEFAULT_ENGINE_CONFIG.slowTaskMultiplier),
    dateOrder: (process.env.DATE_ORDER as 'DMY' | 'MDY') || DEFAULT_ENGINE_CONFIG.dateOrder
  };
}

/** Parse and validate WITHOUT writing anything. Used by the preview screen. */
export async function previewDocument(
  doc: SourceDocument, ownerUserId: number
): Promise<IngestResult> {
  const [masters, fingerprints] = await Promise.all([
    loadMasters(), loadFingerprints(ownerUserId)
  ]);
  return ingestDocument(doc, masters, engineConfig(), fingerprints);
}

export interface CommitResult extends IngestResult {
  rowsWritten: number;
  analysisRebuilt: boolean;
}

/**
 * Ingests for real. The database's unique constraint on task_fingerprint is the
 * final backstop, so `rowsWritten` can legitimately be lower than
 * `accepted.length` if a concurrent request got there first — that is the
 * system working, not an error.
 */
export async function commitDocument(
  doc: SourceDocument, source: string, ownerUserId: number
): Promise<CommitResult> {
  const cfg = engineConfig();
  const [masters, fingerprints] = await Promise.all([
    loadMasters(), loadFingerprints(ownerUserId)
  ]);
  const result = ingestDocument(doc, masters, cfg, fingerprints);

  if (result.newEmployees.length) await upsertEmployees(result.newEmployees);

  const addr = (doc.sender.match(/<([^>]+)>/)?.[1] || doc.sender || '').toLowerCase().trim();
  const senderDomain = addr.includes('@') ? addr.split('@')[1] : '';

  // The document row is written FIRST so the tasks' foreign key resolves, but
  // its counters are corrected after the insert so they reflect what actually
  // landed rather than what we hoped would land.
  await upsertDocument({
    ownerUserId,
    reportId: result.reportId, documentId: doc.documentId, source,
    subject: doc.subject, sender: doc.sender, senderDomain,
    department: result.department, reportDate: result.reportDate,
    receivedAt: doc.receivedAt, status: result.status,
    tablesFound: result.tablesFound, rowsExtracted: result.rowsExtracted,
    rowsInserted: 0, rowsSkipped: result.skippedIdempotent,
    rowsRejected: result.rejected.length,
    error: result.rejected.length ? `${result.rejected.length} row(s) rejected` : ''
  });

  const rowsWritten = await insertTasks(result.accepted, ownerUserId);

  if (result.rejected.length) {
    const claimedDates = result.rejected.map(
      r => parseDate(r.raw.date, cfg.dateOrder)
    );
    await insertRejections(result.rejected, claimedDates, ownerUserId);
  }

  await upsertDocument({
    ownerUserId,
    reportId: result.reportId, documentId: doc.documentId, source,
    subject: doc.subject, sender: doc.sender, senderDomain,
    department: result.department, reportDate: result.reportDate,
    receivedAt: doc.receivedAt, status: result.status,
    tablesFound: result.tablesFound, rowsExtracted: result.rowsExtracted,
    rowsInserted: rowsWritten, rowsSkipped: result.skippedIdempotent,
    rowsRejected: result.rejected.length,
    error: result.rejected.length ? `${result.rejected.length} row(s) rejected` : ''
  });

  const analysisRebuilt = rowsWritten > 0;
  if (analysisRebuilt) await rebuildAnalysis(ownerUserId);

  await logEvent(
    result.rejected.length ? 'WARN' : 'INFO', 'Pipeline', 'commit',
    result.status,
    `${rowsWritten} written, ${result.skippedIdempotent} already present, ` +
    `${result.rejected.length} rejected from "${doc.subject}"`,
    doc.documentId, result.reportId
  );

  return { ...result, rowsWritten, analysisRebuilt };
}

/**
 * Recomputes repeat classification and slow-task flags across the whole
 * dataset and writes them back. Repeat classification depends on every other
 * row, so it cannot be computed incrementally.
 */
export async function rebuildAnalysis(
  ownerUserId: number
): Promise<{ tasks: number; repeatGroups: number; slowTasks: number }> {
  const cfg = engineConfig();
  const tasks = (await loadTasks(ownerUserId)).filter(t => t.workKind !== 'PLANNED');
  const analysis = analyze(tasks, cfg);
  await writeAnalysisFlags(
    analysis.repeatByTaskId as Map<string, string>,
    analysis.slowFlagByTaskId as Map<string, string>,
    analysis.varianceByTaskId,
    ownerUserId,
    analysis.slowDetailByTaskId
  );
  await replaceRepeatGroups(analysis.repeatGroups, ownerUserId);
  return {
    tasks: tasks.length,
    repeatGroups: analysis.repeatGroups.length,
    slowTasks: analysis.slowTasks.length
  };
}
