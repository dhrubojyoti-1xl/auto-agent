import { NextResponse } from 'next/server';
import { checkIngestToken, LOCAL_USER_ID } from '@/lib/auth';
import { commitDocument } from '@/lib/pipeline';
import { shortHash } from '@/lib/core/normalize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Machine ingest. This is what the Apps Script Gmail bridge posts to, so Gmail
 * automation and this dashboard share one database.
 *
 * Auth is a bearer token, NOT the human session: a leaked ingest token can add
 * report data but cannot read the dashboard.
 */
export async function POST(req: Request) {
  if (!checkIngestToken(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const html = typeof body.html === 'string' ? body.html : undefined;
  const text = typeof body.text === 'string' ? body.text : undefined;
  if (!html && !text) {
    return NextResponse.json({ error: 'Provide html or text' }, { status: 400 });
  }
  const subject = String(body.subject || 'Report');
  // A stable id is what makes retries safe: the sender may post the same
  // message twice, and it must not become two reports.
  const documentId = String(body.documentId || 'API-' + shortHash(subject + '|' + (html || text), 16));

  try {
    const result = await commitDocument({
      documentId, subject,
      sender: String(body.sender || 'api'),
      receivedAt: String(body.receivedAt || new Date().toISOString()),
      html, text
    }, String(body.source || 'email'), LOCAL_USER_ID);

    return NextResponse.json({
      ok: true,
      reportId: result.reportId,
      status: result.status,
      rowsExtracted: result.rowsExtracted,
      rowsInserted: result.rowsWritten,
      rowsSkippedIdempotent: result.skippedIdempotent,
      rowsRejected: result.rejected.length,
      rejections: result.rejected.map(r => ({ reason: r.reason, detail: r.detail, raw: r.raw }))
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
