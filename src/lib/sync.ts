/**
 * The assistant's actual job: read the connected inbox and turn reports into
 * data. Triggered by cron, by connecting an account, or by "Sync now".
 *
 * Nobody labels, forwards, uploads or runs anything. Every message in the
 * window is examined once; whether it is a report is decided by its content.
 *
 * Idempotency runs at two levels:
 *   message  — every scanned Gmail message id gets a `documents` row, so the
 *              next sync never re-downloads or re-parses it
 *   row      — task fingerprints, plus the unique constraint in Postgres
 * So a sync that dies halfway is simply re-run, and a message that arrives in
 * two syncs contributes nothing the second time.
 */
import { analyze } from './core/analysis';
import { attachmentToTables, isParsableAttachment } from './core/attachments';
import { buildGmailQuery, detectInBody, detectInTables } from './core/detect';
import { ingestDocument } from './core/ingest';
import { parseDate } from './core/normalize';
import type { SourceDocument } from './core/types';
import {
  insertRejections, insertTasks, loadFingerprints, loadMasters, loadTasks,
  logEvent, query, replaceRepeatGroups, upsertEmployees, writeAnalysisFlags
} from './db';
import { getAttachment, getMessage, listMessageIds } from './gmail';
import type { GmailMessage } from './gmail';
import { engineConfig } from './pipeline';
import {
  getAccessTokenFor, GmailAccount, invalidateAccessToken, listGmailAccounts, recordSyncResult
} from './accounts';

export interface SyncSummary {
  accountEmail: string;
  status: 'OK' | 'PARTIAL' | 'FAILED' | 'REAUTH_REQUIRED';
  messagesScanned: number;
  reportsFound: number;
  rowsImported: number;
  rowsRejected: number;
  rowsDuplicate: number;
  errors: string[];
  details: { subject: string; from: string; source: string; imported: number; rejected: number; reason: string }[];
}

const MAX_MESSAGES_PER_SYNC = Number(process.env.MAX_MESSAGES_PER_SYNC || 60);
const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES || 8 * 1024 * 1024);

/**
 * Sync one user's inboxes, or — with ownerUserId null — every connected inbox,
 * which is what the scheduled job does. Analysis is rebuilt per user, because
 * repeat classification is only meaningful within one mailbox's data.
 */
export async function syncAllAccounts(
  trigger: string, ownerUserId: number | null
): Promise<SyncSummary[]> {
  const accounts = await listGmailAccounts(ownerUserId);
  const out: SyncSummary[] = [];
  const touched = new Set<number>();
  for (const acct of accounts) {
    const summary = await syncAccount(acct, trigger);
    if (summary.rowsImported > 0) touched.add(acct.ownerUserId);
    out.push(summary);
  }
  for (const uid of touched) await rebuildAnalysisAfterSync(uid);
  return out;
}

