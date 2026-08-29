import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { rebuildAnalysis } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  if (!await isAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }
  try {
    return NextResponse.json(await rebuildAnalysis());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
