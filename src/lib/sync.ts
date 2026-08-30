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
import {
  attachmentToTables, isParsableAttachment, isUnreadableDocumentAttachment,
  looksLikeReportImage
} from './core/attachments';
import {
  buildGmailQuery, confidenceFor, detectInBody, detectInTables, DETECTOR_VERSION
} from './core/detect';
import type { MessageClassification } from './core/detect';
import { csvToTables } from './core/attachments';
import { fetchSheet, findSheetLinks } from './core/links';
import { dateFromTitle, verifyVisionTable, visionTableToRows } from './core/vision';
import { transcribeTable, visionAvailable, visionMediaType } from './vision-client';
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

/**
 * GMAIL_AUTH_ERROR is the outward name for "Google will not give us a token
 * any more". It is never retried: an invalid_grant does not become valid by
 * asking again, and retrying it turns a one-click fix into a daily failure.
 *
 * On an OAuth app in Testing status Google expires refresh tokens after seven
 * days, so this is not an exceptional condition — it is a weekly one, and it
 * has to read as "press this button", never as a sync failure.
 */
export interface SyncSummary {
  accountEmail: string;
  status: 'OK' | 'PARTIAL' | 'FAILED' | 'GMAIL_AUTH_ERROR';
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
    summary.status = code === 'REAUTH_REQUIRED' ? 'GMAIL_AUTH_ERROR' : 'FAILED';
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
        const skipped: SkippedAttachment[] = [];
        const bodySignal = { reason: '', confidence: 0 };
        const documents = await documentsFromMessage(
          msg, accessToken, masters, cfg, skipped, bodySignal);

        if (skipped.length) {
          await recordSkippedAttachments(owner, msg, skipped);
          summary.rowsRejected += skipped.length;
        }

        if (!documents.length) {
          // Every message ends with a decision a person can read. "Nothing was
          // found" and "something was found and could not be read" are
          // different outcomes and must not look the same.
          const { classification, evidence } = classifyUnprocessed(skipped, bodySignal);
          await recordNonReport(account.id, owner, msg, evidence, classification);
          continue;
        }

        summary.reportsFound++;
        for (const doc of documents) {
          const result = ingestDocument(doc, masters, cfg, fingerprints);
          if (result.newEmployees.length) await upsertEmployees(result.newEmployees);

          await upsertGmailDocument(account.id, owner, msg, doc, result.reportId,
            result.status, result.tablesFound, result.rowsExtracted, 0,
            result.skippedIdempotent, result.rejected.length,
            0.9, '', result.departments || []);

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
            result.skippedIdempotent, result.rejected.length,
            0.9, '', result.departments || []);

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
    summary.status = code === 'REAUTH_REQUIRED' ? 'GMAIL_AUTH_ERROR' : 'FAILED';
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
export interface SkippedAttachment {
  filename: string;
  reason: string;
  detail: string;
}

const MAX_SHEET_LINKS_PER_MESSAGE = Number(process.env.MAX_SHEET_LINKS || 3);

async function documentsFromMessage(
  msg: GmailMessage, accessToken: string,
  masters: Awaited<ReturnType<typeof loadMasters>>,
  cfg: ReturnType<typeof engineConfig>,
  skipped: SkippedAttachment[],
  bodySignal: { reason: string; confidence: number }
): Promise<SourceDocument[]> {
  const docs: SourceDocument[] = [];

  // Plain text is preferred; HTML is stripped to text so a covering sentence
  // wrapped in markup still reads as a sentence.
  const contextText = [
    msg.text || '',
    (msg.html || '').replace(/<[^>]+>/g, ' ')
  ].join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);

  const body = detectInBody(msg.html, msg.text, masters, cfg);
  bodySignal.reason = body.reason;
  bodySignal.confidence = confidenceFor(body);
  if (body.isReport) {
    docs.push({
      documentId: `gmail:${msg.id}`,
      subject: msg.subject, sender: msg.from, receivedAt: msg.date,
      html: msg.html || undefined, text: msg.text || undefined,
      contextText
    });
  }