export async function syncAccount(account: GmailAccount, trigger: string): Promise<SyncSummary> {
  const summary: SyncSummary = {
    accountEmail: account.email, status: 'OK', messagesScanned: 0, reportsFound: 0,
    rowsImported: 0, rowsRejected: 0, rowsDuplicate: 0, errors: [], details: []
  };

  const owner = account.ownerUserId;
  const [{ id: runId }] = await query<{ id: number }>(
    `insert into sync_runs (gmail_account_id, trigger, owner_user_id)
     values ($1,$2,$3) returning id`,
    [account.id, trigger, owner]
  );

  let accessToken: string;
  try {
    accessToken = await getAccessTokenFor(account);
  } catch (e) {
    const code = (e as Error & { code?: string }).code;
    summary.status = code === 'REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : 'FAILED';
    summary.errors.push((e as Error).message);
    await finishRun(runId, summary);
    await recordSyncResult(account.id, summary.status, (e as Error).message);
    return summary;
  }

  try {
    const cfg = engineConfig();
    const masters = await loadMasters();
    const fingerprints = await loadFingerprints(owner);
    const seen = await loadSeenMessageIds(owner);

    const query_ = buildGmailQuery(account.syncSince, process.env.GMAIL_EXTRA_QUERY || '');
    let ids: string[];
    try {
      ids = await listMessageIds(accessToken, query_, MAX_MESSAGES_PER_SYNC);
    } catch (e) {
      // Gmail answers 401 the moment the user revokes access. A cached access
      // token can still look valid to us, so drop it and mint a fresh one; if
      // THAT fails the grant is genuinely gone and the user must reconnect.
      if ((e as Error & { status?: number }).status !== 401) throw e;
      invalidateAccessToken(account);
      accessToken = await getAccessTokenFor(account, true);
      ids = await listMessageIds(accessToken, query_, MAX_MESSAGES_PER_SYNC);
    }
    const fresh = ids.filter(id => !seen.has(id));

    for (const id of fresh) {
      summary.messagesScanned++;
      try {
        const msg = await getMessage(accessToken, id);
        const documents = await documentsFromMessage(msg, accessToken, masters, cfg);

        if (!documents.length) {
          // Not a report. Recorded so it is never examined again.
          await recordNonReport(account.id, owner, msg,
            'No report table in the body or attachments');
          continue;
        }

        summary.reportsFound++;
        for (const doc of documents) {
          const result = ingestDocument(doc, masters, cfg, fingerprints);
          if (result.newEmployees.length) await upsertEmployees(result.newEmployees);

          await upsertGmailDocument(account.id, owner, msg, doc, result.reportId,
            result.status, result.tablesFound, result.rowsExtracted, 0,
            result.skippedIdempotent, result.rejected.length);

          const written = await insertTasks(result.accepted, owner);
          if (result.rejected.length) {
            await insertRejections(
              result.rejected,
              result.rejected.map(r => parseDate(r.raw.date, cfg.dateOrder)),
              owner
            );
          }
          await upsertGmailDocument(account.id, owner, msg, doc, result.reportId,
            result.status, result.tablesFound, result.rowsExtracted, written,
            result.skippedIdempotent, result.rejected.length);

          summary.rowsImported += written;
          summary.rowsRejected += result.rejected.length;
          summary.rowsDuplicate += result.rejected.filter(
            r => r.reason === 'DUPLICATE_ACROSS_DOCUMENTS').length;
          summary.details.push({
            subject: msg.subject, from: msg.from,
            source: doc.attachmentName ? `attachment: ${doc.attachmentName}` : 'email body',
            imported: written, rejected: result.rejected.length, reason: result.message
          });
        }
      } catch (e) {
        summary.errors.push(`${id}: ${(e as Error).message}`);
        await logEvent('ERROR', 'Sync', 'message', 'ERROR', (e as Error).message, id);
      }
    }

    if (summary.errors.length) summary.status = 'PARTIAL';
  } catch (e) {
    const code = (e as Error & { code?: string }).code;
    summary.status = code === 'REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : 'FAILED';
    summary.errors.push((e as Error).message);
  }

  await finishRun(runId, summary);
  await recordSyncResult(account.id, summary.status,
    `${summary.reportsFound} report(s), ${summary.rowsImported} row(s) imported` +
    (summary.errors.length ? `, ${summary.errors.length} error(s)` : ''));
  return summary;
}

/**
 * One Gmail message can yield several documents: the body, plus one per
 * parsable attachment. Each is ingested separately so a spreadsheet and an
 * inline table in the same email do not collide, and so the source of every
 * row stays traceable.
 */
async function documentsFromMessage(
  msg: GmailMessage, accessToken: string,
  masters: Awaited<ReturnType<typeof loadMasters>>,
  cfg: ReturnType<typeof engineConfig>
): Promise<SourceDocument[]> {
  const docs: SourceDocument[] = [];

  const body = detectInBody(msg.html, msg.text, masters, cfg);
  if (body.isReport) {
    docs.push({
      documentId: `gmail:${msg.id}`,
      subject: msg.subject, sender: msg.from, receivedAt: msg.date,
      html: msg.html || undefined, text: msg.text || undefined
    });
  }

  for (const att of msg.attachments) {
    if (!isParsableAttachment(att.filename, att.mimeType)) continue;
    if (att.size > MAX_ATTACHMENT_BYTES) continue;
    try {
      const buf = await getAttachment(accessToken, msg.id, att.attachmentId);
      const tables = await attachmentToTables(att.filename, att.mimeType, buf);
      if (!tables.length) continue;
      const signal = detectInTables(tables, masters, cfg);
      if (!signal.isReport) continue;
      docs.push({
        documentId: `gmail:${msg.id}:${att.filename}`,
        subject: `${msg.subject} [${att.filename}]`,
        sender: msg.from, receivedAt: msg.date,
        tables, attachmentName: att.filename
      });
    } catch (e) {
      await logEvent('WARN', 'Sync', 'attachment', 'WARN',
        `${att.filename}: ${(e as Error).message}`, msg.id);
    }
  }
  return docs;
}

