/**
 * The organisation's own record of who belongs where.
 *
 * Everything else in this product works hard to avoid asking anyone to change
 * how they already work. The roster is the one deliberate input, and it earns
 * its place: a daily report that names "Rahul Koli" and nothing else can only
 * be filed under a department if something, somewhere, knows which department
 * Rahul Koli is in. Without it every such row lands in "Unassigned", and a
 * department report that is three-quarters Unassigned tells a manager nothing.
 *
 * It is deliberately forgiving about its own input. A manager pastes whatever
 * their HR spreadsheet already looks like, and the column headings are read the
 * same scored way report headings are — a heading only has to lean towards a
 * meaning, so the usual variations on team, person and mail address all land
 * where they should. Asking someone to reformat a spreadsheet to feed the thing
 * that exists to stop them reformatting spreadsheets would be absurd.
 */
import { parseDelimited } from './core/attachments';
import { cleanWhitespace, keyify, shortHash, titleCase } from './core/normalize';

export interface RosterPerson {
  name: string;
  department: string;
  email: string;
  aliases: string[];
  role: string;
}

export interface RosterDepartment {
  name: string;
  manager: string;
  managerEmail: string;
}

export interface RosterParse {
  people: RosterPerson[];
  departments: RosterDepartment[];
  /** Rows that could not be used, with the reason, so nothing vanishes. */
  rejected: { row: number; values: string[]; reason: string }[];
  /** Which column was read as what, so a surprising import can be explained. */
  mapping: Record<string, string>;
}

type Slot = 'name' | 'department' | 'email' | 'aliases' | 'role' | 'manager' | 'managerEmail';

/**
 * Scored rather than matched: a heading only has to lean towards a slot, and
 * the strongest lean wins the column. "Manager Email" contains both "manager"
 * and "email", so whichever scores higher decides it — which is why the
 * manager-email signals are worth more than the plain email ones.
 */
const SIGNALS: Record<Slot, { strong: string[]; weak: string[] }> = {
  managerEmail: {
    strong: ['manager email', 'manager mail', 'reporting to email', 'hod email'],
    weak: []
  },
  manager: {
    strong: ['manager', 'reporting manager', 'reports to', 'hod', 'head of department', 'supervisor'],
    weak: ['lead', 'head']
  },
  email: {
    strong: ['email', 'e mail', 'mail id', 'email id', 'email address', 'mail address'],
    weak: ['mail', 'id']
  },
  department: {
    strong: ['department', 'dept', 'dpt', 'division', 'team', 'unit', 'vertical', 'business area'],
    weak: ['function', 'group', 'section', 'area']
  },
  name: {
    strong: ['employee name', 'staff name', 'member name', 'full name', 'person name'],
    weak: ['employee', 'name', 'staff', 'member', 'person', 'colleague', 'resource', 'who']
  },
  aliases: {
    strong: ['alias', 'aliases', 'also known as', 'known as', 'other names', 'short name', 'nickname'],
    weak: ['aka', 'variants']
  },
  role: {
    strong: ['role', 'designation', 'title', 'job title', 'position'],
    weak: ['grade', 'level']
  }
};

function scoreHeading(heading: string, slot: Slot): number {
  const h = ' ' + keyify(heading) + ' ';
  if (!h.trim()) return 0;
  const { strong, weak } = SIGNALS[slot];
  let best = 0;
  for (const s of strong) if (h.includes(' ' + s + ' ') || h.includes(s)) best = Math.max(best, 3 + s.length / 100);
  for (const w of weak) if (h.includes(' ' + w + ' ') || h.includes(w)) best = Math.max(best, 1 + w.length / 100);
  return best;
}