  for (const att of msg.attachments) {
    // A file that never becomes data has to say so somewhere. Skipping quietly
    // is how a department mails its report every day, sees it arrive in the
    // inbox, and finds nothing in the dashboard and no explanation anywhere.
    if (!isParsableAttachment(att.filename, att.mimeType)) {
      // A picture of a table, or a PDF. Read it, but only import if the
      // transcription survives every structural check — see core/vision.
      const media = visionMediaType(att.filename, att.mimeType);
      const worthReading = media && (
        media === 'application/pdf' || looksLikeReportImage(att.filename, att.mimeType, att.size));

      if (worthReading && visionAvailable() && att.size <= MAX_ATTACHMENT_BYTES) {
        const outcome = await readByVision(
          att, msg, accessToken, masters, cfg, media as string);
        if (outcome.doc) { docs.push(outcome.doc); continue; }
        if (outcome.skipped) { skipped.push(outcome.skipped); continue; }
      }

      if (isUnreadableDocumentAttachment(att.filename, att.mimeType)) {
        skipped.push({
          filename: att.filename, reason: 'ATTACHMENT_FORMAT_UNSUPPORTED',
          detail: `A report was detected in a format this system does not read: ` +
                  `${att.filename}. Send it as a spreadsheet (.xlsx or .csv), as a table ` +
                  `in the email itself, or as a shared Google Sheet link.`
        });
      } else if (looksLikeReportImage(att.filename, att.mimeType, att.size)) {
        skipped.push({
          filename: att.filename, reason: 'IMAGE_REVIEW_REQUIRED',
          detail: `A report may have been sent as a screenshot: ${att.filename}. Images ` +
                  `are not read automatically, because the figures would have to be ` +
                  `guessed from pixels and a management report cannot rest on that. ` +
                  `Send the underlying spreadsheet, or paste the table into the email.`
        });
      }
      // Anything else — a logo, a signature image, a tracking pixel — is
      // genuinely not a report and is passed over without comment.
      continue;
    }

    if (att.size > MAX_ATTACHMENT_BYTES) {
      skipped.push({
        filename: att.filename, reason: 'ATTACHMENT_TOO_LARGE',
        detail: `${att.filename} is ${Math.round(att.size / 1024)}KB, over the ` +
                `${Math.round(MAX_ATTACHMENT_BYTES / 1024)}KB limit. Send a smaller file, ` +
                `or split the report.`
      });
      continue;
    }

    try {
      const buf = await getAttachment(accessToken, msg.id, att.attachmentId);
      const tables = await attachmentToTables(att.filename, att.mimeType, buf);
      if (!tables.length) {
        skipped.push({
          filename: att.filename, reason: 'ATTACHMENT_UNREADABLE',
          detail: `A file that should hold a report could not be read: ${att.filename}. ` +
                  `It may be corrupted, password-protected, or an old .xls workbook. ` +
                  `Re-send it as .xlsx or .csv.`
        });
        continue;
      }
      const signal = detectInTables(tables, masters, cfg);
      if (!signal.isReport) {
        skipped.push({
          filename: att.filename, reason: 'ATTACHMENT_NOT_A_REPORT',
          detail: `${att.filename}: ${signal.reason}`
        });
        continue;
      }
      docs.push({
        documentId: `gmail:${msg.id}:${att.filename}`,
        subject: `${msg.subject} [${att.filename}]`,
        sender: msg.from, receivedAt: msg.date,
        tables, attachmentName: att.filename,
        // The covering sentence belongs to the attachment too: it is where the
        // department and the reporting day are usually stated.
        contextText
      });
    } catch (e) {
      skipped.push({
        filename: att.filename, reason: 'ATTACHMENT_FAILED',
        detail: `${att.filename}: ${(e as Error).message}`.slice(0, 300)
      });
      await logEvent('WARN', 'Sync', 'attachment', 'WARN',
        `${att.filename}: ${(e as Error).message}`, msg.id);
    }
  }
  // A report can arrive as a link to a Google Sheet instead of a file. Only
  // looked for when nothing else in the message was a report, so a normal
  // report that happens to cite a sheet is not fetched needlessly.
  if (!docs.length) {
    const links = findSheetLinks(msg.html, msg.text).slice(0, MAX_SHEET_LINKS_PER_MESSAGE);
    for (const link of links) {
      const got = await fetchSheet(link);
      if (!got.ok) {
        skipped.push({
          filename: `Google Sheet ${link.id.slice(0, 12)}…`,
          // Named so the outcome reads as "the report is there and we cannot
          // reach it", never as "there was nothing here".
          reason: got.reason === 'NOT_SHARED'
            ? 'GOOGLE_SHEET_ACCESS_REQUIRED' : `SHEET_${got.reason}`,
          detail: got.detail
        });
        continue;
      }
      const tables = got.kind === 'workbook'
        ? await attachmentToTables('sheet.xlsx',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            got.workbook)
        : csvToTables(got.csv, 'sheet.csv');
      if (!tables.length) {
        skipped.push({
          filename: `Google Sheet ${link.id.slice(0, 12)}…`,
          reason: 'SHEET_EMPTY',
          detail: `The Google Sheet at ${link.url} opened but held no rows.`
        });
        continue;
      }
      const signal = detectInTables(tables, masters, cfg);
      if (!signal.isReport) {
        skipped.push({
          filename: `Google Sheet ${link.id.slice(0, 12)}…`,
          reason: 'SHEET_NOT_A_REPORT',
          detail: `${link.url}: ${signal.reason}`
        });
        continue;
      }
      docs.push({
        documentId: `gmail:${msg.id}:sheet:${link.id}${link.gid ? ':' + link.gid : ''}`,
        subject: `${msg.subject} [Google Sheet]`,
        sender: msg.from, receivedAt: msg.date,
        tables, attachmentName: `Google Sheet ${link.id.slice(0, 12)}…`,
        contextText
      });
    }
  }

