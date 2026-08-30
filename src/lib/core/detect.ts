/**
 * Automatic report detection — content-based, not label-based.
 *
 * The product requirement is that the manager connects their inbox and the
 * assistant works out which messages are reports. No labels, no filters, no
 * forwarding. So detection asks one question only:
 *
 *     does this message contain a table whose columns map to
 *     Date / Employee / Task / Status?
 *
 * That is the same header mapping the importer uses, which means detection can
 * never disagree with import: if we say it is a report, it will parse.
 *
 * Everything else — subject wording, sender, attachment names — is used only to
 * ORDER candidates and to explain the decision, never to reject one. A report
 * titled "hi" from an unknown address still counts if it contains the table.
 */
import type { EngineConfig, Masters, Table } from './types';
import { extractPipeTables, extractTables, mapHeaderRow } from './html-table';

/**
 * Bumped whenever this module learns to recognise something it previously
 * could not. Messages rejected by an older version are re-examined once, so an
 * improvement reaches the mail that was already in the mailbox rather than
 * only the mail that arrives next.
 *
 *   1  body tables and parsable attachments
 *   2  Google Sheets links followed via their CSV export
 */
export const DETECTOR_VERSION = 2;

export interface DetectionSignal {
  isReport: boolean;
  reason: string;
  tables: Table[];
  /** Index of the first table that mapped, for diagnostics. */
  mappedTableIndex: number;
  confidence: 'high' | 'medium' | 'none';
}

const SUBJECT_HINTS = [
  'daily report', 'department report', 'eod', 'end of day', 'work report',
  'status report', 'progress report', 'daily update', 'dsr', 'mis'
];

export function subjectLooksLikeReport(subject: string): boolean {
  const s = (subject || '').toLowerCase();
  return SUBJECT_HINTS.some(h => s.includes(h));
}

/**
 * Runs the real header mapper over every table found in the body.
 * Returns the tables so the caller does not have to parse twice.
 */
export function detectInBody(
  html: string, text: string, masters: Masters, cfg: EngineConfig
): DetectionSignal {
  let tables = html ? extractTables(html) : [];
  if (!tables.length) tables = extractPipeTables(text || '');

  for (let i = 0; i < tables.length; i++) {
    const header = mapHeaderRow(tables[i].rows, masters, cfg);
    if (header) {
      const dataRows = tables[i].rows.length - header.headerRowIndex - 1;
      return {
        isReport: dataRows > 0,
        reason: dataRows > 0
          ? `Table ${i + 1} has Date/Employee/Task/Status columns and ${dataRows} data row(s)`
          : `Table ${i + 1} has report headers but no data rows`,
        tables,
        mappedTableIndex: i,
        confidence: header.partialHeader ? 'medium' : 'high'
      };
    }
  }
  return {
    isReport: false,
    reason: tables.length
      ? `${tables.length} table(s) found, none with recognisable Date/Employee/Task/Status columns`
      : 'No table found in the message body',
    tables,
    mappedTableIndex: -1,
    confidence: 'none'
  };
}

/** Same question, asked of tables that came out of an attachment. */
export function detectInTables(
  tables: Table[], masters: Masters, cfg: EngineConfig
): DetectionSignal {
  for (let i = 0; i < tables.length; i++) {
    const header = mapHeaderRow(tables[i].rows, masters, cfg);
    if (header) {
      const dataRows = tables[i].rows.length - header.headerRowIndex - 1;
      if (dataRows > 0) {
        return {
          isReport: true,
          reason: `Sheet ${i + 1} has Date/Employee/Task/Status columns and ${dataRows} data row(s)`,
          tables, mappedTableIndex: i,
          confidence: header.partialHeader ? 'medium' : 'high'
        };
      }
    }
  }
  return {
    isReport: false,
    reason: tables.length
      ? `${tables.length} sheet(s), none with recognisable report columns`
      : 'Attachment contained no table',
    tables, mappedTableIndex: -1, confidence: 'none'
  };
}

/**
 * The Gmail search used to shortlist candidates.
 *
 * Deliberately broad: narrowing here is how a real report gets silently
 * skipped. It excludes only categories that cannot contain a team report, and
 * bounds the window so connecting an old mailbox does not pull in years of
 * history. Everything surviving this is judged on its content.
 */
export function buildGmailQuery(sinceDate: string, extra = ''): string {
  const since = sinceDate.replace(/-/g, '/');
  return [
    `after:${since}`,
    '-in:chats',
    '-in:drafts',
    '-category:promotions',
    '-category:social',
    '-category:forums',
    extra
  ].filter(Boolean).join(' ');
}
