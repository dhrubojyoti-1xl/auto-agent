import { redirect } from 'next/navigation';
import Nav from '../nav';
import { getSession } from '@/lib/auth';
import { getKpis, getSlowTasks } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function SlowPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const [rows, kpis] = await Promise.all([getSlowTasks(session.userId), getKpis(session.userId)]);
  return (
    <>
      <Nav />
      <main className="shell">
        <h1>Slow tasks</h1>
        <p className="sub">
          A task is only shown here when BOTH an expected and an actual duration exist and the
          actual exceeds the expectation by more than the configured multiplier.
        </p>

        <div className="banner warn">
          <strong>{kpis.insufficientDuration} of {kpis.total} tasks cannot be measured at all</strong>
          {' '}— they carry no start/completion timestamps, so their duration is unknown. They are
          excluded from this page rather than assumed to be on time. Add start and end time columns
          to the report template and they will appear here automatically.
        </div>

        {rows.length === 0 ? (
          <div className="card">No task exceeded its expected duration threshold.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Task</th><th>Employee</th><th>Department</th>
                  <th>Category</th><th className="num">Expected</th><th className="num">Actual</th>
                  <th className="num">Variance</th><th className="num">Over by</th>
                  <th>Basis</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="small">{r.date}</td>
                    <td>{r.task}</td>
                    <td>{r.employee}</td>
                    <td>{r.department}</td>
                    <td className="small muted">{r.category || '—'}</td>
                    <td className="num">{r.expected} h</td>
                    <td className="num">{r.actual} h</td>
                    <td className="num">+{r.variance} h</td>
                    <td className="num">
                      <span className={'pill ' + (r.variancePct >= 100 ? 'bad' : 'warn')}>
                        {r.variancePct}%
                      </span>
                    </td>
                    <td className="small muted">{r.basis}</td>
                    <td className="small">{r.status}</td>
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
