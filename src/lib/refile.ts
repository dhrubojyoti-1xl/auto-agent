/**
 * Re-filing work that was imported before the roster existed.
 *
 * Without this the roster is half a feature. A manager pastes their team list,
 * watches the confirmation, opens the dashboard — and every row imported up to
 * that moment is still sitting in "Unassigned", because syncing again imports
 * nothing: the messages are already processed and the rows already exist. The
 * roster would only start working on work that had not happened yet, which is
 * not what anybody means by fixing it.
 *
 * The awkward part is the fingerprint. Department is one of the five things a
 * task's fingerprint is built from, so moving a row between departments changes
 * its identity. Leave the old fingerprint in place and the same report arriving
 * again from a different message would no longer recognise itself, and would be
 * imported a second time — the exact failure this product spends most of its
 * effort avoiding. So the fingerprints are recomputed here, by the same function
 * that mints them during import, and written in two phases because a row cannot
 * take a fingerprint another row has not yet given up.
 */
import { query, withTransaction } from './db';
import { taskFingerprint } from './core/ingest';
import { keyify } from './core/normalize';

export interface RefileResult {
  /** Rows whose department changed. */
  moved: number;
  /** What moved where, for the person who pressed the button. */
  changes: { from: string; to: string; tasks: number }[];
  /** People on the roster who have no imported work at all. */
  rosterWithoutWork: string[];
  /** Rows still unassigned afterwards, and the names behind them. */
  stillUnassigned: { employee: string; tasks: number }[];
}

interface TaskRow {
  task_id: string; task_date: string; employee_name: string;
  department: string | null; task_normalized: string; task_status: string;
  source_document_id: string | null;
}

/**
 * Applies the roster to work already imported.
 *
 * Only ever moves a row TO a department the roster states for that person. It
 * never clears a department, never invents one, and never touches a row whose
 * employee it does not recognise — an unrecognised name is a gap in the roster,
 * not a licence to guess.
 */
