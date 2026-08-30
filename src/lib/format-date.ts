/**
 * Timestamps as text, from whatever the database handed back.
 *
 * The Postgres driver returns a Date object for timestamptz and a string for
 * some other paths, and `String(aDate)` is "Sun Aug 30 2026 07:09:00 GMT+0000
 * (…)". Slicing that by ISO offsets — which nine places did — prints the year
 * where the time belongs and the weekday where the date belongs. The Overview
 * showed a last sync of "2026" under a heading of "Sun Aug 30".
 *
 * Everything is rendered in UTC deliberately. A report row belongs to a
 * business date, and re-interpreting that in the viewer's timezone is how a
 * task filed on the 1st appears on the 31st for a reader further west.
 */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return isNaN(d.getTime()) ? null : d;
}

/** "2026-08-30 07:09", or the fallback when there is nothing to show. */
export function formatStamp(value: unknown, fallback = '—'): string {
  const d = toDate(value);
  return d ? d.toISOString().slice(0, 16).replace('T', ' ') : fallback;
}

/** "2026-08-30". */
export function formatDay(value: unknown, fallback = '—'): string {
  const d = toDate(value);
  return d ? d.toISOString().slice(0, 10) : fallback;
}

/** "07:09". */
export function formatTime(value: unknown, fallback = '—'): string {
  const d = toDate(value);
  return d ? d.toISOString().slice(11, 16) : fallback;
}
