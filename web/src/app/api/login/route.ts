import { NextResponse } from 'next/server';
import { checkPassword, issueToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let password = '';
  try {
    const body = await req.json();
    password = String(body?.password || '');
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  if (!password) return NextResponse.json({ error: 'Password required' }, { status: 400 });

  try {
    if (!checkPassword(password)) {
      // Deliberately slow and vague: no hint about whether the password was
      // close, and a small delay to blunt brute force.
      await new Promise(r => setTimeout(r, 600));
      return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, issueToken(), sessionCookieOptions());
  return res;
}
