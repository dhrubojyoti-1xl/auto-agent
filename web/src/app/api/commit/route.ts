import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { commitDocument } from '@/lib/pipeline';
import { shortHash } from '@/lib/core/normalize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!await isAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const content = String(body.content || '');
  if (!content.trim()) return NextResponse.json({ error: 'Nothing to import' }, { status: 400 });

  const subject = String(body.subject || 'Pasted report');
  const isHtml = /<\s*(table|tr|td|div|p)\b/i.test(content);

  try {
    const result = await commitDocument({
      documentId: 'PASTE-' + shortHash(subject + '|' + content, 16),
      subject,
      sender: String(body.sender || 'dashboard@local'),
      receivedAt: new Date().toISOString(),
      html: isHtml ? content : undefined,
      text: isHtml ? undefined : content
    }, 'paste');
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
