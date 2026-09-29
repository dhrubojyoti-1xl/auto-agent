/**
 * The 29-09-2026 user-flow audit, the parts that live below the pages.
 *
 *   F3  a table with only task and status columns, completed by the Manual
 *       entry form's Employee and Report date fields
 *   F7  /api/health printed " ue Sep 29 2026 07:" for the last sync
 *   F11 times carried no zone, and were read as local time
 *   F14 a guessed name that is a roster name spelt differently
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ingestDocument } from '../src/lib/core/ingest';
import { likelySamePerson } from '../src/lib/core/person-name';
import { DEFAULT_ENGINE_CONFIG } from '../src/lib/core/types';
import type { EngineConfig } from '../src/lib/core/types';
import { seedMasters } from '../src/lib/seed';
import { pastedDocument } from '../src/lib/paste';
import { formatStamp, isoStamp, zoneLabel } from '../src/lib/format-date';

const cfg: EngineConfig = { ...DEFAULT_ENGINE_CONFIG };
const TYPED = 'Task | Status | Time taken (Minutes)\nUpdated the store checklist | Completed | 30';

describe('F3: the Manual entry fields complete a table that names no one and no day', () => {
  it('imports a task-and-status table when both fields are filled in', () => {
    const d = pastedDocument({ content: TYPED, employee: 'Asha Rao', date: '25/09/2026' }, 'DMY');
    const res = ingestDocument(d, seedMasters([]), cfg, new Map());
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted).toHaveLength(1);
    const row = res.accepted[0];
    expect(row.employeeName).toBe('Asha Rao');
    expect(row.date).toBe('2026-09-25');
    expect(row.taskStatus).toBe('Completed');
    expect(row.actualDuration).toBe(0.5);
  });

  it('still refuses the same table with neither field, and says why in plain words', () => {
    const res = ingestDocument(
      pastedDocument({ content: TYPED }, 'DMY'), seedMasters([]), cfg, new Map());
    expect(res.accepted).toHaveLength(0);
    expect(res.message).not.toMatch(/alias/i);
    expect(res.message).toMatch(/Employee and Report date/);
  });

  it('does not loosen anything for email: a stated title date alone is not a form', () => {
    const res = ingestDocument({
      documentId: 'mail-1', subject: 'Notes', sender: 'Asha Rao <asha@example.com>',
      receivedAt: '2026-09-28T10:00:00Z', text: TYPED,
      titleDate: { date: '2026-09-25', quote: 'x' }
    }, seedMasters([]), cfg, new Map());
    // The sender stands in for the employee, as before; the date column is
    // still missing, so the rows are refused individually, not imported.
    expect(res.accepted).toHaveLength(0);
  });
});

describe('F7 and F11: times say which zone they are in', () => {
  const saved = process.env.DISPLAY_TIMEZONE;
  afterEach(() => {
    if (saved === undefined) delete process.env.DISPLAY_TIMEZONE;
    else process.env.DISPLAY_TIMEZONE = saved;
  });

  it('gives the health check a whole ISO timestamp from the Date the driver returns', () => {
    const d = new Date('2026-09-29T07:44:10.000Z');
    expect(isoStamp(d)).toBe('2026-09-29T07:44:10.000Z');
    expect(isoStamp(null)).toBe('never');
  });

  it('shows moments in India time by default, labelled', () => {
    delete process.env.DISPLAY_TIMEZONE;
    expect(formatStamp(new Date('2026-09-29T03:00:00Z'))).toBe('2026-09-29 08:30 IST');
    // Across midnight: 20:00 UTC is the next day in India.
    expect(formatStamp('2026-09-29T20:00:00Z')).toBe('2026-09-30 01:30 IST');
  });

  it('follows DISPLAY_TIMEZONE, and ignores a zone that does not exist', () => {
    process.env.DISPLAY_TIMEZONE = 'UTC';
    expect(formatStamp('2026-09-29T03:00:00Z')).toBe('2026-09-29 03:00 UTC');
    process.env.DISPLAY_TIMEZONE = 'Not/AZone';
    expect(zoneLabel()).toBe('IST');
  });
});

describe('F14: a guessed name that is a roster name spelt differently', () => {
  const ROSTER = ['Sasikala Loganathan', 'Puja Jagadale', 'Mamata Jain', 'Amir Rai',
    'Dhiraj Jain'];

  it('finds the colleague a misspelling belongs to', () => {
    expect(likelySamePerson('Sasikala Lognathan', ROSTER)).toBe('Sasikala Loganathan');
    expect(likelySamePerson('Pooja Jagadale', ROSTER)).toBe('Puja Jagadale');
  });

  it('never guesses across different people', () => {
    expect(likelySamePerson('Amit Rao', ROSTER)).toBe('');           // short: two letters is a new person
    expect(likelySamePerson('Mamata Dhiraj Jain', ROSTER)).toBe(''); // two names run together
    expect(likelySamePerson('Kavita Jagadale', ROSTER)).toBe('');    // same surname, another person
    expect(likelySamePerson('Puja Jagadale', ROSTER)).toBe('');      // already on the list
  });
});
