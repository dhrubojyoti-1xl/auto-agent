/**
 * One day, one department, in a paragraph a manager can read aloud.
 *
 * Asked for in the 28-09-2026 review: "a brief summary and analysis of each
 * department's daily reports". Every number here is counted, never estimated,
 * and every sentence is built from those counts — the same rule the rest of
 * the product keeps. Nothing ranks people: who reported is listed
 * alphabetically, because task counts say nothing about the value of the work.
 *
 * Pure, so it can be tested without a database and reused by any page.
 */

export interface DayRow {
  department: string;
  employee: string;
  task: string;
  category: string;
  status: string;
  /** Hours, when the report gave a duration. */
  hours: number | null;
  workKind: string;
}

export interface DepartmentDay {
  department: string;
  total: number;
  completed: number;
  inProgress: number;
  /** Pending and Not Started: reported, not begun or not finished. */
  notDone: number;
  blocked: number;
  cancelled: number;
  completionRate: number;
  hours: number | null;
  hoursTasks: number;
  people: { name: string; tasks: number; completed: number }[];
  /** On the roster for this department, with nothing reported on the day. */
  notReported: string[];
  rosterSize: number;
  topCategories: { name: string; tasks: number }[];
  attention: { employee: string; task: string; status: string }[];
  planned: number;
  /** Tasks filed under a name that is not a person (older imports). */
  unattributed: number;
  headline: string;
  points: string[];
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function listNames(names: string[], max = 6): string {
  if (names.length <= max) {
    return names.length > 1
      ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
      : names.join('');
  }
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

const UNPLACED = new Set(['', 'unassigned', 'unknown']);

export function summariseDepartmentDay(
  rows: DayRow[],
  roster: { name: string; department: string }[],
  isPerson: (name: string) => boolean
): DepartmentDay[] {
  const byDept = new Map<string, DayRow[]>();
  for (const r of rows) {
    const d = r.department || 'Unassigned';
    if (!byDept.has(d)) byDept.set(d, []);
    byDept.get(d)!.push(r);
  }

  const out: DepartmentDay[] = [];
  for (const [department, all] of byDept) {
    const planned = all.filter(r => r.workKind === 'PLANNED').length;
    // The same rows every dashboard figure is built from: plans are not work
    // yet, and a two-state status counts in nothing.
    const work = all.filter(r => r.workKind !== 'PLANNED' && r.status !== 'Ambiguous');
    const count = (s: string) => work.filter(r => r.status === s).length;
    const total = work.length;
    const completed = count('Completed');
    const inProgress = count('In Progress');
    const notDone = count('Pending') + count('Not Started');
    const blocked = count('Blocked');
    const cancelled = count('Cancelled');
    const completionRate = total ? Math.round((1000 * completed) / total) / 10 : 0;

    const timed = work.filter(r => r.hours !== null && r.hours > 0);
    const hours = timed.length
      ? Math.round(timed.reduce((a, r) => a + (r.hours as number), 0) * 10) / 10 : null;

    const peopleMap = new Map<string, { name: string; tasks: number; completed: number }>();
    let unattributed = 0;
    for (const r of work) {
      if (!isPerson(r.employee)) { unattributed++; continue; }
      const p = peopleMap.get(r.employee) || { name: r.employee, tasks: 0, completed: 0 };
      p.tasks++;
      if (r.status === 'Completed') p.completed++;
      peopleMap.set(r.employee, p);
    }
    const people = [...peopleMap.values()].sort((a, b) => a.name.localeCompare(b.name));

    const rosterHere = roster
      .filter(p => p.department.toLowerCase() === department.toLowerCase())
      .map(p => p.name);
    const reported = new Set([...peopleMap.keys()].map(n => n.toLowerCase()));
    const notReported = UNPLACED.has(department.toLowerCase()) ? []
      : rosterHere.filter(n => !reported.has(n.toLowerCase())).sort();

    const catMap = new Map<string, number>();
    for (const r of work) {
      const c = (r.category || '').trim();
      if (!c || /^uncategori[sz]ed$/i.test(c)) continue;
      catMap.set(c, (catMap.get(c) || 0) + 1);
    }
    const topCategories = [...catMap.entries()]
      .map(([name, tasks]) => ({ name, tasks }))
      .sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name))
      .slice(0, 3);

    const attention = work
      .filter(r => r.status === 'Blocked')
      .concat(work.filter(r => r.status === 'Pending' || r.status === 'Not Started'))
      .slice(0, 4)
      .map(r => ({ employee: isPerson(r.employee) ? r.employee : '', task: r.task, status: r.status }));

    // ---- the words ----------------------------------------------------------
    const who = rosterHere.length && !UNPLACED.has(department.toLowerCase())
      ? `${people.length} of ${plural(rosterHere.length, 'person', 'people')} reported`
      : `${plural(people.length, 'person', 'people')} reported`;
    const headline = total
      ? `${who} ${plural(total, 'task')}; ${completed} completed (${completionRate}%).`
      : `${who} nothing but plans for later.`;

    const points: string[] = [];
    if (blocked) {
      const b = attention.filter(a => a.status === 'Blocked').slice(0, 2)
        .map(a => `“${a.task}”${a.employee ? ` (${a.employee})` : ''}`);
      points.push(`${plural(blocked, 'task')} blocked${b.length ? `: ${b.join('; ')}` : ''}.`);
    }
    if (inProgress || notDone) {
      const parts = [
        inProgress ? `${inProgress} still in progress` : '',
        notDone ? `${notDone} not done` : ''
      ].filter(Boolean);
      points.push(`${parts.join(' and ')}.`);
    }
    if (topCategories.length) {
      points.push(`Most work went to ${topCategories
        .map(c => `${c.name} (${c.tasks})`).join(', ')}.`);
    }
    if (hours !== null) {
      points.push(`${hours} hours logged across ${plural(timed.length, 'task')}` +
                  (timed.length < total ? ` (${total - timed.length} gave no time)` : '') + '.');
    }
    if (people.length) {
      points.push(`Reported: ${listNames(people.map(p => `${p.name} (${p.tasks})`), 8)}.`);
    }
    if (notReported.length) {
      points.push(`No report from ${listNames(notReported)}.`);
    }
    if (planned) points.push(`${plural(planned, 'item')} planned for later, not counted above.`);
    if (unattributed) {
      points.push(`${plural(unattributed, 'task')} filed without a recognisable person ` +
                  `(older imports that recorded a task title as the name).`);
    }

    out.push({
      department, total, completed, inProgress, notDone, blocked, cancelled,
      completionRate, hours, hoursTasks: timed.length, people, notReported,
      rosterSize: rosterHere.length, topCategories, attention, planned, unattributed,
      headline, points
    });
  }

