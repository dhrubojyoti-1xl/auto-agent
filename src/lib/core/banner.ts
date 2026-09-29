/**
 * The title line above a report table, read for what it states once for every
 * row beneath it.
 *
 * The company's Daily Work Report puts the person and the day in a single
 * merged row over the table, not in columns:
 *
 *     DWR: 001 | Emp Name: Asha Rao | Designation | Date: 28/09/2026 | Day: Monday | Full Day
 *     Sr. No. | Company | Category | What was I supposed to do today? | What did I do? | ...
 *
 * With no Employee or Date column the table used to fail the "is this a
 * report" test outright, or worse, pass it because some other column's values
 * happened to look like names. The title line is the report stating its own
 * author and date, and it outranks any guess made from the columns.
 */
import type { Banner, Cell } from './types';
import { cleanWhitespace, parseDate } from './normalize';

/** The labels a title line uses for its fields, and where each value ends. */
const STOP = '(?=\\s*(?:\\||$|\\b(?:designation|desig|date|day|dept|department|team|role|' +
             'emp(?:loyee)?\\s*(?:name|id|code)|full\\s*day|half\\s*day)\\b))';

const EMPLOYEE = new RegExp(
  '(?:^|[|,;]|\\s)(?:emp(?:loyee)?\\.?\\s*name|name\\s+of\\s+(?:the\\s+)?employee|' +
  'staff\\s*name|reported\\s+by|submitted\\s+by|prepared\\s+by)\\s*[:：=-]\\s*' +
  '([^|:：;\\n]*?)' + STOP, 'i');

const DATE = new RegExp(
  '(?:^|[|,;]|\\s)(?:report\\s+)?dated?\\s*[:：=-]\\s*([^|;\\n]*?)' +
  '(?=\\s*(?:\\||$|\\b(?:day|designation|emp(?:loyee)?|dept|department|full\\s*day|half\\s*day)\\b))',
  'i');

const DEPARTMENT = new RegExp(
  '(?:^|[|,;]|\\s)(?:dept|department|team)\\s*[:：=-]\\s*([^|:：;\\n]*?)' + STOP, 'i');

/** A row's distinct cell texts, in order. A merged cell repeats its text. */
function rowText(row: Cell[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of row) {
    const t = cleanWhitespace(c?.text ?? '');
    if (t && !seen.has(t)) { seen.add(t); parts.push(t); }
  }
  return parts.join(' | ');
}

/** Words a template leaves in place of a value: "Emp Name:  | Designation". */
const PLACEHOLDER = /^(designation|date|day|name|emp name|employee name|full day|half day|na|n\/a|-+|_+)$/i;

function cleanName(v: string): string {
  const name = cleanWhitespace(v).replace(/[.,\-–—]+$/, '').trim();
  if (!name || PLACEHOLDER.test(name)) return '';
  if (/\d/.test(name) || name.split(/\s+/).length > 5) return '';
  return name;
}

/**
 * Reads the title lines among the first rows of a table.
 *
 * Only labelled values count ("Emp Name: …", "Date: …"). A bare line of text is
 * a heading, not a statement, and nothing is inferred from it here.
 */
export function readBanner(rows: Cell[][], dateOrder: 'DMY' | 'MDY', scan = 6): Banner | null {
  let employee = '', date = '', department = '', quote = '';
  for (const row of rows.slice(0, scan)) {
    const text = rowText(row);
    if (!text || !/[:：=]/.test(text)) continue;

    const e = EMPLOYEE.exec(text);
    const d = DATE.exec(text);
    const p = DEPARTMENT.exec(text);
    const name = e ? cleanName(e[1]) : '';
    const day = d ? parseDate(cleanWhitespace(d[1]), dateOrder) || '' : '';
    const dept = p ? cleanName(p[1]) : '';

    if (name && !employee) employee = name;
    if (day && !date) date = day;
    if (dept && !department) department = dept;
    if ((name || day || dept) && !quote) quote = text.slice(0, 200);
  }
  if (!employee && !date && !department) return null;
  const out: Banner = { quote };
  if (employee) out.employee = employee;
  if (date) out.date = date;
  if (department) out.department = department;
  return out;
}
