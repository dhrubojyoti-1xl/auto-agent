import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { disconnectGmailAccount } from '@/lib/accounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  const body = await req.json().catch(() => null);
  const id = Number(body?.id);
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  // Scoped: an id alone must not let one user disconnect another's mailbox.
  await disconnectGmailAccount(id, session.userId);
  return NextResponse.json({ ok: true });
}