export async function refileByRoster(ownerUserId: number): Promise<RefileResult> {
  const roster = await query<{ employee_name: string; department: string; name_aliases: string[] }>(
    `select employee_name, department, name_aliases
       from employees
      where active and department is not null and department <> '' and not auto_created`);

  // Name and every alias point at the same department, so a report that says
  // "Rahul K" is re-filed exactly like one that says "Rahul Koli".
  const deptOf = new Map<string, string>();
  // And at the same PERSON. Before the roster existed the importer had no way
  // to know the two were one man, so it created a record for each, and the
  // dashboard listed him twice — under two departments, with his work split
  // between them and neither total right. Now that the organisation has said
  // which names are his, the rows can carry the name he is actually called.
  const nameOf = new Map<string, string>();
  for (const e of roster) {
    deptOf.set(keyify(e.employee_name), e.department);
    nameOf.set(keyify(e.employee_name), e.employee_name);
    (e.name_aliases || []).forEach(a => {
      if (!a) return;
      deptOf.set(keyify(a), e.department);
      nameOf.set(keyify(a), e.employee_name);
    });
  }

  const tasks = await query<TaskRow>(
    `select task_id, task_date::text as task_date, employee_name, department,
            task_normalized, task_status, source_document_id
       from tasks where owner_user_id = $1 order by task_id`, [ownerUserId]);

  if (!deptOf.size || !tasks.length) {
    return { moved: 0, changes: [], rosterWithoutWork: roster.map(r => r.employee_name),
             stillUnassigned: [] };
  }

  // The department and the name each row SHOULD have. Unrecognised people keep
  // exactly what they had — an unknown name is a gap in the roster, not a
  // licence to rename somebody.
  const target = new Map<string, string>();
  const targetName = new Map<string, string>();
  for (const t of tasks) {
    const k = keyify(t.employee_name);
    target.set(t.task_id, deptOf.get(k) || (t.department || ''));
    targetName.set(t.task_id, nameOf.get(k) || t.employee_name);
  }

  // Ordinals have to be reconstructed exactly as import assigns them, or the
  // recomputed fingerprints will not match the ones a re-sent copy of the same
  // report produces — and the duplicate guard this whole exercise exists to
  // protect would be the thing it broke.
  //
  // Import counts WITHIN ONE DOCUMENT and starts at 1: two identical rows in one
  // report are a genuine pair, while the same row arriving in a second report is
  // a duplicate and is meant to collide. Counting across documents here, or from
  // zero, silently reproduces neither behaviour.
  const ordinal = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const t of tasks) {
    const key = [t.source_document_id || '', t.task_date,
                 keyify(targetName.get(t.task_id) || ''),
                 keyify(target.get(t.task_id) || ''),
                 t.task_normalized, t.task_status].join('|');
    const n = (seen.get(key) || 0) + 1;
    ordinal.set(t.task_id, n);
    seen.set(key, n);
  }

  const updates = tasks
    .filter(t => (target.get(t.task_id) || '') !== (t.department || '') ||
                 targetName.get(t.task_id) !== t.employee_name)
    .map(t => ({
      taskId: t.task_id,
      from: t.department || 'Unassigned',
      to: target.get(t.task_id) as string,
      employee: targetName.get(t.task_id) as string,
      fingerprint: taskFingerprint(
        t.task_date, targetName.get(t.task_id) as string, target.get(t.task_id) as string,
        t.task_normalized, t.task_status, ordinal.get(t.task_id) as number)
    }));

  if (updates.length) {
    // Two statements for the whole job, not two per row. The database is in
    // Tokyo and the application runs in Virginia: at ~180ms a round trip, a
    // loop over 282 rows is 564 trips and about a minute and a half, so the
    // request would be killed long before the manager saw anything.
    await withTransaction(async q => {
      // Phase one: park every moving row on a fingerprint nothing else can
      // hold, so the unique constraint cannot fire on an intermediate state.
      await q(
        `update tasks set task_fingerprint = 'refiling:' || task_id
          where task_id = any($1::text[])`,
        [updates.map(u => u.taskId)]);
      // Phase two: the real values.
      await q(
        `update tasks t
            set department = v.department, employee_name = v.employee,
                task_fingerprint = v.fingerprint
           from jsonb_to_recordset($1::jsonb)
                  as v(task_id text, department text, employee text, fingerprint text)
          where t.task_id = v.task_id`,
        [JSON.stringify(updates.map(u => ({
          task_id: u.taskId, department: u.to, employee: u.employee,
          fingerprint: u.fingerprint
        })))]);

      // The record the importer invented for the alias has nothing left under
      // it. Only ever one it invented: a person the organisation configured is
      // never removed by a re-file, whatever their name looks like.
      const merged = [...new Set(updates.map(u => u.employee))];
      if (merged.length) {
        await q(
          `delete from employees e
            where e.auto_created
              and lower(e.employee_name) <> all($1::text[])
              and not exists (select 1 from tasks t
                               where t.employee_name = e.employee_name)`,
          [merged.map(m => m.toLowerCase())]);
      }
    });
  }

  // Keyed on the pair itself, not on a joined string: department names contain
  // spaces, so splitting one back apart would lose half of it.
  const byMove = new Map<string, { from: string; to: string; tasks: number }>();
  updates.forEach(u => {
    const k = u.from + ' -> ' + u.to;
    const prior = byMove.get(k);
    byMove.set(k, { from: u.from, to: u.to, tasks: (prior?.tasks || 0) + 1 });
  });

  const withWork = new Set(tasks.map(t => keyify(targetName.get(t.task_id) || t.employee_name)));
  const stillUnassigned = new Map<string, number>();
  tasks.forEach(t => {
    if ((target.get(t.task_id) || '') === '') {
      const n = targetName.get(t.task_id) || t.employee_name;
      stillUnassigned.set(n, (stillUnassigned.get(n) || 0) + 1);
    }
  });

  return {
    moved: updates.length,
    changes: [...byMove.values()].sort((a, b) => b.tasks - a.tasks),
    rosterWithoutWork: roster
      .filter(e => !withWork.has(keyify(e.employee_name)) &&
                   !(e.name_aliases || []).some(a => withWork.has(keyify(a))))
      .map(e => e.employee_name),
    stillUnassigned: [...stillUnassigned.entries()]
      .map(([employee, tasksCount]) => ({ employee, tasks: tasksCount }))
      .sort((a, b) => b.tasks - a.tasks)
  };
}
