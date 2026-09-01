import { redirect } from 'next/navigation';
import Nav from './nav';
import { getSession } from '@/lib/auth';
import { listGmailAccounts } from '@/lib/accounts';
import { getDailyTrend, getDepartments, getProcessingTotals, getRecentImports, getEmployees, getKpis } from '@/lib/queries';
import { safeErrorMessage } from '@/lib/safe-error';
import { formatStamp } from '@/lib/format-date';

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
  const session = await getSession();
  if (!session) redirect('/login');
  const uid = session.userId;

  let kpis, departments, trend, employees, imports, totals, inboxes;
  try {
    [kpis, departments, trend, employees, imports, totals, inboxes] = await Promise.all([
      getKpis(uid), getDepartments(uid), getDailyTrend(uid), getEmployees(uid),
      getRecentImports(uid, 8), getProcessingTotals(uid), listGmailAccounts(uid)
    ]);
  } catch (e) {
    return (
      <>
        <Nav />
        <main className="shell">
          <h1>Overview</h1>
          <div className="banner bad">
            <strong>Database unavailable.</strong> {safeErrorMessage(e)}
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
            <h3>{inboxes.length ? 'Waiting for reports' : 'Connect your inbox'}</h3>
            <p className="small muted">
              {inboxes.length
                ? `${inboxes[0].email} is connected. The assistant checks it on a schedule; ` +
                  'nothing matching a report has arrived in the sync window yet.'
                : 'Connect a Gmail inbox and the assistant will collect department reports ' +
                  'from it automatically — no labels, no forwarding, no uploads.'}
            </p>
            <p className="small" style={{ marginTop: '.7rem' }}>
              <a className="btn" href="/connect">
                {inboxes.length ? 'Check inbox status' : 'Connect Gmail'}
              </a>
            </p>
          </div>
        </main>
      </>
    );
  }

  const lastSync = inboxes
    .map(a => a.lastSyncAt).filter(Boolean).sort().slice(-1)[0];

  /**
   * The driver returns a Date for a timestamptz column, and String(Date) is
   * "Sun Aug 30 2026 07:09:00 GMT…", not an ISO string. Slicing it by ISO
   * offsets printed the year as the time and the weekday as the date.
   */
  const syncedAt = lastSync ? new Date(lastSync as unknown as string) : null;
  const validSync = syncedAt && !isNaN(syncedAt.getTime()) ? syncedAt : null;

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
          {/* The instance count alone reads as 23 problems. The number that
              matters is how many distinct pieces of work they are, and how
              many of those a person should actually look at. */}
          <Kpi label="Repeated tasks" value={kpis.repeatedTasks}
               note={kpis.repeatGroups
                 ? `${kpis.repeatGroups} recurring item(s)` +
                   (kpis.repeatAttention ? `, ${kpis.repeatAttention} worth a look` : ', none unusual')
                 : 'none'} />
          <Kpi label="Departments" value={kpis.departmentsReporting}
               note={`${kpis.employeesReporting} ${kpis.employeesReporting === 1 ? 'person' : 'people'}`} />
          <Kpi label="Reports processed" value={totals.reports}
               note={`of ${totals.scanned} message(s) read`} />
          <Kpi label="Last sync"
               value={validSync
                 ? validSync.toISOString().slice(11, 16)
                 : lastSync ? 'done' : '—'}
               note={validSync ? validSync.toISOString().slice(0, 10) : 'never'} />
        </div>

        <h2>Daily task volume</h2>
        <div className="card">
          <Sparkline points={trend} />
          <div className="small muted" style={{ marginTop: '.5rem' }}>
            {/* Saying which days these are matters: the figure above counts
                every task ever imported, and this shows the most recent days
                only. Without the qualifier the two look like a contradiction. */}
            {trend.length
              ? `Last ${trend.length} day(s) with activity: ${trend[0].date} → ` +
                `${trend[trend.length - 1].date}`
              : 'No data'}
          </div>
        </div>

        {/* Fires whenever ANY work is unassigned, not only when all of it is.
            The old condition required a single department called Unassigned,
            so the case that actually happens — most of the work unattributed
            alongside two or three named departments — never showed the notice
            at all, and the manager was left to work out for themselves why the
            biggest bar on their dashboard had no name. */}
        {(() => {
          const un = departments.find(d => d.department === 'Unassigned'
                                        || d.department === 'Unknown');
          if (!un) return null;
          const share = Math.round(100 * un.total /
            Math.max(1, departments.reduce((a, d) => a + d.total, 0)));
          return (
            <div className="banner warn">
              <strong>{un.total} task{un.total === 1 ? '' : 's'} ({share}%) have no
              department.</strong> These reports name a person but not a team, and the
              sender&rsquo;s address does not identify one either. Tell the product who
              belongs where on the <a href="/roster">Team roster</a> — it applies to work
              already imported, not only to reports that arrive next.
            </div>
          );
        })()}

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
        {imports.length === 0 && (
          <div className="card small muted">
            Nothing has been imported yet. Messages that were read and judged not to be
            reports are listed on <a href="/quality">Data quality</a>.
          </div>
        )}
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
              {imports.map((d, i) => (
                <tr key={i}>
                  <td className="small">{formatStamp(d.processedAt)}</td>
                  <td className="small">{d.attachment || d.source}</td>
                  <td className="small">{d.subject.slice(0, 70)}</td>
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
