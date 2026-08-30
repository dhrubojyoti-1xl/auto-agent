/**
 * Normalisation — a faithful TypeScript port of the Apps Script `Masters`
 * layer and the date/time/task helpers.
 *
 * Deliberately conservative: it removes noise (case, punctuation, filler,
 * instance numbers) but never merges two genuinely different tasks, and never
 * guesses a value it was not given.
 */
import type {
  Category, Department, Employee, EngineConfig, Field, Masters, TaskStatus
} from './types';
import { STATUSES } from './types';

/* --------------------------------------------------------------------------
 * Strings
 * ------------------------------------------------------------------------ */

export function cleanWhitespace(s: unknown): string {
  return String(s ?? '')
    .replace(/ /g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function decodeEntities(s: string): string {
  if (!s) return '';
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'").replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '...')
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)));
}

/** Lowercase, punctuation-free key used for every master-data lookup. */
export function keyify(s: unknown): string {
  return cleanWhitespace(decodeEntities(String(s ?? '')))
    .toLowerCase()
    .replace(/[.’']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function titleCase(s: string): string {
  return String(s || '').toLowerCase()
    .replace(/\b([a-z])/g, m => m.toUpperCase())
    .replace(/\b(Of|And|The|To|For)\b/g, m => m.toLowerCase())
    .replace(/^./, m => m.toUpperCase());
}

export function splitList(v: unknown): string[] {
  return String(v ?? '').split(/[,;|]/).map(x => x.trim()).filter(Boolean);
}

/* --------------------------------------------------------------------------
 * Dates and times — business dates, never timestamps
 * ------------------------------------------------------------------------ */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

function pad2(n: number): string { return (n < 10 ? '0' : '') + n; }
function fixYear(y: number): number { return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y; }

/** Builds a yyyy-mm-dd string, or null when the date is not real. */
function mkDate(y: number, mo: number, d: number): string | null {
  if (y < 2000 || y > 2100 || mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
  return y + '-' + pad2(mo + 1) + '-' + pad2(d);
}

/**
 * Tolerant date parser. Returns a yyyy-mm-dd STRING, never a Date, so a
 * business date can never be shifted by a timezone conversion on its way to
 * or from the database. That bug is the classic way these dashboards go wrong.
 */
export function parseDate(v: unknown, dateOrder: 'DMY' | 'MDY' = 'DMY'): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return mkDate(v.getFullYear(), v.getMonth(), v.getDate());
  }
  let s = cleanWhitespace(String(v)).replace(/^[\[(]|[\])]$/g, '');
  if (!s) return null;
  s = s.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/);
  if (m) return mkDate(+m[1], +m[2] - 1, +m[3]);

  m = s.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.,]+(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    return mkDate(fixYear(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]);
  }
  m = s.match(/^([A-Za-z]{3,9})[\s\-/.]+(\d{1,2})[\s\-/.,]+(\d{2,4})$/);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    return mkDate(fixYear(+m[3]), MONTHS[m[1].toLowerCase()], +m[2]);
  }
  m = s.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})$/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    return mkDate(new Date().getFullYear(), MONTHS[m[2].toLowerCase()], +m[1]);
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = fixYear(+m[3]);
    let day: number, mon: number;
    if (a > 12 && b <= 12) { day = a; mon = b; }
    else if (b > 12 && a <= 12) { day = b; mon = a; }
    else if (dateOrder === 'MDY') { mon = a; day = b; }
    else { day = a; mon = b; }
    return mkDate(y, mon - 1, day);
  }
  return null;
}

/** "HH:mm" or null. Accepts 9:30, 09:30, 9.30, 9:30 AM, 2130. */
export function parseTime(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    return pad2(v.getHours()) + ':' + pad2(v.getMinutes());
  }
  const s = cleanWhitespace(String(v)).toUpperCase();
  const m = s.match(/^(\d{1,2})[:.\s]?(\d{2})?\s*(AM|PM)?$/);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return pad2(h) + ':' + pad2(mi);
}

