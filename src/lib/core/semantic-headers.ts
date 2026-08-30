/**
 * Understanding a column heading nobody told us about.
 *
 * The alias table handles the wordings we have seen. Real departments invent
 * new ones constantly — "Work Done Today", "Activities Completed", "Emp Nm",
 * "Current State", "Reporting Dt" — and a fixed list can only ever be the
 * headings somebody already thought of. Before this, an unknown heading meant
 * the column was dropped, and dropping the wrong one meant the whole table
 * failed to look like a report.
 *
 * This layer scores a heading against what each canonical field is *about*,
 * using the words in the heading rather than the heading as a whole. It is
 * deterministic and explainable: every match can say which words earned it.
 * Genuinely novel wording that scores nothing here is passed to the AI mapper,
 * which is cached so a given header shape costs one call ever.
 *
 * The bar is set so that a wrong mapping is worse than no mapping: a heading
 * that matches nothing strongly is left unmapped, and the row-level validators
 * then reject the row with a reason rather than filing it under a guess.
 */
import type { Field } from './types';

/**
 * Words that indicate a field, weighted by how exclusively they do so.
 *
 * "date" means the date column almost anywhere it appears; "name" only means
 * the employee when nothing better claims it, because "task name" and "project
 * name" contain it too. The weights encode that difference.
 */
const SIGNALS: Record<string, { strong: string[]; weak: string[]; against?: string[] }> = {
  date: {
    strong: ['date', 'dt', 'day', 'fecha', 'datum', 'tarikh', 'tanggal'],
    weak: ['reporting', 'report', 'work', 'on'],
    against: ['start', 'end', 'completion', 'finish', 'due', 'target', 'update']
  },
  employee: {
    // "Who" is a whole column heading on its own in plenty of real reports,
    // and it can only mean one thing.
    strong: ['employee', 'emp', 'staff', 'person', 'member', 'worker', 'assignee',
             'who', 'resource', 'nombre', 'empleado', 'mitarbeiter', 'karmachari'],
    weak: ['name', 'nm', 'by', 'owner', 'assigned', 'team'],
    against: ['task', 'project', 'file', 'department', 'client', 'company', 'sheet']
  },
  department: {
    strong: ['department', 'dept', 'dpt', 'division', 'unit', 'vertical',
             'departamento', 'abteilung', 'vibhag'],
    weak: ['team', 'function', 'group', 'section'],
    against: ['member', 'lead', 'head', 'size']
  },
  task: {
    // "plan" is strong because a column headed "Tomorrow's Plan" is the work
    // column of a report — the only thing in it is tasks. "planned" stays with
    // expectedDuration, where "Planned Hours" belongs.
    strong: ['task', 'work', 'activity', 'job', 'assignment', 'plan', 'contribution',
             'deliverable', 'tarea', 'trabajo', 'aufgabe', 'kaam'],
    weak: ['description', 'desc', 'detail', 'particular', 'item', 'done',
           'today', 'yesterday', 'tomorrow', 'performed', 'summary', 'action',
           'output', 'accomplishment', 'achievement'],
    against: ['status', 'state', 'date', 'time', 'hour', 'count', 'id', 'no',
              'category', 'type', 'link', 'url']
  },
  status: {
    strong: ['status', 'state', 'progress', 'stage', 'situation', 'stand',
             'estado', 'zustand'],
    // "Where it stands" is a heading a person writes; "stand" carries it.
    weak: ['completion', 'current', 'result', 'outcome', 'condition', 'position',
           'where'],
    against: ['date', 'time', 'report', 'update', 'note']
  },
  category: {
    strong: ['category', 'categoria'],
    weak: ['type', 'kind', 'classification', 'bucket', 'project', 'stream'],
    against: ['task', 'employee', 'file']
  },
  priority: { strong: ['priority', 'urgency', 'severity'], weak: ['importance', 'p'] },
  startTime: {
    strong: ['starttime'],
    weak: ['start', 'from', 'begin', 'began', 'commenced', 'in'],
    against: ['date']
  },
  completionTime: {
    strong: ['endtime', 'finishtime', 'completiontime'],
    weak: ['end', 'to', 'finish', 'finished', 'closed', 'out'],
    against: ['date']
  },
  startDate: { strong: ['startdate'], weak: ['started', 'begun'] },
  completionDate: { strong: ['enddate', 'completiondate'], weak: ['completed', 'closed'] },
  expectedDuration: {
    strong: ['estimate', 'estimated', 'expected', 'planned', 'budgeted'],
    weak: ['duration', 'hour', 'hr', 'effort', 'time'],
    against: ['actual', 'spent', 'taken']
  },
  actualDuration: {
    strong: ['actual', 'spent', 'taken', 'logged'],
    weak: ['duration', 'hour', 'hr', 'effort', 'time'],
    against: ['estimate', 'expected', 'planned']
  },
  link: {
    strong: ['link', 'url', 'href'],
    weak: ['reference', 'ref', 'proof', 'evidence', 'attachment', 'doc', 'document'],
    against: []
  },
  notes: {
    strong: ['remark', 'comment', 'note',
             'observacion', 'bemerkung'],
    weak: ['observation', 'feedback', 'issue', 'blocker'],
    against: []
  },
  employeeId: { strong: ['empid', 'employeeid', 'staffid'], weak: [] }
};