  // Named departments first, largest first; the unplaced bucket last.
  return out.sort((a, b) =>
    Number(UNPLACED.has(a.department.toLowerCase())) - Number(UNPLACED.has(b.department.toLowerCase())) ||
    b.total - a.total || a.department.localeCompare(b.department));
}

/**
 * Roster departments with nothing at all on the day. A department that sent
 * nothing has no card, and its silence is the one thing a manager most needs
 * to notice.
 */
export function silentDepartments(
  roster: { name: string; department: string }[], days: DepartmentDay[]
): string[] {
  const reporting = new Set(days.map(d => d.department.toLowerCase()));
  const all = new Map<string, string>();
  for (const p of roster) {
    const k = p.department.trim().toLowerCase();
    if (k && !UNPLACED.has(k) && !all.has(k)) all.set(k, p.department.trim());
  }
  return [...all.entries()].filter(([k]) => !reporting.has(k)).map(([, v]) => v).sort();
}

/** The whole day as plain text, for pasting into an email or a chat. */
export function departmentDayAsText(date: string, days: DepartmentDay[], silent: string[] = []): string {
  const lines = [`Department summaries — ${date}`, ''];
  for (const d of days) {
    lines.push(`${d.department}: ${d.headline}`);
    for (const p of d.points) lines.push(`  • ${p}`);
    lines.push('');
  }
  if (silent.length) lines.push(`No reports from: ${silent.join(', ')}.`);
  return lines.join('\n').trim();
}
