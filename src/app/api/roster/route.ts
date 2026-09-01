import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { loadRoster, upsertRoster } from '@/lib/db';
import { parseRoster, rosterDepartmentId, rosterEmployeeId } from '@/lib/roster';
import { refileByRoster } from '@/lib/refile';
import { safeErrorMessage } from '@/lib/safe-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Importing the organisation's roster.
 *
 * POST with `{ text }` — whatever was pasted or uploaded — and optionally
 * `{ preview: true }` to see what would happen without writing anything.
 * The preview matters: a roster import changes how every future report is
 * filed, so nobody should have to run it to find out what it does.
 */

/** A paste large enough to be a mistake rather than a company. */
const MAX_CHARS = 500_000;

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  try {
    return NextResponse.json(await loadRoster());
  } catch (e) {
    return NextResponse.json({ error: safeErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const text = String((body as { text?: unknown })?.text ?? '');
  const preview = Boolean((body as { preview?: unknown })?.preview);

  if (!text.trim()) {
    return NextResponse.json(
      { error: 'Paste the roster first — one row per person, with a department.' },
      { status: 400 });
  }
  if (text.length > MAX_CHARS) {
    return NextResponse.json(
      { error: `That is ${text.length.toLocaleString()} characters, which is far more than a ` +
               `staff list. Paste the roster sheet on its own.` }, { status: 400 });
  }

  const parsed = parseRoster(text);

  if (!parsed.people.length && !parsed.departments.length) {
    return NextResponse.json({
      error: parsed.rejected.length
        ? `Nothing could be read. First problem: ${parsed.rejected[0].reason}`
        : 'No employee or department columns were recognised. The sheet needs at ' +
          'least a name column and a department column — they can be called ' +
          'anything sensible.'
    }, { status: 400 });
  }

  const people = parsed.people.map(p => ({ ...p, id: rosterEmployeeId(p.name) }));
  const departments = parsed.departments.map(d => ({ ...d, id: rosterDepartmentId(d.name) }));

  if (preview) {
    return NextResponse.json({
      preview: true,
      mapping: parsed.mapping,
      people, departments,
      rejected: parsed.rejected
    });
  }

  try {
    const written = await upsertRoster(people, departments);

    // Saving the list and stopping there would be a trap. Syncing again imports
    // nothing — those messages are processed and those rows exist — so the work
    // already on the dashboard would sit in "Unassigned" for ever while the
    // screen insisted the roster was saved. Applying it to what is already here
    // is the half that makes the other half true.
    const refiled = await refileByRoster(session.userId);

    return NextResponse.json({
      ok: true,
      mapping: parsed.mapping,
      written,
      refiled,
      rejected: parsed.rejected,
      note: refiled.moved
        ? `Saved, and ${refiled.moved} ${refiled.moved === 1 ? 'row' : 'rows'} ` +
          `already imported moved to the right department.`
        : 'Saved. Reports from now on will be filed using this roster.'
    });
  } catch (e) {
    return NextResponse.json({ error: safeErrorMessage(e) }, { status: 500 });
  }
}