/** Row-number columns carry no meaning and must never win a field. */
const SERIAL = /^(s\s*no|sr\s*no|sl\s*no|s\/n|sno|srno|serial|#|no|index|idx)$/;

const STOP = new Set(['the', 'of', 'for', 'a', 'an', 'and', 'in', 'is', 'as', 'per']);

/**
 * Words that mean the column belongs to a different kind of document
 * entirely. An invoice and a report can share a word — "unit" appears in
 * "Business Unit" and in "Unit Price" — so one of these anywhere in a heading
 * vetoes the whole heading rather than merely lowering a score.
 */
const NOT_A_REPORT_FIELD = new Set([
  'price', 'amount', 'invoice', 'quantity', 'qty', 'total', 'subtotal', 'gst',
  'vat', 'tax', 'rate', 'cost', 'currency', 'salary', 'payment', 'balance',
  'discount', 'headline', 'author', 'phone', 'mobile', 'address', 'postcode'
]);

/**
 * Reduces a plural to the form the signal lists use. "Employee's Name" reaches
 * here as "employees", and an unmatched "employees" is how a whole column
 * silently stops being an employee column.
 */
function singular(t: string): string {
  // Words that merely end in s: status, progress, previous, analysis. Stripping
  // the s turns them into nothing anything matches, which is how a Status
  // column stops being recognised as one.
  if (/(us|is|ss|ous)$/.test(t)) return t;
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && /(ses|xes|ches|shes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

/** "Employee's Name (Full)" -> ["employee", "name", "full"] */
export function headerTokens(raw: string): string[] {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t && !STOP.has(t))
    .map(singular);
}

export interface HeaderGuess {
  field: Field;
  score: number;
  evidence: string[];
}

/**
 * Ranks the fields a heading might mean.
 *
 * A heading is compared token by token, so word order and extra words do not
 * matter: "Name of Employee", "Employee Name" and "Emp. Name" all reach the
 * same place. Compound headings resolve by weight — "Task Name" is a task
 * because `task` is strong for task and `name` is only weak for employee.
 */
export function rankHeader(raw: string): HeaderGuess[] {
  const tokens = headerTokens(raw);
  if (!tokens.length) return [];

  const joined = tokens.join('');
  if (SERIAL.test(tokens.join(' ')) || SERIAL.test(joined)) return [];
  if (tokens.some(t => NOT_A_REPORT_FIELD.has(t))) return [];

  const guesses: HeaderGuess[] = [];
  for (const [field, sig] of Object.entries(SIGNALS)) {
    let score = 0;
    const evidence: string[] = [];

    for (const t of tokens) {
      if (sig.strong.includes(t)) { score += 3; evidence.push(t); }
      else if (sig.weak.includes(t)) { score += 1; evidence.push(t); }
      else if (sig.against?.includes(t)) score -= 2;
    }
    // "starttime" and "endtime" arrive as one token when punctuation is absent.
    if (sig.strong.includes(joined)) { score += 3; evidence.push(joined); }

    if (score > 0) guesses.push({ field: field as Field, score, evidence });
  }
  return guesses.sort((a, b) => b.score - a.score || a.field.localeCompare(b.field));
}

/**
 * The single field a heading means, or null when nothing is convincing enough.
 *
 * A score of 3 is one strong word, or three weak ones. Below that the heading
 * is left unmapped: a column filed under the wrong field corrupts data
 * silently, while an unmapped column produces a row-level rejection that says
 * so.
 */
export function guessField(raw: string, minScore = 3): Field | null {
  const [best, second] = rankHeader(raw);
  if (!best || best.score < minScore) return null;
  // A tie between two fields is not an answer.
  if (second && second.score === best.score) return null;
  return best.field;
}

/**
 * Which stream of work a column describes.
 *
 * A daily report often has three task columns side by side — yesterday's work,
 * today's work, tomorrow's plan — and they are not the same measurement.
 * Counting a plan as a completion overstates what the team did, which is the
 * one number management actually looks at.
 *
 * PLANNED is deliberately the easiest to trigger and the hardest to lose: a
 * plan counted as completed work is a false claim about people, while a
 * completion filed as REPORTED is merely less specific.
 */
export type WorkKind = 'COMPLETED_TODAY' | 'PREVIOUS_DAY' | 'PLANNED' | 'REPORTED';

const PLANNED = ['plan', 'planned', 'tomorrow', 'next', 'upcoming', 'future',
                 'proposed', 'scheduled', 'agenda', 'todo', 'backlog'];
const PREVIOUS = ['yesterday', 'previous', 'prev', 'last', 'carried', 'carry',
                  'pending from', 'backlog from'];
const TODAY = ['today', 'todays', 'current', 'completed', 'done', 'achieved',
               'accomplished'];

/**
 * Reads the stream out of a column heading. Returns REPORTED when the heading
 * says nothing about a stream, which is the overwhelmingly common case.
 */
export function workKindFromHeader(raw: string): WorkKind {
  const tokens = headerTokens(raw);
  if (!tokens.length) return 'REPORTED';
  const has = (list: string[]) => tokens.some(t => list.includes(t));

  // Checked before the others: "Plan for Tomorrow" contains neither a
  // completion word nor a previous-day word, but "Completed / Planned" does,
  // and a plan must not be read as a completion.
  if (has(PLANNED)) return 'PLANNED';
  if (has(PREVIOUS)) return 'PREVIOUS_DAY';
  if (has(TODAY)) return 'COMPLETED_TODAY';
  return 'REPORTED';
}
