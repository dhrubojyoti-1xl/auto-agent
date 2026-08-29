import Nav from '../nav';
import { getRepeatGroups } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const PILL: Record<string, string> = {
  'Recurring / Legitimate': 'mute',
  'Highly Repetitive': 'ok',
  'Potential Duplication': 'warn',
  'Needs Review': 'bad'
};

export default async function RepeatsPage() {
  const groups = await getRepeatGroups();
  return (
    <>
      <Nav />
      <main className="shell">
        <h1>Repeated tasks</h1>
        <p className="sub">
          Every row here was imported. Repetition is classified, never deleted and never
          treated as a fault by itself.
        </p>
        <div className="banner">
          <strong>Recurring / Legitimate</strong> — a routine duty.{' '}
          <strong>Highly Repetitive</strong> — an automation candidate.{' '}
          <strong>Potential Duplication</strong> — same-day repeats worth checking at source.{' '}
          <strong>Needs Review</strong> — several identical rows in one day; a human should confirm.
        </div>
        {groups.length === 0 ? (
          <div className="card">No task has been reported more than once yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th><th>Department</th><th>Task</th>
                  <th className="num">Occurrences</th><th className="num">Distinct dates</th>
                  <th className="num">Max in one day</th><th>First</th><th>Last</th>
                  <th>Classification</th><th>Why</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g, i) => (
                  <tr key={i}>
                    <td>{g.employee}</td>
                    <td>{g.department}</td>
                    <td>{g.task}</td>
                    <td className="num">{g.occurrences}</td>
                    <td className="num">{g.distinctDates}</td>
                    <td className="num">{g.maxSameDay}</td>
                    <td className="small">{g.firstDate}</td>
                    <td className="small">{g.lastDate}</td>
                    <td><span className={'pill ' + (PILL[g.classification] || 'mute')}>
                      {g.classification}</span></td>
                    <td className="small muted">{g.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
