import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { rebuildAnalysis } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  try {
    return NextResponse.json(await rebuildAnalysis(session.userId));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
