import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * The pending-update banner is only trustworthy if every column it demands is
 * actually created somewhere in schema.sql or the migrations. A typo in the
 * required list would show a banner that pressing the button can never clear.
 */
describe('schema status expectations are satisfiable', () => {
  const base = join(process.cwd(), 'supabase');
  const sql = [readFileSync(join(base, 'schema.sql'), 'utf8'),
    ...readdirSync(join(base, 'migrations')).filter(f => f.endsWith('.sql'))
      .map(f => readFileSync(join(base, 'migrations', f), 'utf8'))].join('\n').toLowerCase();
  const src = readFileSync(join(process.cwd(), 'src/lib/schema-status.ts'), 'utf8');

  const columns = [...src.matchAll(/\['(\w+)', '(\w+)'\]/g)].map(m => [m[1], m[2]]);
  const views = (src.match(/const REQUIRED_VIEWS = \[([\s\S]*?)\]/) || [, ''])[1]
    .split(',').map(s => s.trim().replace(/['\s]/g, '')).filter(Boolean);

  it('lists at least the columns and views the code reads', () => {
    expect(columns.length).toBeGreaterThan(4);
    expect(views.length).toBeGreaterThan(3);
  });

  for (const [t, c] of columns) {
    it(`${t}.${c} is created by the SQL`, () => {
      expect(sql).toContain(c);
    });
  }
  for (const v of views) {
    it(`view ${v} is created by the SQL`, () => {
      expect(sql).toMatch(new RegExp(`create (or replace )?view ${v}\\b`));
    });
  }
});
