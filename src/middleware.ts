/**
 * Gate every page and private API behind the session cookie.
 *
 * The middleware only checks the SHAPE of the cookie; the HMAC is verified in
 * the route handlers, because Next.js middleware runs on the edge runtime where
 * node:crypto is unavailable. A forged cookie therefore gets past the redirect
 * but is rejected by every handler that actually returns data.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// /api/auth/google is public because it IS the login: "Continue with Google"
// must work for someone who has no session yet. Its callback validates the
// state cookie and Google's response before issuing one.
// These paths authenticate themselves and must bypass the session gate.
//
// /api/cron is the one that bites: Vercel Cron calls it with a bearer token and
// no session cookie, so leaving it behind the session middleware silently
// disables the entire scheduled sync — the automation the product exists for.
// The route still verifies CRON_SECRET itself, so this is not a hole.
const PUBLIC_PATHS = [
  '/login', '/api/login', '/api/auth/google', '/api/cron', '/api/ingest', '/api/health'
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  const cookie = req.cookies.get('aa_session')?.value;
  const looksValid = !!cookie && cookie.split('.').length === 5;
  if (looksValid) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
};