/** Hours from "2", "2h", "90 min", "2:30", "1h30m". null when unstated. */
export function parseHours(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = cleanWhitespace(String(v)).toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)?$/);
  if (m) return parseFloat(m[1]);
  m = s.match(/^(\d+)\s*(m|min|mins|minutes)$/);
  if (m) return Math.round((parseFloat(m[1]) / 60) * 100) / 100;
  m = s.match(/^(\d+)\s*:\s*(\d{1,2})$/);
  if (m) return Math.round((parseInt(m[1], 10) + parseInt(m[2], 10) / 60) * 100) / 100;
  m = s.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs)\s*(\d+)\s*(m|min|mins)$/);
  if (m) return Math.round((parseFloat(m[1]) + parseFloat(m[3]) / 60) * 100) / 100;
  return null;
}

/* ---- date-string arithmetic (no Date objects, no timezone drift) -------- */

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export function weekStartOf(iso: string, weekStart: 'MONDAY' | 'SUNDAY' = 'MONDAY'): string {
  const dow = new Date(iso + 'T00:00:00Z').getUTCDay();      // 0 = Sunday
  const target = weekStart === 'SUNDAY' ? 0 : 1;
  let diff = dow - target;
  if (diff < 0) diff += 7;
  return addDays(iso, -diff);
}

export function monthStartOf(iso: string): string { return iso.slice(0, 8) + '01'; }

export function monthLabel(iso: string): string {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [y, m] = iso.split('-').map(Number);
  return `${y}-${pad2(m)} (${M[m - 1]} ${y})`;
}

/** Percentage to one decimal. 0 when the denominator is 0. */
export function pct(num: number, den: number): number {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
}

/** Percentage-POINT change. 80 -> 85 is +5. Never call this a "% change". */
export function ppChange(current: number, previous: number): number {
  return Math.round((current - previous) * 10) / 10;
}

/* --------------------------------------------------------------------------
 * Task normalisation and similarity
 * ------------------------------------------------------------------------ */

const TASK_STOPWORDS = new Set([
  'the','a','an','of','for','to','and','on','in','at','with',
  'today','todays','daily','pls','please','done'
]);

export function normalizeTask(raw: unknown): string {
  return cleanWhitespace(decodeEntities(String(raw ?? '')))
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[‘’“”]/g, '')
    .replace(/[^a-z0-9%\s]+/g, ' ')
    .replace(/\b\d{1,4}\b/g, ' ')          // instance numbers, dates
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Light suffix stemming. Deliberately conservative — it folds the inflections
 * that actually appear in task text ("updating"/"updated"/"updates" ->
 * "update", "reports" -> "report") and nothing more. A full stemmer would
 * merge words that mean different things, which matters here because merging
 * two genuinely different tasks silently misreports someone's work.
 */
export function stemToken(t: string): string {
  if (t.length <= 4) return t;
  let base = t;
  for (const [suffix, min] of [['ing', 5], ['ies', 5], ['ed', 4], ['es', 4], ['s', 4]] as const) {
    if (t.endsWith(suffix) && t.length > min) {
      base = t.slice(0, -suffix.length);
      if (suffix === 'ies') base += 'y';
      // Doubled-consonant reduction applies to -ing/-ed only ("planned" ->
      // "plan"). Applying it after a plural -s turns "calls" into "cal" while
      // "call" stays "call", so the two stop matching.
      if ((suffix === 'ing' || suffix === 'ed') && base.length > 3 &&
          base[base.length - 1] === base[base.length - 2]) {
        base = base.slice(0, -1);
      }
      break;
    }
  }
  // Drop a trailing "e" from every stem so the inflected and base forms meet:
  // "update" -> "updat" and "updating" -> "updat" must agree, or the two are
  // treated as unrelated work.
  if (base.length > 3 && base.endsWith('e')) base = base.slice(0, -1);
  return base;
}

export function taskTokens(normalized: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  normalized.split(' ').forEach(raw => {
    if (!raw || TASK_STOPWORDS.has(raw) || raw.length < 2) return;
    const t = stemToken(raw);
    if (!t || TASK_STOPWORDS.has(t)) return;
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  });
  return out.sort();
}

