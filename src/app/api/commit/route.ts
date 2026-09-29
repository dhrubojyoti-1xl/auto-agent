import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { commitDocument, engineConfig } from '@/lib/pipeline';
import { pastedDocument } from '@/lib/paste';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const content = String(body.content || '');
  if (!content.trim()) return NextResponse.json({ error: 'Nothing to import' }, { status: 400 });

  try {
    const result = await commitDocument(
      pastedDocument(body, engineConfig().dateOrder), 'paste', session.userId);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
