/**
 * The notice that explains an unnamed bar on the dashboard.
 *
 * The old condition required every department to be Unassigned before it would
 * say anything. Harshal's real dashboard was 47 unassigned rows sitting beside
 * three named departments, so the notice never appeared and the largest bar on
 * his screen had no explanation and no next step. It also pointed at a page
 * that could not fix it, and promised the change would show up "from the next
 * sync" — which was never true, because syncing again imports nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const overview = readFileSync(join(process.cwd(), 'src/app/page.tsx'), 'utf8');
const management = readFileSync(join(process.cwd(), 'src/app/management/page.tsx'), 'utf8');

describe('unassigned work explains itself', () => {
  it('does not wait for every department to be unassigned', () => {
    // The specific shape of the old bug: a length check standing in for
    // "is any of this unattributed".
    expect(overview).not.toMatch(/departments\.length === 1 &&/);
  });

  for (const [name, src] of [['overview', overview], ['management', management]] as const) {
    it(`${name} looks for an unassigned department among the others`, () => {
      expect(src).toMatch(/'Unassigned'\s*\n?\s*\|\|/);
    });

    it(`${name} sends the reader to the page that can fix it`, () => {
      expect(src).toMatch(/href="\/roster"/);
    });

    it(`${name} does not promise the fix arrives with the next sync`, () => {
      expect(src).not.toMatch(/from the next sync/);
    });
  }
});
