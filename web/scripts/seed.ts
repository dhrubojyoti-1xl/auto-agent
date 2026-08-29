/**
 * Applies the schema and seeds master data.
 *   npm run seed          masters only (production-safe)
 *   npm run seed -- --demo  also inserts the 10 demo employees
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getPool, query } from '../src/lib/db';
import { seedDatabase } from '../src/lib/seed-db';

async function main() {
  const base = join(__dirname, '..', 'supabase');
  await query(readFileSync(join(base, 'schema.sql'), 'utf8'));
  console.log('schema applied');

  const migrations = join(base, 'migrations');
  for (const f of readdirSync(migrations).filter(x => x.endsWith('.sql')).sort()) {
    await query(readFileSync(join(migrations, f), 'utf8'));
    console.log('migration applied:', f);
  }
  const counts = await seedDatabase({ includeDemoEmployees: process.argv.includes('--demo') });
  console.log('seeded:', counts);
  await getPool().end();
}

main().catch(e => { console.error(e); process.exit(1); });
