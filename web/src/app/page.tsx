import Nav from './nav';
import { getDailyTrend, getDepartments, getDocuments, getEmployees, getKpis } from '@/lib/queries';

export const dynamic = 'force-dynamic';

function Kpi({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

function Sparkline({ points }: { points: { date: string; total: number }[] }) {
  if (points.length < 2) return null;
  const w = 560, h = 60, pad = 4;
  const max = Math.max(...points.map(p => p.total), 1);
  const step = (w - pad * 2) / (points.length - 1);
  const path = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${(pad + i * step).toFixed(1)},${(h - pad - (p.total / max) * (h - pad * 2)).toFixed(1)}`
  ).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img"
         aria-label={`Daily task volume, ${points.length} days, peak ${max}`}>
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={p.date} cx={pad + i * step}
                cy={h - pad - (p.total / max) * (h - pad * 2)} r="2.5" fill="var(--accent)" />
      ))}
    </svg>
  );
}

export default async function OverviewPage() {
  let kpis, departments, trend, employees, documents;
  try {
    [kpis, departments, trend, employees, documents] = await Promise.all([
      getKpis(), getDepartments(), getDailyTrend(), getEmployees(), getDocuments(8)
    ]);
  } catch (e) {
    return (
      <>
        <Nav />
        <main className="shell">
          <h1>Overview</h1>
          <div className="banner bad">
            <strong>Database unavailable.</strong> {(e as Error).message}
            <div className="small muted" style={{ marginTop: '.4rem' }}>
              Check <code>DATABASE_URL</code>, then apply <code>supabase/schema.sql</code>.
            </div>
          </div>
        </main>
      </>
    );
  }

  if (kpis.total === 0) {
    return (
      <>
        <Nav />
        <main className="shell">
          <h1>Overview</h1>
          <p className="sub">No reports imported yet.</p>
          <div className="card">
            <h3>Get started</h3>
            <p className="small muted">
              Paste a daily report on the <a href="/submit">Submit report</a> page. You will see
              exactly what would be imported before anything is written.
            </p>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Nav />
      <main className="shell">
        <h1>Overview</h1>
        <p className="sub">
          {kpis.total} tasks from {kpis.firstDate} to {kpis.lastDate}
        </p>

        <div className="kpis">
          <Kpi label="Total tasks" value={kpis.total} />
          <Kpi label="Completed" value={kpis.completed} />
          <Kpi label="Pending" value={kpis.pending} />
          <Kpi label="In progress" value={kpis.inProgress} />
          <Kpi label="Completion rate" value={`${kpis.completionRate}%`}
               note="completed ÷ total" />
          <Kpi label="Slow tasks" value={kpis.slowTasks}
               note={`${kpis.insufficientDuration} not measurable`} />
          <Kpi label="Repeated tasks" value={kpis.repeatedTasks} />
          <Kpi label="Departments" value={kpis.departmentsReporting}
               note={`${kpis.employeesReporting} employees`} />
        </div>

        <h2>Daily task volume</h2>
        <div className="card">
          <Sparkline points={trend} />
          <div className="small muted" style={{ marginTop: '.5rem' }}>
            {trend.length ? `${trend[0].date} → ${trend[trend.length - 1].date}` : 'No data'}
          </div>
        </div>

        <h2>Departments</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Department</th><th className="num">Tasks</th><th className="num">Completed</th>
                <th className="num">Pending</th><th className="num">Blocked</th>
                <th className="num">Completion</th><th className="num">Slow</th>
                <th className="num">Repeated</th><th className="num">People</th>
              </tr>
            </thead>
            <tbody>
              {departments.map(d => (
                <tr key={d.department}>
                  <td>{d.department}</td>
                  <td className="num">{d.total}</td>
                  <td className="num">{d.completed}</td>
                  <td className="num">{d.pending}</td>
                  <td className="num">{d.blocked}</td>
                  <td className="num">{d.completionRate}%</td>
                  <td className="num">{d.slowTasks}</td>
                  <td className="num">{d.repeatedTasks}</td>
                  <td className="num">{d.employees}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>Employee activity</h2>
        <div className="banner">
          These figures show <strong>reported activity</strong>, not productivity or value.
          Task counts do not reflect complexity. Rows marked <em>Insufficient — do not rank</em>
          {' '}have too little data to compare.
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th className="num">Tasks</th>
                <th className="num">Completed</th><th className="num">Completion</th>
                <th className="num">Days</th><th className="num">Slow</th>
                <th className="num">Repeated</th><th>Data sufficiency</th>
              </tr>
            </thead>
            <tbody>
              {employees.map(e => (
                <tr key={e.employee}>
                  <td>{e.employee}</td>
                  <td>{e.department}</td>
                  <td className="num">{e.total}</td>
                  <td className="num">{e.completed}</td>
                  <td className="num">{e.completionRate}%</td>
                  <td className="num">{e.days}</td>
                  <td className="num">{e.slowTasks}</td>
                  <td className="num">{e.repeatedTasks}</td>
                  <td>
                    <span className={'pill ' + (
                      e.dataSufficiency.startsWith('Sufficient') ? 'ok'
                        : e.dataSufficiency.startsWith('Indicative') ? 'warn' : 'mute')}>
                      {e.dataSufficiency}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>Recent imports</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Processed</th><th>Source</th><th>Subject</th><th>Status</th>
                <th className="num">Extracted</th><th className="num">Imported</th>
                <th className="num">Already present</th><th className="num">Rejected</th>
              </tr>
            </thead>
            <tbody>
              {documents.map(d => (
                <tr key={d.reportId}>
                  <td className="small">{String(d.processedAt).slice(0, 16).replace('T', ' ')}</td>
                  <td className="small">{d.source}</td>
                  <td className="small">{d.subject}</td>
                  <td>
                    <span className={'pill ' + (
                      d.status === 'SUCCESS' ? 'ok' : d.status === 'PARTIAL' ? 'warn' : 'mute')}>
                      {d.status}
                    </span>
                  </td>
                  <td className="num">{d.extracted}</td>
                  <td className="num">{d.inserted}</td>
                  <td className="num">{d.skipped}</td>
                  <td className="num">{d.rejected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
