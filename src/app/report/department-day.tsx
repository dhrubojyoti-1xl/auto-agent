import Link from 'next/link';
import type { DepartmentDay } from '@/lib/core/department-day';
import DayControls from './day-controls';

/**
 * One card per department for one day: what was reported, what finished, what
 * is stuck, who has not reported. Built from counts only — see
 * src/lib/core/department-day.ts.
 */
export default function DepartmentDaySection({ date, available, days, silent = [], text }: {
  date: string | null; available: string[]; days: DepartmentDay[];
  /** Roster departments that reported nothing on the day. */
  silent?: string[];
  text: string;
}) {
  if (!date) {
    return (
      <section>
        <h2>Department summaries</h2>
        <div className="empty">
          <div className="title">No reports yet</div>
          <div className="why">
            Each department&rsquo;s day is summarised here as soon as its first report is imported.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Department summaries</h2>
          <p className="small muted" style={{ margin: 0 }}>
            A short read of each department&rsquo;s day, written from the imported reports.
            Every number is counted; nothing is estimated.
          </p>
        </div>
        <DayControls date={date} available={available} text={text} />
      </div>

      {silent.length > 0 && (
        <div className="banner warn">
          <strong>No reports from {silent.length} department{silent.length === 1 ? '' : 's'}:</strong>{' '}
          {silent.join(', ')}.
        </div>
      )}

      <div className="dept-day-grid">
        {days.map(d => {
          const unplaced = d.department === 'Unassigned' || d.department === 'Unknown';
          const tone = d.completionRate >= 70 ? 'ok' : d.completionRate >= 40 ? 'warn' : 'bad';
          return (
            <article key={d.department} className="dept-day">
              <header>
                <h3>{unplaced ? 'Department not identified' : d.department}</h3>
                {d.total > 0 && <span className={`pill ${tone}`}>{d.completionRate}% done</span>}
              </header>
              <p className="headline">{d.headline}</p>
              <dl className="counts">
                <div><dt>Tasks</dt><dd>{d.total}</dd></div>
                <div><dt>Completed</dt><dd>{d.completed}</dd></div>
                <div><dt>In progress</dt><dd>{d.inProgress}</dd></div>
                <div><dt>Not done</dt><dd>{d.notDone}</dd></div>
                <div><dt>Blocked</dt><dd>{d.blocked}</dd></div>
              </dl>
              {d.points.length > 0 && (
                <ul>{d.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
              )}
              <Link className="small" href={`/management?grain=daily&from=${date}&to=${date}` +
                (unplaced ? '' : `&department=${encodeURIComponent(d.department)}`)}>
                Open this day in Management →
              </Link>
            </article>
          );
        })}
      </div>
    </section>
  );
}
