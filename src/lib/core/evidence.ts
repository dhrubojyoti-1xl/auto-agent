/**
 * Reading the parts of a report that are not in the table.
 *
 * A department mails a spreadsheet with a covering line — "Sales team update
 * for yesterday" — and everything that identifies the report lives in that
 * sentence while the tasks live in the attachment. Treating the two as
 * unrelated documents throws away the only evidence of which department it is
 * and which day it covers, and the spreadsheet's own columns rarely repeat it,
 * because the sender already said it.
 *
 * Everything here is evidence, weighed and reported with its source. Nothing
 * is invented: a body that says nothing produces no answer, and the caller
 * falls back to refusing the row rather than filing it under a guess.
 */
import type { EngineConfig, Masters } from './types';
import { addDays, findDepartmentInText, parseDate } from './normalize';

export type DepartmentSource =
  | 'row' | 'subject' | 'body' | 'attachment name' | 'sheet name' | 'sender' | 'employee';

export interface DepartmentEvidence {
  department: string;
  source: DepartmentSource;
  confidence: number;
}

/**
 * Where a department may be stated, strongest first.
 *
 * A row column beats everything, because it is the sender being explicit about
 * that row. Then the covering sentence, then the subject, then the file or
 * sheet name, then the sender's domain — each a weaker claim than the last,
 * and each only ever matched against departments that already exist, so a
 * subject reading "Fwd:" can never invent a department called Fwd.
 */
export function departmentFromEvidence(
  ev: { subject?: string; body?: string; attachmentName?: string; sheetName?: string },
  masters: Masters, cfg: EngineConfig
): DepartmentEvidence | null {
  const candidates: [string, DepartmentSource, number][] = [
    [ev.body || '', 'body', 0.85],
    [ev.subject || '', 'subject', 0.8],
    [ev.attachmentName || '', 'attachment name', 0.7],
    [ev.sheetName || '', 'sheet name', 0.7]
  ];
  for (const [text, source, confidence] of candidates) {
    if (!text) continue;
    const found = findDepartmentInText(text, masters, cfg);
    if (found) return { department: found, source, confidence };
  }
  return null;
}

export type DateBasis =
  | 'row' | 'stated in body' | 'relative to send date' | 'stated in subject';

export interface DateEvidence {
  date: string;
  basis: DateBasis;
  confidence: number;
  /** The words the date was read from, so the decision can be explained. */
  quote: string;
}

/**
 * Phrases that place a report relative to the day it was sent.
 *
 * Deliberately narrow. "Yesterday's update" is a clear statement about which
 * day the work happened; a passing mention of the word "yesterday" in a
 * sentence about something else is not, so the phrase has to look like a
 * report heading rather than prose.
 */
const RELATIVE: [RegExp, number, string][] = [
  [/\b(yesterday'?s?\s+(work|update|report|activit\w*|task\w*)|work\s+done\s+yesterday|report\s+for\s+yesterday|update\s+for\s+yesterday)\b/i, -1, 'yesterday'],
  [/\b(today'?s?\s+(work|update|report|activit\w*|task\w*)|work\s+done\s+today|report\s+for\s+today|update\s+for\s+today|daily\s+report\s+for\s+today)\b/i, 0, 'today'],
  [/\b(tomorrow'?s?\s+(plan|work|report|activit\w*|task\w*))\b/i, 1, 'tomorrow']
];

/** Dates written out in a covering line: "for 29 Aug", "dated 2026-08-29". */
const EXPLICIT =
  /\b(?:for|dated|dt|date|of|on)\s*[:\-]?\s*(\d{1,2}[-/ ][A-Za-z]{3,9}[-/ ]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/;

/**
 * The day a report is about, when the rows themselves do not say.
 *
 * The arrival date is never used on its own: a report sent on Monday about
 * Friday's work is not Monday's work, and quietly stamping it with the send
 * date is how a dashboard reports activity on days nobody worked. Only an
 * explicit statement counts, and what it was read from is recorded.
 */
export function inferReportDate(
  ev: { subject?: string; body?: string; receivedAt: string },
  cfg: EngineConfig
): DateEvidence | null {
  const received = (ev.receivedAt || '').slice(0, 10);
  if (!received) return null;

  for (const [where, text, basis, confidence] of [
    ['body', ev.body || '', 'stated in body' as DateBasis, 0.85],
    ['subject', ev.subject || '', 'stated in subject' as DateBasis, 0.8]
  ] as const) {
    if (!text) continue;

    const explicit = text.match(EXPLICIT);
    if (explicit) {
      const parsed = parseDate(explicit[1], cfg.dateOrder);
      if (parsed) {
        return { date: parsed, basis, confidence, quote: explicit[0].trim() };
      }
    }

    for (const [re, offset, word] of RELATIVE) {
      const m = text.match(re);
      if (!m) continue;
      // A plan is not a date this function should supply — the caller decides
      // what to do with future work, and dating it as though it happened is
      // exactly the mistake to avoid.
      if (offset > 0) continue;
      return {
        date: addDays(received, offset),
        basis: 'relative to send date',
        confidence: 0.8,
        quote: `${m[0].trim()} (${word}, sent ${received})`
      };
    }
    void where;
  }
  return null;
}

/**
 * True when the covering text describes work that has not happened yet, so the
 * caller can mark it planned rather than counting it as done.
 */
export function contextLooksPlanned(text: string): boolean {
  return /\b(tomorrow'?s?\s+(plan|work|task\w*)|plan\s+for\s+tomorrow|next\s+day\s+plan|upcoming\s+(work|task\w*))\b/i
    .test(text || '');
}