/** Jaccard similarity, 0..1. Deterministic — no AI, no embeddings. */
export function tokenSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter(t => setB.has(t)).length;
  return inter / (a.length + b.length - inter);
}

/**
 * Containment: is every meaningful word of the shorter task present in the
 * longer one? "Update website" vs "Update website content" is the same
 * recurring job described with more detail, but Jaccard scores it 0.67 and
 * misses it.
 *
 * Guarded so it cannot over-merge:
 *   - the shorter task must carry at least two meaningful words, so a
 *     one-word task like "Reporting" does not swallow everything containing it
 *   - the longer task may add at most two words, so "Client call" does not
 *     absorb "Client call escalation follow up with legal"
 * "Update website" vs "Update CRM" is not a subset either way, so it is
 * untouched.
 */
export function tokenContainment(a: string[], b: string[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 2) return false;
  if (long.length - short.length > 2) return false;
  const set = new Set(long);
  return short.every(t => set.has(t));
}

/** The similarity decision used by repeat detection. */
export function tasksAreSimilar(a: string[], b: string[], threshold: number): boolean {
  return tokenSimilarity(a, b) >= threshold || tokenContainment(a, b);
}

/* --------------------------------------------------------------------------
 * Master-data resolution
 * ------------------------------------------------------------------------ */

export function buildStatusIndex(masters: Masters): Record<string, string> {
  const idx: Record<string, string> = {};
  STATUSES.forEach(s => { idx[keyify(s)] = s; });
  Object.keys(masters.statusAliases).forEach(a => { idx[keyify(a)] = masters.statusAliases[a]; });
  return idx;
}

export function normalizeStatus(raw: unknown, masters: Masters): TaskStatus | null {
  const idx = buildStatusIndex(masters);
  const k = keyify(raw);
  if (!k) return null;
  if (idx[k]) return idx[k] as TaskStatus;
  const k2 = k.replace(/\b(task|status|is|was)\b/g, '').replace(/\s{2,}/g, ' ').trim();
  if (idx[k2]) return idx[k2] as TaskStatus;
  if (/^\d+%$/.test(k)) return parseInt(k, 10) >= 100 ? 'Completed' : 'In Progress';
  return null;
}

