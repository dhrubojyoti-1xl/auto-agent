/**
 * Google OAuth 2.0 — authorisation-code flow with offline access.
 *
 * Scopes are deliberately minimal:
 *   openid, email, profile      to know who signed in
 *   gmail.readonly              to READ report emails and attachments
 *
 * gmail.readonly cannot send, delete, label or modify anything. The assistant
 * observes the inbox; it never touches it. That is the difference between this
 * and the Apps Script approach, which needed gmail.modify to apply labels.
 */
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly'
];

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function clientId(): string {
  const v = process.env.GOOGLE_CLIENT_ID;
  if (!v) throw new Error('GOOGLE_CLIENT_ID is not set.');
  return v;
}
function clientSecret(): string {
  const v = process.env.GOOGLE_CLIENT_SECRET;
  if (!v) throw new Error('GOOGLE_CLIENT_SECRET is not set.');
  return v;
}

/** Redirect URI must match the Google Cloud console entry exactly. */
export function redirectUri(origin: string): string {
  return process.env.GOOGLE_REDIRECT_URI || `${origin}/api/auth/google/callback`;
}

export function buildAuthUrl(origin: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    // offline + consent is what yields a refresh token. Without prompt=consent
    // Google silently omits it on re-authorisation, and the next unattended
    // sync fails with no obvious cause.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  id_token?: string;
}

export async function exchangeCode(code: string, origin: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(origin),
      grant_type: 'authorization_code'
    })
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    // invalid_grant means the user revoked access or changed their password.
    // Surface it distinctly so the UI can ask them to reconnect rather than
    // retrying forever.
    const err = new Error(`Google token refresh failed (${res.status}): ${body}`);
    (err as Error & { code?: string }).code = body.includes('invalid_grant') ? 'REAUTH_REQUIRED' : 'REFRESH_FAILED';
    throw err;
  }
  return res.json();
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token })
  }).catch(() => { /* revocation is best-effort */ });
}

/** Decodes the id_token payload. Signature is not verified because the token
 *  came straight from Google's endpoint over TLS in a server-to-server call. */
export function decodeIdToken(idToken: string): {
  sub: string; email: string; name?: string; picture?: string; email_verified?: boolean;
} {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('Malformed id_token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