  return docs;
}

/**
 * Transcribes a picture or a PDF and returns a document only when every check
 * passed. Anything else comes back as a review item naming the check it
 * failed — a partial import from a misread table is the outcome that must not
 * happen, because it looks exactly like a complete one.
 */
async function readByVision(
  att: { filename: string; mimeType: string; attachmentId: string; size: number },
  msg: GmailMessage, accessToken: string,
  masters: Awaited<ReturnType<typeof loadMasters>>,
  cfg: ReturnType<typeof engineConfig>,
  media: string
): Promise<{ doc?: SourceDocument; skipped?: SkippedAttachment }> {
  let buf: Buffer;
  try {
    buf = await getAttachment(accessToken, msg.id, att.attachmentId);
  } catch (e) {
    return { skipped: { filename: att.filename, reason: 'ATTACHMENT_FAILED',
      detail: `${att.filename}: ${(e as Error).message}`.slice(0, 300) } };
  }

  const read = await transcribeTable(buf, media);
  if (!read.ok) {
    return { skipped: { filename: att.filename, reason: 'IMAGE_REVIEW_REQUIRED',
      detail: `A report was detected in ${att.filename} and could not be transcribed. ` +
              read.reason } };
  }

  const verified = verifyVisionTable(read.table, masters);
  if (!verified.ok) {
    return { skipped: { filename: att.filename, reason: 'IMAGE_REVIEW_REQUIRED',
      detail: `A report was detected in ${att.filename} and was not imported. ` +
              verified.reason } };
  }

  const grid = visionTableToRows(verified.table);
  const tables = [{
    index: 0, source: 'text' as const,
    rows: grid.map(r => r.map(text => ({ text, href: '' })))
  }];
  const signal = detectInTables(tables, masters, cfg);
  if (!signal.isReport) {
    return { skipped: { filename: att.filename, reason: 'IMAGE_NOT_A_REPORT',
      detail: `${att.filename} was transcribed but is not a report: ${signal.reason}` } };
  }

  return {
    doc: {
      documentId: `gmail:${msg.id}:${att.filename}`,
      subject: `${msg.subject} [${att.filename}]`,
      sender: msg.from, receivedAt: msg.date,
      tables, attachmentName: att.filename,
      extractionSource: 'vision',
      titleDate: dateFromTitle(verified.table.title) || undefined,
      contextText: verified.table.title || undefined
    }
  };
}

