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

const PUBLIC_PATHS = ['/login', '/api/login', '/api/ingest', '/api/health'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  const cookie = req.cookies.get('aa_session')?.value;
  const looksValid = !!cookie && cookie.split('.').length === 3;
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
