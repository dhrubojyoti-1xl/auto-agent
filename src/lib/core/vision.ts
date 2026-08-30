/**
 * Reading a report that arrived as a picture.
 *
 * Refusing images outright was the right default and the wrong answer for this
 * input: a rendered table screenshotted at full resolution is not a photograph
 * of a whiteboard, and a client whose reporting format is a pasted screenshot
 * is not going to change it because the software finds it inconvenient.
 *
 * What makes this safe is not trusting the model. It is that the model is
 * asked for things that can be checked against each other, and any
 * disagreement throws the whole report away rather than importing part of it:
 *
 *   - it declares how many rows and columns it saw, and the declaration is
 *     checked against what it actually returned
 *   - every row must have the header's column count
 *   - every cell carries a confidence, and one weak cell fails the report
 *   - every status must already be in this tenant's vocabulary
 *
 * A partial import is the dangerous outcome, because it looks like a complete
 * one. Either the whole table survives every check or the report goes to
 * review naming the check it failed.
 */
import type { Masters } from './types';
import { normalizeStatus } from './normalize';
import { statusIsAmbiguous, statusMeansPlanned } from './semantic-headers';

/**
 * Whether the ingest layer could make anything of this status.
 *
 * The vision gate must reject exactly the statuses ingest would reject and no
 * others. A stricter gate here would mean the same report imports as a
 * spreadsheet and goes to review as a picture, which is the sort of
 * inconsistency that makes a product feel arbitrary.
 */
function statusIsResolvable(raw: string, masters: Masters): boolean {
  return !!normalizeStatus(raw, masters) || statusMeansPlanned(raw) || statusIsAmbiguous(raw);
}

/** Below this, a cell is not worth importing into a management figure. */
export const MIN_CELL_CONFIDENCE = 0.75;

export interface VisionCell { text: string; confidence: number }

export interface VisionTable {
  /** What the model says it saw, checked against what it returned. */
  declaredRows: number;
  declaredColumns: number;
  title: string;
  headers: string[];
  rows: VisionCell[][];
}

export type VisionResult =
  | { ok: true; table: VisionTable; lowestConfidence: number }
  | { ok: false; reason: string };

/**
 * The schema the model must answer in. Structured output rather than prompt
 * instructions, so a malformed answer is impossible rather than merely
 * discouraged.
 */
export const VISION_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['declared_rows', 'declared_columns', 'title', 'headers', 'rows'],
    properties: {
      declared_rows: {
        type: 'integer',
        description: 'How many DATA rows the table has, excluding the header and any title.'
      },
      declared_columns: {
        type: 'integer',
        description: 'How many columns the header row has.'
      },
      title: {
        type: 'string',
        description:
          'Any title or caption line ABOVE the header row, verbatim and complete. ' +
          'Empty string if there is none. Do not put a column heading here.'
      },
      headers: {
        type: 'array', items: { type: 'string' },
        description: 'The header row, left to right, verbatim.'
      },
      rows: {
        type: 'array',
        description: 'Data rows in order, each the same length as headers.',
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'confidence'],
            properties: {
              text: { type: 'string', description: 'The cell, verbatim. Empty string if blank.' },
              confidence: {
                type: 'number',
                description:
                  'How clearly this cell was legible, 0 to 1. Be honest: a low score sends ' +
                  'the report for human review, which is the correct outcome for a cell ' +
                  'you had to infer. Never guess a value to raise it.'
              }
            }
          }
        }
      }
    }
  }
} as const;

export const VISION_SYSTEM_PROMPT = `You transcribe a table from an image. You do not interpret, summarise, correct or complete it.

Rules:
- Transcribe every cell exactly as printed, including spacing and punctuation.
- Never infer a value that is not legible. Give it a low confidence instead.
- Never add, merge, split, reorder or omit a row or a column.
- A title or caption line above the header goes in "title", never in "headers".
- If the image contains no table, return declared_rows 0 and empty arrays.

Your transcription is checked against your own declared row and column counts. Disagreement discards the whole report, so an accurate count matters as much as accurate cells.`;

/**
 * Every check the transcription has to survive.
 *
 * Deliberately returns the first failure with the numbers involved, because
 * "went to review" without a reason is the outcome that wastes a person's
 * afternoon.
 */
