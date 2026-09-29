/**
 * Timestamps as text, from whatever the database handed back.
 *
 * The Postgres driver returns a Date object for timestamptz and a string for
 * some other paths, and `String(aDate)` is "Sun Aug 30 2026 07:09:00 GMT+0000
 * (…)". Slicing that by ISO offsets — which nine places did — prints the year
 * where the time belongs and the weekday where the date belongs. The Overview
 * showed a last sync of "2026" under a heading of "Sun Aug 30".
 *
 * Two kinds of time, treated differently:
 *
 * - A business date (formatDay) is rendered as stored. A report row belongs to
 *   a day, and re-interpreting that in a timezone is how a task filed on the
 *   1st appears on the 31st.
 * - A moment something happened (formatStamp, formatTime) — a sync, an import,
 *   a generated report — is shown in the company's zone WITH the zone named.
 *   Unlabelled UTC read as local time: an audit took "last sync 07:44" for IST
 *   and concluded the schedule contradicted the run history.
 *
 * The zone is DISPLAY_TIMEZONE, defaulting to India, where the company is.
 */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return isNaN(d.getTime()) ? null : d;
}

const DEFAULT_ZONE = 'Asia/Kolkata';

/** The zone moments are shown in, falling back to India if the setting is not a real zone. */
export function displayZone(): string {
  const z = (process.env.DISPLAY_TIMEZONE || '').trim() || DEFAULT_ZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: z });
    return z;
  } catch {
    return DEFAULT_ZONE;
  }
}

/** "IST", "UTC", or the zone's own short name ("GMT+4"). */
export function zoneLabel(zone = displayZone()): string {
  if (zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta') return 'IST';
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
  const part = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' })
    .formatToParts(new Date()).find(p => p.type === 'timeZoneName');
  return part?.value || zone;
}

/** { day: "2026-08-30", time: "12:39" } in the display zone. */
function inZone(d: Date): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: displayZone(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value || '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/** "2026-08-30 12:39 IST", or the fallback when there is nothing to show. */
export function formatStamp(value: unknown, fallback = '—'): string {
  const d = toDate(value);
  if (!d) return fallback;
  const z = inZone(d);
  return `${z.day} ${z.time} ${zoneLabel()}`;
}

/** "2026-08-30". */
export function formatDay(value: unknown, fallback = '—'): string {
  const d = toDate(value);
  return d ? d.toISOString().slice(0, 10) : fallback;
}

/** "12:39", in the display zone. */
export function formatTime(value: unknown, fallback = '—'): string {
  const d = toDate(value);
  return d ? inZone(d).time : fallback;
}

/** ISO 8601 in UTC, for machine-readable output such as /api/health. */
export function isoStamp(value: unknown, fallback = 'never'): string {
  const d = toDate(value);
  return d ? d.toISOString() : fallback;
}
