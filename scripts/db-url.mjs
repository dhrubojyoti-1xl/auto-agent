#!/usr/bin/env node
/**
 * Build, validate and TEST a Postgres connection string.
 *
 *   node scripts/db-url.mjs build  <ref> <password> <mode> [poolerHost]
 *   node scripts/db-url.mjs verify <url>
 *
 * `build` prints the URL on stdout and nothing else, so the caller can capture
 * it without it reaching a log. `verify` prints a SANITISED description and
 * exits non-zero if the URL is malformed or unreachable — the password is never
 * printed by either path.
 */
import pg from 'pg';
import dns from 'dns/promises';

const [, , cmd, ...args] = process.argv;

function fail(msg) { console.error(msg); process.exit(1); }

/** Never let a redacted or placeholder value through. */
export function looksRedacted(v) {
  return !v || v === '[SENSITIVE]' || v.includes('[YOUR-PASSWORD]') ||
         v.includes('YOUR-PASSWORD') || v === 'undefined' || v === 'null';
}

function build(ref, password, mode, poolerHost) {
  if (!ref) fail('project ref required');
  if (looksRedacted(password)) fail('refusing to build a URL from an empty or placeholder password');
  const enc = encodeURIComponent(password);
  if (mode === 'direct') {
    return `postgresql://postgres:${enc}@db.${ref}.supabase.co:5432/postgres`;
  }
  const host = poolerHost || `aws-0-ap-south-1.pooler.supabase.com`;
  return `postgresql://postgres.${ref}:${enc}@${host}:6543/postgres`;
}

function describe(url) {
  let u;
  try { u = new URL(url); } catch { fail('DATABASE_URL is not a parseable URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) {
    fail(`DATABASE_URL scheme is ${u.protocol!==''?u.protocol:'(none)'}, expected postgresql:`);
  }
  const db = u.pathname.replace(/^\//, '');
  const info = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || '(default 5432)',
    database: db,
    username: u.username,
    passwordLength: (u.password || '').length
  };
  // "base" is the specific artefact of pg-connection-string falling back to
  // libpq keyword parsing on a non-URL value such as Vercel's [SENSITIVE].
  // That is what produced "getaddrinfo ENOTFOUND base". localhost is fine.
  if (info.hostname === 'base' || info.hostname === '') {
    fail(`DATABASE_URL hostname is "${info.hostname}" — not a real host. This is what ` +
         `a redacted value such as [SENSITIVE] parses to. The real value never ` +
         `reached this process.`);
  }
  if (!db) fail('DATABASE_URL has no database name');
  if (!u.username) fail('DATABASE_URL has no username');
  if (looksRedacted(u.password)) fail('DATABASE_URL password is empty or a placeholder');
  return info;
}

async function verify(url) {
  const info = describe(url);
  console.log('  protocol :', info.protocol);
  console.log('  hostname :', info.hostname);
  console.log('  port     :', info.port);
  console.log('  database :', info.database);
  console.log('  username :', info.username);
  console.log('  password : ' + info.passwordLength + ' chars (not shown)');

  try {
    const { address } = await dns.lookup(info.hostname);
    console.log('  dns      : resolves to', address.replace(/\d+$/, 'x'));
  } catch {
    fail(`  dns      : ${info.hostname} does NOT resolve. Copy the exact host from the ` +
         `Supabase Connect panel; pooler hosts differ by region (aws-0 / aws-1).`);
  }

  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 15000,
    ssl: /supabase|amazonaws|neon|render/i.test(url) ? { rejectUnauthorized: false } : undefined
  });
  try {
    const r = await pool.query('select current_database() as db, version() as v');
    console.log('  connect  : OK —', r.rows[0].db, '|', String(r.rows[0].v).split(' ').slice(0, 2).join(' '));
    await pool.end();
  } catch (e) {
    await pool.end().catch(() => {});
    const m = String(e.message);
    if (/password authentication failed/i.test(m)) {
      fail('  connect  : password rejected by Postgres. Reset it in Supabase and retry.');
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(m)) {
      fail(`  connect  : host ${info.hostname} not reachable.`);
    }
    if (/Tenant or user not found/i.test(m)) {
      fail('  connect  : pooler rejected the username. It must be postgres.<project-ref>.');
    }
    fail('  connect  : ' + m.slice(0, 160));
  }
}

if (cmd === 'build') {
  process.stdout.write(build(args[0], args[1], args[2], args[3]));
} else if (cmd === 'verify') {
  await verify(args[0]);
} else {
  fail('usage: db-url.mjs build <ref> <password> <pooler|direct> [host] | verify <url>');
}
