import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { previewDocument } from '@/lib/pipeline';
import { shortHash } from '@/lib/core/normalize';

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

  const subject = String(body.subject || 'Pasted report');
  const isHtml = /<\s*(table|tr|td|div|p)\b/i.test(content);

  const result = await previewDocument({
    // The id is derived from the CONTENT, so previewing then committing the
    // same paste twice is recognised as the same document.
    documentId: 'PASTE-' + shortHash(subject + '|' + content, 16),
    subject,
    sender: String(body.sender || 'dashboard@local'),
    receivedAt: new Date().toISOString(),
    html: isHtml ? content : undefined,
    text: isHtml ? undefined : content
  }, session.userId);
  return NextResponse.json(result);
}