/** Assigns each slot to its best-scoring column, one column per slot. */
function mapHeadings(headings: string[]): Partial<Record<Slot, number>> {
  const slots: Slot[] = ['managerEmail', 'manager', 'email', 'department', 'aliases', 'role', 'name'];
  const out: Partial<Record<Slot, number>> = {};
  const taken = new Set<number>();
  // Slots are resolved in order of how specific they are, so "Manager Email"
  // is claimed before plain "Email" can take it.
  for (const slot of slots) {
    let bestCol = -1;
    let bestScore = 0;
    headings.forEach((h, i) => {
      if (taken.has(i)) return;
      const s = scoreHeading(h, slot);
      if (s > bestScore) { bestScore = s; bestCol = i; }
    });
    if (bestCol >= 0) { out[slot] = bestCol; taken.add(bestCol); }
  }
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Title case that leaves acronyms alone.
 *
 * Half of Harshal's departments are initialisms — SOP, HR, IT, AI. Running a
 * plain title case over them produces "Sop" and "Hr", which is the kind of
 * small wrongness that makes a manager distrust everything else on the screen.
 */
function properName(raw: string): string {
  return cleanWhitespace(raw).split(/\s+/).map(word => {
    const letters = word.replace(/[^A-Za-z]/g, '');
    // Already shouting, and short enough to be an initialism rather than a
    // sentence someone left caps-lock on for.
    if (letters.length >= 2 && letters.length <= 5 && letters === letters.toUpperCase()) return word;
    return titleCase(word);
  }).join(' ');
}

/** Splits an alias cell however the person happened to separate it. */
function splitAliases(cell: string): string[] {
  return cell.split(/[,;/|]| and /i)
    .map(a => cleanWhitespace(a))
    .filter(a => a.length > 1);
}

/**
 * Reads a pasted or uploaded roster sheet.
 *
 * Never throws on bad input: a row it cannot use comes back in `rejected` with
 * its original values, the same bargain the report pipeline makes. Silence is
 * the one outcome that is not allowed.
 */
export function parseRoster(content: string): RosterParse {
  const rows = parseDelimited(content);
  const rejected: RosterParse['rejected'] = [];
  if (rows.length < 2) {
    return { people: [], departments: [], rejected, mapping: {} };
  }

  // Which row is the heading row? Not simply the first one that looks like it:
  // a sheet that opens with "ONEXCELL INDIA — TEAM LIST 2026" contains the word
  // "team", which is enough to fool a first-match rule into reading the title
  // as the headings and the real headings as a person. The row that maps the
  // MOST columns wins instead, and ties go to the earlier row.
  let headerIdx = 0;
  let headerScore = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const m = mapHeadings(rows[i]);
    const named = Object.keys(m).length;
    const usable = m.name !== undefined || m.department !== undefined;
    if (usable && named > headerScore) { headerScore = named; headerIdx = i; }
  }

  const headings = rows[headerIdx];
  const col = mapHeadings(headings);
  const mapping: Record<string, string> = {};
  (Object.keys(col) as Slot[]).forEach(slot => {
    const i = col[slot];
    if (i !== undefined) mapping[headings[i] || `column ${i + 1}`] = slot;
  });

  const at = (r: string[], slot: Slot) => {
    const i = col[slot];
    return i === undefined ? '' : cleanWhitespace(r[i] ?? '');
  };

  const people = new Map<string, RosterPerson>();
  const departments = new Map<string, RosterDepartment>();

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const rawName = at(r, 'name');
    const dept = at(r, 'department');
    const email = at(r, 'email');
    const manager = at(r, 'manager');
    const managerEmail = at(r, 'managerEmail');

    // A row naming only a department and its manager is a legitimate way to
    // state who runs a team without listing anybody in it.
    if (!rawName && dept) {
      const key = keyify(dept);
      const existing = departments.get(key);
      departments.set(key, {
        name: existing?.name || properName(dept),
        manager: manager || existing?.manager || '',
        managerEmail: managerEmail || existing?.managerEmail || ''
      });
      continue;
    }

    if (!rawName) {
      rejected.push({ row: i + 1, values: r, reason: 'No employee name in this row' });
      continue;
    }
    if (!dept) {
      rejected.push({
        row: i + 1, values: r,
        reason: `No department for "${rawName}" — without one this person's ` +
                `rows would still be Unassigned`
      });
      continue;
    }
    if (email && !EMAIL.test(email)) {
      rejected.push({ row: i + 1, values: r, reason: `"${email}" is not a valid email address` });
      continue;
    }

    const name = properName(rawName);
    const key = keyify(name);
    if (!key) {
      rejected.push({ row: i + 1, values: r, reason: 'Employee name is empty once cleaned' });
      continue;
    }

    const aliases = splitAliases(at(r, 'aliases'))
      .filter(a => keyify(a) !== key);

    const prior = people.get(key);
    if (prior) {
      // The same person listed twice — merge rather than argue, but keep the
      // first department, because picking the later one silently would make
      // the import order matter.
      prior.aliases = [...new Set([...prior.aliases, ...aliases])];
      prior.email = prior.email || email;
      prior.role = prior.role || at(r, 'role');
    } else {
      people.set(key, { name, department: properName(dept), email, aliases, role: at(r, 'role') });
    }

    const dkey = keyify(dept);
    const existing = departments.get(dkey);
    departments.set(dkey, {
      name: existing?.name || properName(dept),
      manager: manager || existing?.manager || '',
      managerEmail: managerEmail || existing?.managerEmail || ''
    });
  }

  return {
    people: [...people.values()],
    departments: [...departments.values()],
    rejected,
    mapping
  };
}

/**
 * A stable id for a rostered person.
 *
 * Derived from the name so that re-importing an updated spreadsheet updates the
 * same people rather than creating a second copy of everyone — which is what a
 * random id would do, and it would do it quietly.
 *
 * It uses the same hash the rest of the pipeline uses, at the same width. The
 * first version folded a 32-bit rolling hash into six base-36 characters, which
 * collided inside a single company: two different people would arrive with the
 * same id, and the second would silently overwrite the first on the way in.
 * Nobody would see anything wrong; a person would simply be missing.
 */
export function rosterEmployeeId(name: string): string {
  return 'EMP-' + shortHash(keyify(name), 12).toUpperCase();
}

export function rosterDepartmentId(name: string): string {
  return 'DEP-' + shortHash(keyify(name), 12).toUpperCase();
}
