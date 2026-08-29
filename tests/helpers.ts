/** Shared test setup: a clean database with schema + every migration applied. */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function resetDatabase(db: any, seedDb: any, opts = { demo: true }) {
  const base = join(__dirname, '..', 'supabase');
  await db.query('drop schema public cascade; create schema public;');
  await db.query(readFileSync(join(base, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(base, 'migrations')).filter(x => x.endsWith('.sql')).sort()) {
    await db.query(readFileSync(join(base, 'migrations', f), 'utf8'));
  }
  await seedDb.seedDatabase({ includeDemoEmployees: opts.demo });
}
