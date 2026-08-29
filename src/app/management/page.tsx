import { redirect } from 'next/navigation';
import Link from 'next/link';
import Nav from '../nav';
import { getSession } from '@/lib/auth';
import { BarChart, DonutChart, LineChart, RankChart } from '../charts/charts';
import {
  getDepartmentBreakdown, getEmployeeActivity, getFilterOptions, getPeriodSeries,
  getRepeatGroups, getSlowTaskChart, getStatusDistribution, type Grain
} from '@/lib/queries';
import Filters from './filters';

export const dynamic = 'force-dynamic';

const GRAINS: Grain[] = ['daily', 'weekly', 'monthly'];
const TITLE: Record<Grain, string> = {
  daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly'
};
const WINDOW: Record<Grain, number> = { daily: 30, weekly: 84, monthly: 365 };

function fmtPeriod(iso: string, grain: Grain) {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [y, m, d] = iso.split('-').map(Number);
  if (grain === 'monthly') return `${M[m - 1]} ${y}`;
  if (grain === 'weekly') return `w/c ${d} ${M[m - 1]}`;
  return `${d} ${M[m - 1]}`;
}

function Kpi({ label, value, note, tone }:
  { label: string; value: string | number; note?: string; tone?: 'ok'|'warn'|'bad' }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value" style={tone ? { color: `var(--${tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'bad'})` } : undefined}>{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export default async function ManagementPage({
  searchParams
}: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  const uid = session.userId;
  const sp = await searchParams;

  const grain: Grain = GRAINS.includes(sp.grain as Grain) ? (sp.grain as Grain) : 'daily';
  const department = sp.department && sp.department !== 'all' ? sp.department : undefined;
  const employee = sp.employee && sp.employee !== 'all' ? sp.employee : undefined;
  const from = sp.from || undefined;
  const to = sp.to || undefined;

  const [series, depts, status, employees, options, slow, repeats] = await Promise.all([
    getPeriodSeries(uid, grain, { department, employee, from, to, limit: WINDOW[grain] }),
    getDepartmentBreakdown(uid, { from, to }),
    getStatusDistribution(uid, { department, from, to }),
    getEmployeeActivity(uid, { department, from, to, limit: 10 }),
    getFilterOptions(uid),
    getSlowTaskChart(uid, 8),
    getRepeatGroups(uid)
  ]);

  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  const totals = series.reduce((a, p) => ({
    total: a.total + p.total, completed: a.completed + p.completed,
    backlog: a.backlog + p.backlog
  }), { total: 0, completed: 0, backlog: 0 });
  const overallRate = totals.total ? Math.round((totals.completed / totals.total) * 1000) / 10 : 0;
  const ppChange = latest && previous
    ? Math.round((latest.completionRate - previous.completionRate) * 10) / 10 : null;

  const qs = (patch: Record<string, string>) => {
    const p = new URLSearchParams();
    Object.entries({ grain, department: department ?? '', employee: employee ?? '',
                     from: from ?? '', to: to ?? '', ...patch })
      .forEach(([k, v]) => { if (v) p.set(k, String(v)); });
    return `/management?${p.toString()}`;
  };

  const hasData = series.length > 0;

  return (
    <>
      <Nav />
      <main className="shell">
        <h1>{TITLE[grain]} management view</h1>
        <p className="sub">
          {department ? `${department} · ` : 'All departments · '}
          {employee ? `${employee} · ` : ''}
          {hasData ? `${totals.total} tasks across ${series.length} ${grain === 'daily' ? 'days' : grain === 'weekly' ? 'weeks' : 'months'}`
                   : 'No data in this range'}
        </p>

        <div className="tabs">
          {GRAINS.map(g => (
            <Link key={g} href={qs({ grain: g })} className={g === grain ? 'on' : ''}>
              {TITLE[g]}
            </Link>
          ))}
        </div>

        <Filters departments={options.departments} employees={options.employees}
                 grain={grain} department={department} employee={employee}
                 from={from} to={to}
                 minDate={options.minDate} maxDate={options.maxDate} />

        {!hasData ? (
          <div className="card">
            <h3>Nothing to report yet</h3>
            <p className="small muted">
              Once reports arrive in the connected inbox they appear here automatically.
              Check the <Link href="/connect">Inbox</Link> page for sync status.
            </p>
          </div>
        ) : (
          <>
            <div className="kpis">
              <Kpi label={`Tasks this ${grain.replace('ly', '')}`} value={latest?.total ?? 0}
                   note={previous ? `previous: ${previous.total}` : 'no prior period'} />
              <Kpi label="Completed" value={latest?.completed ?? 0}
                   note={`${latest?.completionRate ?? 0}% completion`} />
              <Kpi label="Backlog" value={latest?.backlog ?? 0}
                   note="reported, not finished or cancelled"
                   tone={(latest?.backlog ?? 0) > (latest?.completed ?? 0) ? 'warn' : undefined} />
              <Kpi label="Completion rate" value={`${latest?.completionRate ?? 0}%`}
                   note={ppChange === null ? 'no prior period'
                        : `${ppChange > 0 ? '+' : ''}${ppChange} pp vs previous`}
                   tone={ppChange === null ? undefined : ppChange >= 0 ? 'ok' : 'bad'} />
              <Kpi label="Active departments" value={latest?.departments ?? 0} />
              <Kpi label="Active employees" value={latest?.employees ?? 0} />
              <Kpi label="Slow tasks" value={slow.length}
                   note={slow.length ? 'measurable overruns' : 'none measurable'} />
              <Kpi label="Repeated tasks" value={repeats.length} note="task groups" />
            </div>

            <h2>Trends</h2>
            <div className="chart-grid">
              <div className="chart-card">
                <h3>Task volume</h3>
                <p className="cap">How much work is being reported each {grain.replace('ly', '')}.</p>
                <LineChart yLabel="Tasks" series={[{
                  name: 'Tasks',
                  points: series.map(p => ({ x: p.period, y: p.total }))
                }]} />
              </div>

              <div className="chart-card">
                <h3>Completed vs pending</h3>
                <p className="cap">Whether finished work is keeping pace with what arrives.</p>
                <LineChart series={[
                  { name: 'Completed', points: series.map(p => ({ x: p.period, y: p.completed })) },
                  { name: 'Backlog', points: series.map(p => ({ x: p.period, y: p.backlog })) }
                ]} />
              </div>

              <div className="chart-card">
                <h3>Completion rate</h3>
                <p className="cap">Percentage of reported tasks marked complete. Changes are in percentage points.</p>
                <LineChart suffix="%" series={[{
                  name: 'Completion rate',
                  points: series.map(p => ({ x: p.period, y: p.completionRate }))
                }]} />
              </div>

              <div className="chart-card">
                <h3>Backlog trend</h3>
                <p className="cap">Reported work that is neither completed nor cancelled.</p>
                <LineChart series={[{
                  name: 'Backlog', points: series.map(p => ({ x: p.period, y: p.backlog }))
                }]} />
              </div>
            </div>

            <h2>Departments</h2>
            <div className="chart-grid">
              <div className="chart-card">
                <h3>Task volume by department</h3>
                <p className="cap">Completed and outstanding side by side.</p>
                <BarChart rows={depts.map(d => ({
                  label: d.department,
                  values: [
                    { name: 'Completed', value: d.completed },
                    { name: 'Pending', value: d.pending + d.inProgress + d.blocked }
                  ]
                }))} stacked />
              </div>

              <div className="chart-card">
                <h3>Completion rate by department</h3>
                <p className="cap">Computed from summed counts, never averaged across departments.</p>
                <BarChart suffix="%" rows={depts.map(d => ({
                  label: d.department,
                  values: [{ name: 'Completion rate', value: d.completionRate }]
                }))} />
              </div>

              <div className="chart-card">
                <h3>Status distribution</h3>
                <p className="cap">Every task in range, by status.</p>
                <DonutChart slices={status} />
              </div>

              <div className="chart-card">
                <h3>Employee activity</h3>
                <p className="cap">
                  Reported activity, not productivity — task counts say nothing about complexity.
                </p>
                <RankChart rows={employees.map(e => ({
                  label: e.employee, value: e.total,
                  note: `· ${e.completionRate}% done`
                }))} />
              </div>
            </div>

            <h2>Attention</h2>
            <div className="chart-grid">
              <div className="chart-card">
                <h3>Slow tasks</h3>
                <p className="cap">
                  {slow.length
                    ? 'Hours over the expected duration. Only tasks with real timestamps appear.'
                    : 'Nothing measurable: slow-task analysis needs start and completion times.'}
                </p>
                <RankChart suffix=" h" empty="No task has a measurable overrun"
                  rows={slow.map(s => ({
                    label: s.task, value: s.variance,
                    note: `· ${s.actual}h vs ${s.expected}h`
                  }))} />
              </div>

              <div className="chart-card">
                <h3>Repeated tasks</h3>
                <p className="cap">
                  Recurring work is normal. Classification tells you which groups deserve a look.
                </p>
                <RankChart empty="No task has been reported more than once"
                  rows={repeats.slice(0, 8).map(r => ({
                    label: `${r.employee} — ${r.task}`.slice(0, 46),
                    value: r.occurrences, note: `· ${r.classification}`
                  }))} />
              </div>
            </div>

            <h2>Department detail</h2>
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
                  {depts.map(d => (
                    <tr key={d.department}>
                      <td><Link href={qs({ department: d.department })}>{d.department}</Link></td>
                      <td className="num">{d.total}</td>
                      <td className="num">{d.completed}</td>
                      <td className="num">{d.pending + d.inProgress}</td>
                      <td className="num">{d.blocked}</td>
                      <td className="num">
                        <span className={'pill ' + (d.completionRate >= 70 ? 'ok'
                          : d.completionRate >= 40 ? 'warn' : 'bad')}>{d.completionRate}%</span>
                      </td>
                      <td className="num">{d.slowTasks}</td>
                      <td className="num">{d.repeatedTasks}</td>
                      <td className="num">{d.employees}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </>
  );
}
