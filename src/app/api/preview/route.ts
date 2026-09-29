import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { engineConfig, previewDocument } from '@/lib/pipeline';
import { pastedDocument } from '@/lib/paste';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Parses and validates WITHOUT writing anything. Powers the review screen. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const content = String(body.content || '');
  if (!content.trim()) return NextResponse.json({ error: 'Nothing to parse' }, { status: 400 });

  // The id is derived from the CONTENT, so previewing then committing the
  // same paste twice is recognised as the same document.
  const result = await previewDocument(
    pastedDocument(body, engineConfig().dateOrder), session.userId);
  return NextResponse.json(result);
}
