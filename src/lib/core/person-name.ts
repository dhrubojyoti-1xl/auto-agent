/**
 * Is this a person, or the name of a piece of work?
 *
 * A column of short capitalised phrases looks exactly like a column of names
 * to a shape test: "Hr Meeting", "Attendance Monitoring" and "Content Team" are
 * two capitalised words each, just like "Asha Rao". Taking the shape alone
 * is how task titles ended up in the Employee drop-down and at the top of the
 * Employee activity chart, above the people who actually did the work.
 *
 * The test is deliberately one-sided. A real name that fails it is only left
 * out of a list of people (it is still counted everywhere else, and a roster
 * entry always passes); a task title that passed would be presented to a
 * manager as a colleague.
 */
import { cleanWhitespace, keyify } from './normalize';

/**
 * Words that name work, teams or documents and are not given names or
 * surnames. Whole-word matches only, so "Pal" and "Dey" are untouched.
 */
const WORK_WORDS = new Set([
  'meeting', 'meetings', 'monitoring', 'team', 'teams', 'building', 'calendar',
  'event', 'events', 'plan', 'plans', 'planning', 'interview', 'interviews',
  'induction', 'management', 'support', 'coordination', 'update', 'updates',
  'report', 'reports', 'reporting', 'review', 'reviews', 'training', 'engagement',
  'communication', 'communications', 'recruitment', 'attendance', 'capability',
  'process', 'processes', 'project', 'projects', 'task', 'tasks', 'work', 'follow',
  'followup', 'documentation', 'document', 'documents', 'asset', 'assets',
  'details', 'form', 'forms', 'register', 'leave', 'leaves', 'hr', 'qa', 'sop',
  'sops', 'testing', 'test', 'tests', 'ticket', 'tickets', 'defect', 'defects',
  'deployment', 'deployments', 'fixed', 'fix', 'fixes', 'resolved', 'developed',
  'implemented', 'discussed', 'performed', 'worked', 'continued', 'completed',
  'call', 'calls', 'email', 'emails', 'mail', 'mails', 'data', 'entry', 'sheet',
  'sheets', 'content', 'design', 'designs', 'designing', 'creation', 'create',
  'created', 'preparation', 'prepare', 'prepared', 'onboarding', 'payroll',
  'audit', 'audits', 'compliance', 'policy', 'policies', 'vendor', 'vendors',
  'client', 'clients', 'campaign', 'campaigns', 'post', 'posts', 'blog', 'blogs',
  'video', 'videos', 'social', 'media', 'website', 'app', 'application',
  'server', 'servers', 'bug', 'bugs', 'feature', 'features', 'module', 'modules',
  'dashboard', 'analysis', 'research', 'session', 'sessions', 'workshop',
  'presentation', 'marketing', 'sales', 'operations', 'admin', 'office',
  'biometric', 'medical', 'fitness', 'directory', 'official', 'acknowledgement',
  'absence', 'compensatory', 'record', 'records', 'priorities', 'priority',
  'internal', 'external', 'day', 'days', 'week', 'weekly', 'daily', 'monthly',
  'round', 'department', 'departments', 'development', 'relations', 'relationship',
  'employee', 'employees', 'staff', 'candidate', 'candidates', 'hiring', 'salary',
  'invoice', 'invoices', 'order', 'orders', 'account', 'accounts', 'finance',
  'budget', 'approval', 'approvals', 'upload', 'uploads', 'download', 'backup',
  'maintenance', 'installation', 'setup', 'config', 'configuration', 'issue',
  'issues', 'query', 'queries', 'feedback', 'survey', 'brochure', 'banner',
  'logo', 'creative', 'creatives', 'script', 'scripts', 'course', 'courses',
  'lesson', 'lessons', 'module', 'quiz', 'assessment', 'assessments', 'drive',
  'visit', 'visits', 'pending', 'progress', 'status', 'adhoc', 'misc',
  'miscellaneous', 'general', 'other', 'others', 'total', 'summary', 'na',
  'none', 'all', 'yes', 'no', 'unassigned', 'unknown',
  // Seen as "employees" on the live Data quality page, 29-09-2026: software
  // panels, places, and the paperwork of HR work.
  'panel', 'panels', 'group', 'today', 'dubai', 'delhi', 'noida', 'india', 'indian',
  'uae', 'mumbai', 'pune', 'bengaluru', 'bangalore', 'gurgaon', 'gurugram',
  'hyderabad', 'chennai', 'kolkata', 'sharjah', 'london', 'france', 'resource',
  'resources', 'human', 'travel', 'reimbursement', 'welcome', 'kit', 'letter',
  'letters', 'response', 'cv', 'database', 'chart', 'organisational',
  'organizational', 'organisation', 'organization', 'welfare', 'committee',
  'confirmation', 'gmail', 'birthday', 'birthdays', 'poster', 'posters',
  'celebration', 'celebrations', 'probation', 'tracking', 'tracker', 'menu',
  'invitation', 'agenda', 'signature', 'payment', 'payments', 'stipend', 'visa',
  'permit', 'insurance', 'handbook', 'newsletter', 'newsletters', 'magazine',
  'internship', 'internships', 'certificate', 'certificates', 'completion', 'system',
  'systems', 'access', 'joiner', 'joiners', 'intern', 'interns'
]);