export function normalizeHeader(raw: unknown, masters: Masters): Field | null {
  const aliases = masters.headerAliases;
  const k = keyify(raw);
  if (!k) return null;
  if (aliases[k]) return aliases[k];
  const k2 = k.replace(/\s*\(.*?\)\s*/g, ' ').replace(/[*#:]/g, '').replace(/\s{2,}/g, ' ').trim();
  if (aliases[k2]) return aliases[k2];
  if (/^(s no|sr no|sl no|sno|srno|#)$/.test(k2)) return null;
  return null;
}

export function normalizePriority(v: unknown): string {
  const s = cleanWhitespace(v).toLowerCase();
  if (!s) return '';
  if (/^(p0|p1|high|urgent|critical|h)$/.test(s)) return 'High';
  if (/^(p2|medium|med|normal|m)$/.test(s)) return 'Medium';
  if (/^(p3|p4|low|minor|l)$/.test(s)) return 'Low';
  return titleCase(s);
}

export interface ResolvedEmployee { id: string; name: string; department: string; isNew: boolean }

/**
 * Resolves a reported name to a canonical employee. First-name-only matching is
 * used ONLY when unambiguous — two people called Rahul disables it, on purpose.
 * `created` collects auto-created employees so the caller can persist them.
 */
export function resolveEmployee(
  rawName: string, departmentHint: string, masters: Masters,
  cfg: EngineConfig, created: Employee[]
): ResolvedEmployee | null {
  const name = cleanWhitespace(decodeEntities(rawName))
    .replace(/\s*\((.*?)\)\s*$/, '')
    .replace(/^(mr|mrs|ms|dr)\.?\s+/i, '');
  const k = keyify(name);
  if (!k) return null;

  const byKey = new Map<string, Employee>();
  masters.employees.forEach(e => {
    byKey.set(keyify(e.name), e);
    e.aliases.forEach(a => { if (a) byKey.set(keyify(a), e); });
  });
  created.forEach(e => byKey.set(keyify(e.name), e));

  const hit = byKey.get(k);
  if (hit) return { id: hit.id, name: hit.name, department: hit.department || departmentHint, isNew: false };

  const all = masters.employees.concat(created);
  const partial = all.filter(e => keyify(e.name).split(' ')[0] === k);
  if (partial.length === 1) {
    return {
      id: partial[0].id, name: partial[0].name,
      department: partial[0].department || departmentHint, isNew: false
    };
  }
  if (!cfg.autoCreateEmployees) return null;

  const rec: Employee = {
    id: 'EMP-' + shortHash(k, 6).toUpperCase(),
    name: titleCase(name), aliases: [],
    department: departmentHint || cfg.defaultDepartment, active: true
  };
  created.push(rec);
  return { id: rec.id, name: rec.name, department: rec.department, isNew: true };
}

/** Lookup-only: returns an EXISTING department name or ''. Never creates one. */
export function lookupDepartment(raw: string, masters: Masters): string {
  const k = keyify(raw);
  if (!k) return '';
  for (const d of masters.departments) {
    if (keyify(d.name) === k) return d.name;
    if (d.aliases.some(a => keyify(a) === k)) return d.name;
  }
  return '';
}

/**
 * Finds an EXISTING department mentioned anywhere in free text (a subject line,
 * a sender name). Longest match wins. Never creates master data — a subject is
 * far too noisy to mint from, and "Fwd: Daily Report" must never produce a
 * department called "Fwd", not least because Department is part of the
 * duplicate fingerprint.
 */
export function findDepartmentInText(text: string, masters: Masters, cfg: EngineConfig): string {
  const hay = ' ' + keyify(text) + ' ';
  const placeholder = keyify(cfg.defaultDepartment);
  let best = '', bestLen = 0;
  masters.departments.forEach(d => {
    [d.name, ...d.aliases].forEach(candidate => {
      const k = keyify(candidate);
      if (!k || k === placeholder) return;
      if (hay.includes(' ' + k + ' ') && k.length > bestLen) { best = d.name; bestLen = k.length; }
    });
  });
  return best;
}

export function departmentFromSender(domain: string, sender: string, masters: Masters): string {
  const dom = (domain || '').toLowerCase();
  if (dom) {
    for (const d of masters.departments) {
      if (d.senderDomains.map(x => x.toLowerCase()).includes(dom)) return d.name;
    }
  }
  const sk = keyify(sender);
  if (sk) {
    for (const d of masters.departments) {
      if (sk.includes(keyify(d.name))) return d.name;
    }
  }
  return '';
}

export interface ResolvedCategory { name: string; expectedDuration: number | null }

export function resolveCategory(taskNormalized: string, masters: Masters): ResolvedCategory {
  let best: Category | null = null, bestLen = 0;
  masters.categories.forEach(c => {
    c.keywords.forEach(kw => {
      const k = kw.toLowerCase();
      if (k && taskNormalized.includes(k) && k.length > bestLen) { best = c; bestLen = k.length; }
    });
  });
  return best
    ? { name: (best as Category).name, expectedDuration: (best as Category).expectedDuration }
    : { name: '', expectedDuration: null };
}

export function expectedDurationFor(categoryName: string, masters: Masters): number | null {
  const c = masters.categories.find(x => x.name === categoryName);
  return c ? c.expectedDuration : null;
}

/* --------------------------------------------------------------------------
 * Hashing — must match the Apps Script implementation byte for byte, so the
 * two systems produce identical fingerprints for identical input.
 * ------------------------------------------------------------------------ */

import { createHash } from 'crypto';

export function sha1Hex(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

export function shortHash(s: string, len = 12): string {
  return sha1Hex(s).slice(0, len);
}
