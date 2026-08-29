/**
 * Connected Google accounts: storage, token lifecycle, and access-token
 * caching within a request.
 */
import { decryptSecret, encryptSecret } from './crypto';
import { query } from './db';
import { refreshAccessToken, revokeToken } from './google-oauth';

export interface GmailAccount {
  id: number;
  email: string;
  googleSub: string;
  displayName: string;
  pictureUrl: string;
  refreshTokenEnc: string;
  scopes: string[];
  connectedAt: string;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
  syncSince: string;
  active: boolean;
}

function rowToAccount(r: Record<string, unknown>): GmailAccount {
  return {
    id: Number(r.id), email: String(r.email), googleSub: String(r.google_sub),
    displayName: String(r.display_name ?? ''), pictureUrl: String(r.picture_url ?? ''),
    refreshTokenEnc: String(r.refresh_token_enc), scopes: (r.scopes as string[]) || [],
    connectedAt: String(r.connected_at),
    lastSyncAt: r.last_sync_at ? String(r.last_sync_at) : null,
    lastSyncStatus: r.last_sync_status ? String(r.last_sync_status) : null,
    lastSyncMessage: r.last_sync_message ? String(r.last_sync_message) : null,
    syncSince: String(r.sync_since), active: Boolean(r.active)
  };
}

export async function listGmailAccounts(): Promise<GmailAccount[]> {
  const rows = await query<Record<string, unknown>>(
    `select * from gmail_accounts where active order by connected_at`);
  return rows.map(rowToAccount);
}

export async function getGmailAccount(id: number): Promise<GmailAccount | null> {
  const rows = await query<Record<string, unknown>>(
    `select * from gmail_accounts where id = $1`, [id]);
  return rows.length ? rowToAccount(rows[0]) : null;
}

export async function upsertGmailAccount(a: {
  email: string; googleSub: string; displayName: string; pictureUrl: string;
  refreshToken: string; scopes: string[];
}): Promise<GmailAccount> {
  const rows = await query<Record<string, unknown>>(
    `insert into gmail_accounts
       (email, google_sub, display_name, picture_url, refresh_token_enc, scopes, active, revoked_at)
     values ($1,$2,$3,$4,$5,$6,true,null)
     on conflict (google_sub) do update set
       email = excluded.email,
       display_name = excluded.display_name,
       picture_url = excluded.picture_url,
       refresh_token_enc = excluded.refresh_token_enc,
       scopes = excluded.scopes,
       active = true,
       revoked_at = null,
       connected_at = now()
     returning *`,
    [a.email, a.googleSub, a.displayName, a.pictureUrl,
     encryptSecret(a.refreshToken), a.scopes]
  );
  return rowToAccount(rows[0]);
}

export async function recordSyncResult(id: number, status: string, message: string): Promise<void> {
  await query(
    `update gmail_accounts set last_sync_at = now(), last_sync_status = $2,
       last_sync_message = $3 where id = $1`,
    [id, status, message.slice(0, 1000)]
  );
}

export async function disconnectGmailAccount(id: number): Promise<void> {
  const acct = await getGmailAccount(id);
  if (!acct) return;
  // Best-effort revocation at Google, then forget the token locally. Order
  // matters: if revocation fails we still stop holding the credential.
  try { await revokeToken(decryptSecret(acct.refreshTokenEnc)); } catch { /* ignore */ }
  await query(
    `update gmail_accounts set active = false, revoked_at = now(),
       refresh_token_enc = 'revoked' where id = $1`, [id]);
}

/**
 * Access tokens last an hour; they are fetched per sync and never persisted.
 *
 * The cache is keyed by account AND by the stored refresh token, so
 * reconnecting an account cannot hand back a token minted from the old grant.
 * It is also invalidated explicitly when Gmail answers 401, which is what
 * happens the moment a user revokes access at myaccount.google.com.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function cacheKey(account: GmailAccount): string {
  return `${account.id}:${account.refreshTokenEnc.slice(-24)}`;
}

export function invalidateAccessToken(account: GmailAccount): void {
  tokenCache.delete(cacheKey(account));
}

export function clearTokenCache(): void { tokenCache.clear(); }

export async function getAccessTokenFor(
  account: GmailAccount, forceRefresh = false
): Promise<string> {
  const key = cacheKey(account);
  if (!forceRefresh) {
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  }
  const refresh = decryptSecret(account.refreshTokenEnc);
  const res = await refreshAccessToken(refresh);
  tokenCache.set(key, {
    token: res.access_token,
    expiresAt: Date.now() + (res.expires_in || 3600) * 1000
  });
  return res.access_token;
}

export async function listSyncRuns(limit = 20) {
  const rows = await query<Record<string, unknown>>(
    `select r.*, a.email from sync_runs r
       left join gmail_accounts a on a.id = r.gmail_account_id
     order by r.started_at desc limit $1`, [limit]);
  return rows.map(r => ({
    id: Number(r.id), email: String(r.email ?? ''), trigger: String(r.trigger),
    status: String(r.status), startedAt: String(r.started_at),
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    messagesScanned: Number(r.messages_scanned), reportsFound: Number(r.reports_found),
    rowsImported: Number(r.rows_imported), rowsRejected: Number(r.rows_rejected),
    rowsDuplicate: Number(r.rows_duplicate),
    errorMessage: r.error_message ? String(r.error_message) : ''
  }));
}