/** Joining words that belong in a phrase, not a name. */
const CONNECTORS = new Set(['with', 'for', 'the', 'to', 'of', 'on', 'in', 'at',
  'from', 'and', 'by', 'about', 'into', 'via', 'per']);

/**
 * True when `raw` could be a person's name.
 *
 * One to four words of letters (initials, apostrophes and in-word hyphens
 * allowed), no digits, no phrase punctuation, and no word that names work.
 */
export function looksLikePersonName(raw: string): boolean {
  const name = cleanWhitespace(raw);
  if (!name || name.length > 60) return false;
  if (/\d/.test(name)) return false;
  // A spaced dash, an ampersand, a colon, brackets or a question mark are how
  // phrases are punctuated: "Priya – Biometric Coordination".
  if (/[–—&:;()[\]{}?!@#%/\\|+=*<>"]/.test(name)) return false;
  if (/\s-\s|^-|-$/.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 4) return false;
  if (!words.every(w => /^[A-Za-z][A-Za-z.'’-]*$/.test(w))) return false;
  const keys = keyify(name).split(' ').filter(Boolean);
  if (!keys.length) return false;
  if (keys.some(k => WORK_WORDS.has(k) || CONNECTORS.has(k))) return false;
  return true;
}

/** Edit distance between two strings, giving up (returning max + 1) past max. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The roster name a guessed name is probably a misspelling of, or ''.
 *
 * "Sasikala Lognathan" is "Sasikala Loganathan" and "Pooja Jagadale" is
 * "Puja Jagadale": the reports spell a colleague one way and the roster
 * another, and with ROSTER_ONLY on, the misspelt reports are left out. Saying
 * so beside the guessed name is what gets the alias added.
 *
 * Deliberately narrow — a hint that names the wrong colleague is worse than no
 * hint: at most two letters apart over the whole name, the same number of
 * words, each word starting with the same letter, and never for a short name,
 * where two letters make a different person.
 */
export function likelySamePerson(name: string, rosterNames: string[]): string {
  const k = keyify(name);
  if (k.replace(/ /g, '').length < 8) return '';
  const words = k.split(' ');
  let best = '';
  let bestDistance = 3;
  for (const candidate of rosterNames) {
    const rk = keyify(candidate);
    if (!rk || rk === k) continue;
    const rw = rk.split(' ');
    if (rw.length !== words.length || rw.some((w, i) => w[0] !== words[i][0])) continue;
    const d = editDistance(k, rk, 2);
    if (d < bestDistance) { best = candidate; bestDistance = d; }
  }
  return bestDistance <= 2 ? best : '';
}
