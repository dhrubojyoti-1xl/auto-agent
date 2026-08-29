import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { issueToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth';
import { decodeIdToken, exchangeCode, GOOGLE_SCOPES } from '@/lib/google-oauth';
import { upsertGmailAccount } from '@/lib/accounts';
import { logEvent } from '@/lib/db';
import { upsertGoogleUser } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (msg: string) => NextResponse.redirect(new URL(`/login?error=${msg}`, req.url));

  const error = url.searchParams.get('error');
  if (error) return back(encodeURIComponent(error));

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = (await cookies()).get('g_state')?.value;
  if (!code) return back('missing_code');
  if (!state || !expected || state !== expected) return back('state_mismatch');

  try {
    const tokens = await exchangeCode(code, url.origin);

    // Without a refresh token the assistant cannot work unattended, which is
    // the entire point. Fail loudly rather than connecting something that will
    // stop working in an hour.
    if (!tokens.refresh_token) return back('no_refresh_token');

    const granted = (tokens.scope || '').split(' ');
    if (!granted.includes('https://www.googleapis.com/auth/gmail.readonly')) {
      return back('gmail_scope_denied');
    }
    if (!tokens.id_token) return back('no_id_token');

    const profile = decodeIdToken(tokens.id_token);

    // One consent yields both: the signed-in identity, and the mailbox that
    // identity will have read on its behalf.
    const user = await upsertGoogleUser({
      googleSub: profile.sub,
      email: profile.email,
      displayName: profile.name || profile.email,
      pictureUrl: profile.picture || ''
    });
    const account = await upsertGmailAccount({
      ownerUserId: user.id,
      email: profile.email,
      googleSub: profile.sub,
      displayName: profile.name || profile.email,
      pictureUrl: profile.picture || '',
      refreshToken: tokens.refresh_token,
      scopes: granted.length ? granted : GOOGLE_SCOPES
    });

    await logEvent('INFO', 'Auth', 'connect', 'OK',
      `Signed in and connected ${account.email}`, undefined, undefined, undefined);
    const res = NextResponse.redirect(new URL('/connect?connected=1&sync=1', req.url));
    res.cookies.set(SESSION_COOKIE, issueToken(user.id, 'google'), sessionCookieOptions());
    res.cookies.set('g_state', '', { path: '/', maxAge: 0 });
    return res;
  } catch (e) {
    await logEvent('ERROR', 'Auth', 'connect', 'ERROR', (e as Error).message);
    return back(encodeURIComponent((e as Error).message.slice(0, 120)));
  }
}