/**
 * An attachment that could not become data is a data-quality event, not a log
 * line. It appears on the Data quality page beside rejected rows, with the
 * filename and a reason the sender can act on.
 */
/**
 * Why a message produced nothing, in terms a manager can act on.
 *
 * The order is deliberate: anything needing a person outranks anything that is
 * merely unsupported, and both outrank "there was nothing here". A message
 * that carried a screenshot AND a newsletter table is a review case, not a
 * newsletter.
 */
function classifyUnprocessed(
  skipped: SkippedAttachment[], bodySignal: { reason: string; confidence: number }
): { classification: MessageClassification; evidence: string } {
  const reasons = skipped.map(s => s.reason);
  const details = skipped.map(s => s.detail).join('; ').slice(0, 500);

  if (reasons.includes('IMAGE_REVIEW_REQUIRED')) {
    return { classification: 'REVIEW_REQUIRED', evidence: details };
  }
  if (reasons.some(r => r === 'GOOGLE_SHEET_ACCESS_REQUIRED' || r === 'SHEET_FAILED')) {
    return { classification: 'REVIEW_REQUIRED', evidence: details };
  }
  if (reasons.includes('ATTACHMENT_FORMAT_UNSUPPORTED')) {
    return { classification: 'UNSUPPORTED_FORMAT', evidence: details };
  }
  // "I read it and it is not a report" is a decision. Only "I could not read
  // it" needs a person. Treating an unrelated budget spreadsheet as a review
  // case fills the queue with noise, and a queue full of noise gets ignored.
  const unreadable = reasons.filter(r =>
    r !== 'ATTACHMENT_NOT_A_REPORT' && r !== 'SHEET_NOT_A_REPORT' && r !== 'SHEET_EMPTY');
  if (unreadable.length) {
    return { classification: 'REVIEW_REQUIRED', evidence: details };
  }
  if (reasons.length) {
    return { classification: 'NON_REPORT', evidence: details };
  }
  // A table was found and its columns were not a report's. That is a decision,
  // not a failure — an invoice reaches here, and so does a newsletter.
  return {
    classification: 'NON_REPORT',
    evidence: bodySignal.reason || 'No table found in the message body'
  };
}

async function recordSkippedAttachments(
  ownerUserId: number, msg: GmailMessage, skipped: SkippedAttachment[]
): Promise<void> {
  for (let i = 0; i < skipped.length; i++) {
    const s = skipped[i];
    await query(
      `insert into data_quality
         (report_id, document_id, table_index, row_index, rejection_reason,
          rejection_detail, raw_row, claimed_date, owner_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,null,$8)
       on conflict (owner_user_id, document_id, table_index, row_index, rejection_reason)
       do nothing`,
      [`GM-${msg.id}`, `gmail:${msg.id}:${s.filename}`, 0, i, s.reason,
       s.detail.slice(0, 500),
       JSON.stringify({ attachment: s.filename, subject: msg.subject, from: msg.from }),
       ownerUserId]
    );
  }
}

/**
 * Messages that need not be read again.
 *
 * Anything that produced data is final — re-reading it could only produce the
 * same rows, which the fingerprints would reject anyway. Anything judged NOT a
 * report is only final while the detector that judged it is current: a newer
 * detector gets one chance to look again at what its predecessor passed over.
 */
