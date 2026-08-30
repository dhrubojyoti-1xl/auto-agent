import { NextResponse } from 'next/server';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getSession } from '@/lib/auth';
import { query } from '@/lib/db';
import { seedDatabase } from '@/lib/seed-db';
import { safeErrorMessage } from '@/lib/safe-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * First-run setup: apply schema.sql, then every migration in order, then seed
 * the master data.
 *
 * This exists because the deployment holds the only copy of DATABASE_URL —
 * Vercel redacts Sensitive variables on `env pull`, so nobody can run the
 * migration from a laptop without re-entering the database password. The
 * server already has the connection, so it does the work.
 *
 * Requires a signed-in session. Every statement is idempotent, so calling it
 * twice is a no-op rather than a hazard.
 */
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });

  const applied: string[] = [];
  try {
    const base = join(process.cwd(), 'supabase');
    await query(readFileSync(join(base, 'schema.sql'), 'utf8'));
    applied.push('schema.sql');

    const migrations = readdirSync(join(base, 'migrations'))
      .filter(f => f.endsWith('.sql')).sort();
    for (const f of migrations) {
      await query(readFileSync(join(base, 'migrations', f), 'utf8'));
      applied.push(f);
    }

    const counts = await seedDatabase({ includeDemoEmployees: false });

    const [tables] = await query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`);
    const [views] = await query<{ n: number }>(
      `select count(*)::int as n from information_schema.views where table_schema = 'public'`);

    return NextResponse.json({
      ok: true, applied, seeded: counts,
      tables: tables.n, views: views.n
    });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e, 400), applied }, { status: 500 });
  }
}
