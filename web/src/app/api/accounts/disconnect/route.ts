import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { disconnectGmailAccount } from '@/lib/accounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!await isAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const id = Number(body?.id);
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await disconnectGmailAccount(id);
  return NextResponse.json({ ok: true });
}
