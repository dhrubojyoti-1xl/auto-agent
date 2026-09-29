'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The day picker and the copy button for the department summaries.
 *
 * Copy exists because the summaries are read out of the product, not in it:
 * pasted into the morning email or the team chat.
 */
export default function DayControls({ date, available, text }: {
  date: string; available: string[]; text: string;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const label = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
  });

  return (
    <div className="row day-controls">
      <label htmlFor="day" className="sr-only">Day</label>
      <select id="day" value={date}
              onChange={e => router.push(`/report?date=${encodeURIComponent(e.target.value)}`)}>
        {available.map(d => <option key={d} value={d}>{label(d)}</option>)}
      </select>
      <button className="secondary" type="button" onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}>
        {copied ? 'Copied' : 'Copy as text'}
      </button>
    </div>
  );
}
