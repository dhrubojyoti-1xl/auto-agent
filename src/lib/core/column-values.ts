/**
 * Deciding what a column is from what is in it.
 *
 * A heading is one signal and often the weakest: "What Was Done Today" scores
 * two weak words and maps to nothing, while the column beneath it is plainly
 * free-text work descriptions. Reading the values generalises where a word
 * list cannot, because it does not depend on anyone having anticipated the
 * wording.
 *
 * Three properties do most of the work, and none of them needs a vocabulary:
 *
 *   shape        do the values parse as dates, match the status vocabulary,
 *                look like personal names, or read as free text
 *   cardinality  an employee column repeats — a handful of names across many
 *                rows; a task column is close to unique
 *   fill         a column that is mostly empty is evidence of nothing
 *
 * Everything returns a confidence, and a column that convinces nothing is left
 * unmapped. An unmapped column produces a row-level rejection with a reason; a
 * wrongly mapped one corrupts data silently.
 */
import type { EngineConfig, Field, Masters } from './types';
import { cleanWhitespace, normalizeStatus, parseDate } from './normalize';
import { statusIsAmbiguous, statusMeansPlanned } from './semantic-headers';

/**
 * Anything the ingest layer could make a status of. Using a narrower test here
 * makes a column fragile: a report with two "Planned" rows out of eight would
 * stop looking like a status column for no reason a person would accept.
 */
function looksLikeStatus(v: string, masters: Masters): boolean {
  return !!normalizeStatus(v, masters) || statusMeansPlanned(v) || statusIsAmbiguous(v);
}

export interface ValueProfile {
  filled: number;
  total: number;
  distinct: number;
  /** distinct / filled — 1 means every value differs. */
  uniqueness: number;
  dateRate: number;
  statusRate: number;
  personRate: number;
  numericRate: number;
  urlRate: number;
  meanWords: number;
}

/**
 * Two or three capitalised words, no digits, no @ — "Ada Lovelace",
 * "Lovelace, Ada". Deliberately conservative: an initial-capital single word
 * is far more often a status or a category than a person.
 */
const PERSON = /^[A-Z][a-z'’-]+(?:[ ,]+[A-Z][a-z'’.-]+){1,3}$/;

export function profileColumn(
  values: string[], masters: Masters, cfg: EngineConfig
): ValueProfile {
  const cleaned = values.map(v => cleanWhitespace(v));
  const filled = cleaned.filter(Boolean);
  const distinct = new Set(filled.map(v => v.toLowerCase())).size;

  let dates = 0, statuses = 0, people = 0, numbers = 0, urls = 0, words = 0;
  for (const v of filled) {
    if (parseDate(v, cfg.dateOrder)) dates++;
    if (looksLikeStatus(v, masters)) statuses++;
    if (PERSON.test(v)) people++;
    if (/^-?[\d.,%]+$/.test(v)) numbers++;
    if (/^https?:\/\//i.test(v)) urls++;
    words += v.split(/\s+/).length;
  }
  const n = filled.length || 1;
  return {
    filled: filled.length, total: cleaned.length, distinct,
    uniqueness: filled.length ? distinct / filled.length : 0,
    dateRate: dates / n, statusRate: statuses / n, personRate: people / n,
    numericRate: numbers / n, urlRate: urls / n, meanWords: words / n
  };
}

export interface ValueGuess {
  field: Field;
  confidence: number;
  evidence: string;
}

/** Below this a column's values have not made a case. */
export const VALUE_CONFIDENCE_FLOOR = 0.6;

/**
 * What a column's values suggest it is, or nothing.
 *
 * Order matters: the tests that can be wrong in only one direction come first.
 * A column of parsable dates is a date column whatever it is called; a column
 * whose every value is in the status vocabulary is a status column. Employee
 * and task are separated by repetition rather than by content, because both
 * are free text.
 */
export function fieldFromValues(
  values: string[], masters: Masters, cfg: EngineConfig
): ValueGuess | null {
  const p = profileColumn(values, masters, cfg);

  // Too little to judge. Three filled values is the minimum at which
  // repetition means anything at all.
  if (p.filled < 3 || p.filled / Math.max(p.total, 1) < 0.5) return null;

  if (p.dateRate >= 0.8) {
    return { field: 'date', confidence: Math.min(0.95, p.dateRate),
             evidence: `${Math.round(p.dateRate * 100)}% of values parse as dates` };
  }
  if (p.statusRate >= 0.8) {
    return { field: 'status', confidence: Math.min(0.95, p.statusRate),
             evidence: `${Math.round(p.statusRate * 100)}% of values are known statuses` };
  }
  if (p.urlRate >= 0.8) {
    return { field: 'link', confidence: 0.9,
             evidence: `${Math.round(p.urlRate * 100)}% of values are links` };
  }
  // A person column repeats: a handful of names over many rows. The ceiling on
  // uniqueness is what separates it from a task column of free text.
  if (p.personRate >= 0.7 && p.uniqueness <= 0.8 && p.meanWords <= 4) {
    return { field: 'employee', confidence: Math.min(0.9, p.personRate),
             evidence: `${Math.round(p.personRate * 100)}% look like names, ` +
                       `${p.distinct} distinct across ${p.filled} rows` };
  }
  // Free text that rarely repeats and is not a number: the work itself.
  if (p.uniqueness >= 0.7 && p.meanWords >= 2 && p.numericRate < 0.3 &&
      p.statusRate < 0.3 && p.dateRate < 0.3) {
    return { field: 'task', confidence: 0.7,
             evidence: `free text, ${p.distinct} distinct across ${p.filled} rows, ` +
                       `${p.meanWords.toFixed(1)} words on average` };
  }
  return null;
}

/**
 * A column whose values repeat a small set of short labels that are not
 * statuses — the shape of a department or category column. Reported separately
 * because it cannot distinguish the two on values alone, and guessing between
 * them is worse than leaving the heading to decide.
 */
export function looksCategorical(values: string[], masters: Masters, cfg: EngineConfig): boolean {
  const p = profileColumn(values, masters, cfg);
  return p.filled >= 3 && p.uniqueness <= 0.5 && p.meanWords <= 3 &&
         p.statusRate < 0.3 && p.dateRate < 0.3 && p.numericRate < 0.3;
}

/**
 * A heading that is suggestive but not conclusive, confirmed by the column
 * beneath it.
 *
 * This is what lets the mapper generalise without a list. "Section" is weakly
 * a department and nothing else; on its own that is not enough, because a
 * single weak word is how a column gets filed under the wrong field. But a
 * weakly-suggested field whose values look the part is a different matter —
 * the heading proposes and the values confirm, and neither has to be certain
 * alone.
 *
 * The two must agree. A heading that hints at one field over values that look
 * like another is exactly the case to leave unmapped.
 */
export function confirmWeakHeader(
  weakField: Field, values: string[], masters: Masters, cfg: EngineConfig
): ValueGuess | null {
  const byValues = fieldFromValues(values, masters, cfg);
  if (byValues && byValues.field === weakField) {
    return {
      field: weakField,
      confidence: Math.min(0.9, byValues.confidence + 0.1),
      evidence: `heading suggests ${weakField}; ${byValues.evidence}`
    };
  }
  // Department and category are the two fields values cannot tell apart —
  // both are short repeating labels — so the heading is allowed to decide
  // between them once the shape is right.
  if (!byValues && (weakField === 'department' || weakField === 'category') &&
      looksCategorical(values, masters, cfg)) {
    return {
      field: weakField, confidence: 0.7,
      evidence: `heading suggests ${weakField}; values are a small repeating set of labels`
    };
  }
  return null;
}
