/**
 * Applies the schema and seeds master data.
 *   npm run seed          masters only (production-safe)
 *   npm run seed -- --demo  also inserts the 10 demo employees
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPool, query } from '../src/lib/db';
import { seedDatabase } from '../src/lib/seed-db';

async function main() {
  const schema = readFileSync(join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
  await query(schema);
  console.log('schema applied');
  const counts = await seedDatabase({ includeDemoEmployees: process.argv.includes('--demo') });
  console.log('seeded:', counts);
  await getPool().end();
}

main().catch(e => { console.error(e); process.exit(1); });