async function loadSeenMessageIds(ownerUserId: number): Promise<Set<string>> {
  const rows = await query<{ gmail_message_id: string }>(
    `select distinct gmail_message_id from documents
     where gmail_message_id is not null and owner_user_id = $1`, [ownerUserId]);
  return new Set(rows.map(r => r.gmail_message_id));
}

async function recordNonReport(
  accountId: number, ownerUserId: number, msg: GmailMessage, reason: string
): Promise<void> {
  await query(
    `insert into documents (report_id, document_id, source, subject, sender, sender_domain,
       received_at, processing_status, tables_found, rows_extracted, rows_inserted,
       rows_skipped_idempotent, rows_rejected, error_message, gmail_account_id,
       gmail_message_id, owner_user_id)
     values ($1,$2,'email',$3,$4,$5,$6,'NO_DATA',0,0,0,0,0,$7,$8,$9,$10)
     on conflict (owner_user_id, report_id) do nothing`,
    [`GM-${msg.id}`, `gmail:${msg.id}`, msg.subject.slice(0, 300), msg.from,
     senderDomain(msg.from), msg.date, reason, accountId, msg.id, ownerUserId]
  );
}

async function upsertGmailDocument(
  accountId: number, ownerUserId: number, msg: GmailMessage, doc: SourceDocument,
  reportId: string, status: string, tablesFound: number, rowsExtracted: number,
  rowsInserted: number, rowsSkipped: number, rowsRejected: number
): Promise<void> {
  await query(
    `insert into documents (report_id, document_id, source, subject, sender, sender_domain,
       received_at, processing_status, tables_found, rows_extracted, rows_inserted,
       rows_skipped_idempotent, rows_rejected, gmail_account_id, gmail_message_id,
       attachment_name, owner_user_id, processed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
     on conflict (owner_user_id, report_id) do update set
       processing_status = excluded.processing_status,
       tables_found = excluded.tables_found,
       rows_extracted = excluded.rows_extracted,
       rows_inserted = greatest(documents.rows_inserted, excluded.rows_inserted),
       rows_skipped_idempotent = excluded.rows_skipped_idempotent,
       rows_rejected = excluded.rows_rejected,
       processed_at = now()`,
    [reportId, doc.documentId, doc.attachmentName ? 'attachment' : 'email',
     doc.subject.slice(0, 300), msg.from, senderDomain(msg.from), msg.date, status,
     tablesFound, rowsExtracted, rowsInserted, rowsSkipped, rowsRejected,
     accountId, msg.id, doc.attachmentName || null, ownerUserId]
  );
}

function senderDomain(from: string): string {
  const addr = (from.match(/<([^>]+)>/)?.[1] || from || '').toLowerCase().trim();
  return addr.includes('@') ? addr.split('@')[1] : '';
}

async function finishRun(runId: number, s: SyncSummary): Promise<void> {
  await query(
    `update sync_runs set finished_at = now(), status = $2, messages_scanned = $3,
       reports_found = $4, rows_imported = $5, rows_rejected = $6, rows_duplicate = $7,
       error_message = $8
     where id = $1`,
    [runId, s.status, s.messagesScanned, s.reportsFound, s.rowsImported,
     s.rowsRejected, s.rowsDuplicate, s.errors.slice(0, 5).join(' | ') || null]
  );
}

/** Repeat classification depends on the whole dataset, so it is rebuilt once
 *  after a sync rather than per message. */
export async function rebuildAnalysisAfterSync(ownerUserId: number): Promise<void> {
  const cfg = engineConfig();
  const tasks = await loadTasks(ownerUserId);
  const analysis = analyze(tasks, cfg);
  await writeAnalysisFlags(
    analysis.repeatByTaskId as Map<string, string>,
    analysis.slowFlagByTaskId as Map<string, string>,
    analysis.varianceByTaskId,
    ownerUserId
  );
  await replaceRepeatGroups(analysis.repeatGroups, ownerUserId);
}