export function verifyVisionTable(
  table: VisionTable, masters: Masters,
  opts: { minConfidence?: number } = {}
): VisionResult {
  const minConfidence = opts.minConfidence ?? MIN_CELL_CONFIDENCE;

  if (!table.headers.length || !table.rows.length) {
    return { ok: false, reason: 'No table was found in the image.' };
  }
  if (table.declaredRows !== table.rows.length) {
    return {
      ok: false,
      reason: `The image was read as ${table.declaredRows} row(s) but ` +
              `${table.rows.length} came back. The whole report is held for review ` +
              `rather than importing part of a table.`
    };
  }
  if (table.declaredColumns !== table.headers.length) {
    return {
      ok: false,
      reason: `The image was read as ${table.declaredColumns} column(s) but the header ` +
              `has ${table.headers.length}.`
    };
  }

  for (let r = 0; r < table.rows.length; r++) {
    if (table.rows[r].length !== table.headers.length) {
      return {
        ok: false,
        reason: `Row ${r + 1} has ${table.rows[r].length} cell(s) against ` +
                `${table.headers.length} column(s) in the header.`
      };
    }
  }

  let lowest = 1;
  for (let r = 0; r < table.rows.length; r++) {
    for (let c = 0; c < table.rows[r].length; c++) {
      const cell = table.rows[r][c];
      if (cell.confidence < lowest) lowest = cell.confidence;
      if (cell.confidence < minConfidence) {
        return {
          ok: false,
          reason: `A cell could not be read clearly enough to trust: row ${r + 1}, ` +
                  `column "${table.headers[c] || c + 1}" at ${Math.round(cell.confidence * 100)}% ` +
                  `confidence. The whole report is held for review.`
        };
      }
    }
  }

  // A status the tenant has never used is the strongest signal that a cell was
  // misread — the vocabulary is small and closed, so an unfamiliar value is far
  // more likely a transcription error than a new word.
  const statusColumn = table.headers.findIndex(h => /status|state|progress/i.test(h));
  if (statusColumn >= 0) {
    for (let r = 0; r < table.rows.length; r++) {
      const raw = (table.rows[r][statusColumn]?.text || '').trim();
      if (!raw) continue;
      if (!statusIsResolvable(raw, masters)) {
        return {
          ok: false,
          reason: `Row ${r + 1} has a status this organisation has never used: ` +
                  `"${raw}". That is more likely a misread cell than a new status, ` +
                  `so the whole report is held for review.`
        };
      }
    }
  }

  return { ok: true, table, lowestConfidence: lowest };
}

/**
 * A title line stating the day the report covers.
 *
 * Case: "DAILY WORK UPDATE — 30 AUGUST 2026". Returned with the phrase it came
 * from, so a date that was never written in a cell is inspectable as an
 * inference rather than presented as data.
 */
export function dateFromTitle(title: string): { date: string; quote: string } | null {
  if (!title) return null;
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
                  'august', 'september', 'october', 'november', 'december'];
  const m = title.match(
    /(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})|([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})|(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;

  let y: number, mo: number, d: number;
  if (m[7]) { y = +m[7]; mo = +m[8]; d = +m[9]; }
  else if (m[1]) {
    d = +m[1]; y = +m[3];
    mo = MONTHS.findIndex(x => x.startsWith(m[2].toLowerCase().slice(0, 3))) + 1;
  } else {
    d = +m[5]; y = +m[6];
    mo = MONTHS.findIndex(x => x.startsWith(m[4].toLowerCase().slice(0, 3))) + 1;
  }
  if (!mo || mo > 12 || !d || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { date: iso, quote: title.trim().slice(0, 120) };
}

/**
 * The transcription as the ordinary table shape, once it has passed every check.
 *
 * A model asked to separate a title from a header row does not always manage
 * it: a merged banner cell spanning the table can come back as the header,
 * pushing the real headings down into the first data row. Rather than fail
 * detection on that, the header row is dropped back into the grid when it
 * plainly is not one — the downstream mapper scans the first several rows for
 * a header anyway, so it will find the real one.
 */
export function visionTableToRows(table: VisionTable): string[][] {
  const body = table.rows.map(r => r.map(c => c.text));
  const width = Math.max(...body.map(r => r.length), 0);
  const headerCells = table.headers.filter(h => h.trim()).length;

  // One heading over a table several columns wide is a banner, not a header.
  if (width > 1 && headerCells <= 1) return body;

  return [table.headers, ...body];
}
