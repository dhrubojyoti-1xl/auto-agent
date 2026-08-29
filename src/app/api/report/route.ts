import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { generateReport } from '@/lib/reporting';
import type { ReportType } from '@/lib/core/ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const type = (String(body?.type || 'DAILY').toUpperCase() as ReportType);
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(type)) {
    return NextResponse.json({ error: 'Unknown report type' }, { status: 400 });
  }
  try {
    const r = await generateReport(type, session.userId, body?.date, body?.useAi !== false);
    return NextResponse.json({
      reportId: r.reportId, status: r.status, generator: r.generator,
      model: r.model, periodStart: r.periodStart, periodEnd: r.periodEnd,
      humanReport: r.humanReport, validationError: r.validationError
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