async function loadSeenMessageIds(ownerUserId: number): Promise<Set<string>> {
  const rows = await query<{ gmail_message_id: string }>(
    `select distinct gmail_message_id from documents
      where gmail_message_id is not null
        and owner_user_id = $1
        and (processing_status <> 'NO_DATA' or detector_version >= $2)`,
    [ownerUserId, DETECTOR_VERSION]);
  return new Set(rows.map(r => r.gmail_message_id));
}

async function recordNonReport(
  accountId: number, ownerUserId: number, msg: GmailMessage, reason: string,
  classification: MessageClassification = 'NON_REPORT'
): Promise<void> {
  await query(
    `insert into documents (report_id, document_id, source, subject, sender, sender_domain,
       received_at, processing_status, tables_found, rows_extracted, rows_inserted,
       rows_skipped_idempotent, rows_rejected, error_message, gmail_account_id,
       gmail_message_id, owner_user_id, detector_version, classification, evidence)
     values ($1,$2,'email',$3,$4,$5,$6,'NO_DATA',0,0,0,0,0,$7,$8,$9,$10,$11,$12,$13)
     on conflict (owner_user_id, report_id) do update set
       error_message = excluded.error_message,
       processed_at = now(),
       detector_version = excluded.detector_version,
       classification = excluded.classification,
       evidence = excluded.evidence`,
    [`GM-${msg.id}`, `gmail:${msg.id}`, msg.subject.slice(0, 300), msg.from,
     senderDomain(msg.from), msg.date, reason, accountId, msg.id, ownerUserId,
     DETECTOR_VERSION, classification, reason.slice(0, 500)]
  );
}

async function upsertGmailDocument(
  accountId: number, ownerUserId: number, msg: GmailMessage, doc: SourceDocument,
  reportId: string, status: string, tablesFound: number, rowsExtracted: number,
  rowsInserted: number, rowsSkipped: number, rowsRejected: number,
  confidence = 0.9, evidence = '', departments: string[] = []
): Promise<void> {
  await query(
    `insert into documents (report_id, document_id, source, subject, sender, sender_domain,
       received_at, processing_status, tables_found, rows_extracted, rows_inserted,
       rows_skipped_idempotent, rows_rejected, gmail_account_id, gmail_message_id,
       attachment_name, owner_user_id, detector_version, classification, confidence,
       evidence, departments_count, departments_list, processed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23, now())
     on conflict (owner_user_id, report_id) do update set
       processing_status = excluded.processing_status,
       classification = excluded.classification,
       confidence = excluded.confidence,
       detector_version = excluded.detector_version,
       departments_count = excluded.departments_count,
       departments_list = excluded.departments_list,
       tables_found = excluded.tables_found,
       rows_extracted = excluded.rows_extracted,
       rows_inserted = greatest(documents.rows_inserted, excluded.rows_inserted),
       rows_skipped_idempotent = excluded.rows_skipped_idempotent,
       rows_rejected = excluded.rows_rejected,
       processed_at = now()`,
    [reportId, doc.documentId, doc.attachmentName ? 'attachment' : 'email',
     doc.subject.slice(0, 300), msg.from, senderDomain(msg.from), msg.date, status,
     tablesFound, rowsExtracted, rowsInserted, rowsSkipped, rowsRejected,
     accountId, msg.id, doc.attachmentName || null, ownerUserId,
     DETECTOR_VERSION,
     // A report that produced rows is a report; one that produced none because
     // every row failed validation is worth a person's attention.
     rowsInserted > 0 ? 'DEPARTMENTAL_REPORT'
       : rowsRejected > 0 ? 'REVIEW_REQUIRED' : 'POSSIBLE_REPORT',
     confidence,
     evidence.slice(0, 500),
     departments.length,
     departments.length ? departments.join(', ').slice(0, 300) : null]
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
  // Plans are excluded here for the same reason they are excluded from the
  // dashboard: work nobody has started cannot be a repeated duty and cannot
  // have run slowly.
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
}
