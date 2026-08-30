/**
 * Idempotent master-data seeding. Safe to run on every deploy.
 */
import { query } from './db';
import {
  HEADER_ALIASES, SEED_CATEGORIES, SEED_DEPARTMENTS, SEED_EMPLOYEES, STATUS_ALIASES
} from './seed';

const STATUS_ROWS: [string, boolean, boolean, number][] = [
  ['Completed', true, true, 1],
  ['In Progress', false, false, 2],
  ['Pending', false, false, 3],
  ['Blocked', false, false, 4],
  ['Not Started', false, false, 5],
  ['Cancelled', false, true, 6],
  // Recorded, never resolved: a cell naming two states at once is kept as it
  // is and left out of every figure.
  ['Ambiguous', false, false, 7]
];

export interface SeedOptions {
  /** Demo employees are useful for a first look and wrong for production. */
  includeDemoEmployees?: boolean;
}

export async function seedDatabase(opts: SeedOptions = {}): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const [status, completed, terminal, order] of STATUS_ROWS) {
    await query(
      `insert into statuses (status, active, counts_as_completed, is_terminal, sort_order)
       values ($1, true, $2, $3, $4) on conflict (status) do nothing`,
      [status, completed, terminal, order]
    );
  }
  counts.statuses = STATUS_ROWS.length;

  for (const [alias, canonical] of Object.entries(STATUS_ALIASES)) {
    await query(
      `insert into status_aliases (alias, canonical_status) values ($1,$2)
       on conflict (alias) do update set canonical_status = excluded.canonical_status`,
      [alias, canonical]
    );
  }
  counts.statusAliases = Object.keys(STATUS_ALIASES).length;

  for (const [alias, field] of Object.entries(HEADER_ALIASES)) {
    await query(
      `insert into header_aliases (alias, canonical_field) values ($1,$2)
       on conflict (alias) do update set canonical_field = excluded.canonical_field`,
      [alias, field]
    );
  }
  counts.headerAliases = Object.keys(HEADER_ALIASES).length;

  for (const d of SEED_DEPARTMENTS) {
    await query(
      `insert into departments (department_id, department_name, name_aliases, sender_domains, active)
       values ($1,$2,$3,$4,true) on conflict (department_id) do nothing`,
      [d.id, d.name, d.aliases, d.senderDomains]
    );
  }
  counts.departments = SEED_DEPARTMENTS.length;

  for (const c of SEED_CATEGORIES) {
    await query(
      `insert into task_categories (category_id, category_name, match_keywords, expected_duration, active)
       values ($1,$2,$3,$4,true) on conflict (category_id) do nothing`,
      [c.id, c.name, c.keywords, c.expectedDuration]
    );
  }
  counts.categories = SEED_CATEGORIES.length;

  if (opts.includeDemoEmployees) {
    for (const e of SEED_EMPLOYEES) {
      await query(
        `insert into employees (employee_id, employee_name, name_aliases, department, active)
         values ($1,$2,$3,$4,true) on conflict (employee_id) do nothing`,
        [e.id, e.name, e.aliases, e.department]
      );
    }
    counts.employees = SEED_EMPLOYEES.length;
  }
  return counts;
}
