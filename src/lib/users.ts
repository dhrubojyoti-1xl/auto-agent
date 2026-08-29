/** User records created by "Continue with Google". */
import { query } from './db';

export interface AppUser {
  id: number;
  googleSub: string | null;
  email: string;
  displayName: string;
  pictureUrl: string;
  kind: 'google' | 'local';
  lastLoginAt: string | null;
}

function toUser(r: Record<string, unknown>): AppUser {
  return {
    id: Number(r.id),
    googleSub: r.google_sub ? String(r.google_sub) : null,
    email: String(r.email),
    displayName: String(r.display_name ?? r.email),
    pictureUrl: String(r.picture_url ?? ''),
    kind: (String(r.kind) as 'google' | 'local'),
    lastLoginAt: r.last_login_at ? String(r.last_login_at) : null
  };
}

export async function upsertGoogleUser(p: {
  googleSub: string; email: string; displayName: string; pictureUrl: string;
}): Promise<AppUser> {
  const rows = await query<Record<string, unknown>>(
    `insert into users (google_sub, email, display_name, picture_url, kind, last_login_at)
     values ($1,$2,$3,$4,'google', now())
     on conflict (google_sub) do update set
       email = excluded.email,
       display_name = excluded.display_name,
       picture_url = excluded.picture_url,
       last_login_at = now()
     returning *`,
    [p.googleSub, p.email, p.displayName, p.pictureUrl]
  );
  return toUser(rows[0]);
}

export async function touchLocalUser(): Promise<AppUser> {
  const rows = await query<Record<string, unknown>>(
    `update users set last_login_at = now() where id = 1 returning *`);
  if (rows.length) return toUser(rows[0]);
  const created = await query<Record<string, unknown>>(
    `insert into users (id, email, display_name, kind, last_login_at)
     values (1,'local@localhost','Local admin','local', now())
     on conflict (id) do update set last_login_at = now() returning *`);
  return toUser(created[0]);
}

export async function getUser(id: number): Promise<AppUser | null> {
  const rows = await query<Record<string, unknown>>('select * from users where id = $1', [id]);
  return rows.length ? toUser(rows[0]) : null;
}
