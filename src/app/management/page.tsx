import { redirect } from 'next/navigation';
import Link from 'next/link';
import Nav from '../nav';
import { getSession } from '@/lib/auth';
import { BarChart, DataTable, DonutChart, LineChart, RankChart } from '../charts/charts';
import ChartSwitch from '../charts/switch';
import {
  getDepartmentBreakdown, getEmployeeActivityPanel, getFilterOptions, getKpis, getPeriodSeries,
  countSlowTasks, getRepeatGroups, getSlowTaskChart, getStatusDistribution, type Grain
} from '@/lib/queries';
import { compareCounts, compareRates, getAttention, getCoverage } from '@/lib/analytics';
import type { Delta } from '@/lib/analytics';
import { buildInsight } from '@/lib/insight';
import Filters from '../filters';

export const dynamic = 'force-dynamic';

const GRAINS: Grain[] = ['daily', 'weekly', 'monthly'];
const TITLE: Record<Grain, string> = {
  daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly'
};
const WINDOW: Record<Grain, number> = { daily: 30, weekly: 84, monthly: 365 };
// "daily".replace('ly','') gives "dai". Spell the nouns out.
const PERIOD_NOUN: Record<Grain, string> = { daily: 'day', weekly: 'week', monthly: 'month' };
const PERIOD_PLURAL: Record<Grain, string> = { daily: 'days', weekly: 'weeks', monthly: 'months' };


/**
 * A metric with its movement, or an honest note that the movement cannot be
 * read. The arrow is never the only signal — the wording carries it too, so
 * the card still works without colour.
 */
function Kpi({ label, value, note, delta }: {
  label: string; value: string | number; note?: string; delta?: Delta | null;
}) {
  const arrow = delta?.direction === 'up' ? '↑' : delta?.direction === 'down' ? '↓' : '→';
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {delta && (
        <div className={`delta ${delta.weak ? 'weak' : delta.direction}`}>
          {!delta.weak && <span aria-hidden="true">{arrow}</span>}
          <span>{delta.label}</span>
        </div>
      )}
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

  // The trend is capped at WINDOW[grain] periods, so it covers a shorter span
  // than "everything ever imported". Every other panel has to cover exactly the
  // same span, or the page reports two different totals for the same thing —
  // a header saying 219 tasks above a chart adding up to 303. The window is
  // read back off the series rather than computed from today's date, because
  // the series shows the last N periods *that have data*, which with sparse
  // reporting reaches further back than N calendar periods.
  const series = await getPeriodSeries(
    uid, grain, { department, employee, from, to, limit: WINDOW[grain] });
  const windowFrom = from || series[0]?.period;
  const scope = { department, employee, from: windowFrom, to };

  const [depts, status, activity, options, slow, slowCount, repeats, kpis, coverage, attention] =
    await Promise.all([
      getDepartmentBreakdown(uid, { employee, from: windowFrom, to }),
      getStatusDistribution(uid, scope),
      getEmployeeActivityPanel(uid, { ...scope, limit: 10 }),
      // With a department chosen, the Employee list offers only its people.
      getFilterOptions(uid, { department }),
      getSlowTaskChart(uid, { ...scope, limit: 8 }),
      countSlowTasks(uid, scope),
      getRepeatGroups(uid, scope),
      getKpis(uid),
      getCoverage(uid),
      getAttention(uid)
    ]);

  const employees = activity.rows;
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  const totals = series.reduce((a, p) => ({
    total: a.total + p.total, completed: a.completed + p.completed,
    backlog: a.backlog + p.backlog
  }), { total: 0, completed: 0, backlog: 0 });
  // Comparisons are only offered when the previous period had enough in it to
  // carry one. "+100%" from one task to two is arithmetic, not information.
  const volDelta  = latest && previous ? compareCounts(latest.total, previous.total) : null;
  const doneDelta = latest && previous ? compareCounts(latest.completed, previous.completed) : null;
  const backDelta = latest && previous ? compareCounts(latest.backlog, previous.backlog) : null;
  const rateDelta = latest && previous
    ? compareRates(latest.completionRate, previous.completionRate, previous.total) : null;
  const insight = buildInsight(kpis, series, coverage, PERIOD_NOUN[grain]);

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
        <div className="page-head">
          <div>
            <h1>Management overview</h1>
            <p className="sub" style={{ margin: 0 }}>
              {department ? `${department} · ` : 'All departments · '}
              {employee ? `${employee} · ` : ''}
              {hasData
                ? `${totals.total} task${totals.total === 1 ? '' : 's'} in the last ` +
                  `${series.length} ${PERIOD_PLURAL[grain]} with activity` +
                  (kpis.total > totals.total ? ` · ${kpis.total} imported in total` : '')
                : 'No data in this range'}
            </p>
          </div>
          {/* Coverage answers the question a manager asks before trusting any
              figure on the page: how much of the organisation is in it. */}
          <div className="page-meta">
            <span><b>{coverage.reportsProcessed}</b> report{coverage.reportsProcessed === 1 ? '' : 's'} processed</span>
            <span><b>{coverage.rowsImported}</b> rows imported</span>
            <span><b>{kpis.departmentsReporting}</b> department{kpis.departmentsReporting === 1 ? '' : 's'} reporting</span>
            {coverage.reportsNeedingReview > 0 && (
              <span><b>{coverage.reportsNeedingReview}</b> awaiting review</span>
            )}
          </div>
        </div>

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
            {/* What happened, before anything asks the reader to interpret. */}
            <section className="insight">
              <div className="eyebrow">Management insight</div>
              <p>{insight.headline}</p>
              {insight.points.length > 0 && (
                <ul>
                  {insight.points.map((pt, i) => (
                    <li key={i} className={pt.tone}>
                      <span className="mark" aria-hidden="true">{pt.mark}</span>
                      <span>{pt.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {attention.length > 0 && (
              <>
                <h2>Attention</h2>
                <div className="attention">
                  {attention.slice(0, 5).map((a, i) => (
                    <div key={i} className={`item ${a.severity}`}>
                      <div className="count">{a.count}</div>
                      <div>
                        <h3>{a.title}</h3>
                        <p>{a.detail}</p>
                      </div>
                      {a.href && <Link className="go" href={a.href}>{a.action ?? 'Open'} →</Link>}
                    </div>
                  ))}
                </div>
              </>
            )}

            <h2>This {PERIOD_NOUN[grain]}</h2>
            <div className="kpis primary">
              <Kpi label="Tasks" value={latest?.total ?? 0}
                   delta={volDelta} note={`reported this ${PERIOD_NOUN[grain]}`} />
              <Kpi label="Completed" value={latest?.completed ?? 0}
                   delta={doneDelta} note="finished and reported so" />
              <Kpi label="Backlog" value={latest?.backlog ?? 0}
                   delta={backDelta ? { ...backDelta, direction:
                     backDelta.direction === 'up' ? 'down' as const
                     : backDelta.direction === 'down' ? 'up' as const : 'flat' as const } : null}
                   note="open, not cancelled" />
              <Kpi label="Completion rate" value={`${latest?.completionRate ?? 0}%`}
                   delta={rateDelta} note="of what was reported" />
            </div>
            <div className="kpis secondary">
              <Kpi label="Departments" value={latest?.departments ?? 0}
                   note={`${latest?.employees ?? 0} reporting`} />
              {/* Each note says what its number covers: the first two are this
                  period, the last two the whole window shown on the page. */}
              <Kpi label="People reporting" value={latest?.employees ?? 0}
                   note={`this ${PERIOD_NOUN[grain]}`} />
              <Kpi label="Slow tasks" value={slowCount}
                   note={slowCount
                     ? `over the last ${series.length} ${PERIOD_PLURAL[grain]}, against comparable work`
                     : 'none measurable from this data'} />
              <Kpi label="Repeated work" value={repeats.length}
                   note={repeats.length
                     ? `recurring items over the last ${series.length} ${PERIOD_PLURAL[grain]}`
                     : 'none yet'} />
            </div>

            <h2>Trends</h2>
            <div className="chart-grid">
              <div className="chart-card">
                <h3>Task volume</h3>
                <p className="cap">How much work is being reported each {PERIOD_NOUN[grain]}.</p>
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
                {(() => {
                  const volume = depts.map(d => ({
                    label: d.department,
                    values: [
                      { name: 'Completed', value: d.completed },
                      { name: 'Pending', value: d.pending + d.inProgress + d.blocked }
                    ]
                  }));
                  return (
                    <ChartSwitch id="dept-volume" title="Task volume by department"
                      caption="Completed and outstanding side by side."
                      views={[
                        { key: 'stacked', label: 'Stacked bars', node: <BarChart rows={volume} stacked /> },
                        { key: 'grouped', label: 'Grouped bars', node: <BarChart rows={volume} /> },
                        { key: 'horizontal', label: 'Horizontal bars', node: (
                          <RankChart rows={depts.map(d => ({
                            label: d.department, value: d.total,
                            note: `· ${d.completed} completed`
                          }))} />) },
                        { key: 'table', label: 'Table', node: (
                          <DataTable
                            columns={[{ label: 'Department' }, { label: 'Tasks', num: true },
                                      { label: 'Completed', num: true }, { label: 'Outstanding', num: true }]}
                            rows={depts.map(d => [d.department, d.total, d.completed,
                                                  d.pending + d.inProgress + d.blocked])} />) }
                      ]} />
                  );
                })()}
              </div>

              <div className="chart-card">
                <ChartSwitch id="dept-rate" title="Completion rate by department"
                  caption="Computed from summed counts, never averaged across departments."
                  views={[
                    { key: 'bars', label: 'Bars', node: (
                      <BarChart suffix="%" rows={depts.map(d => ({
                        label: d.department,
                        values: [{ name: 'Completion rate', value: d.completionRate }]
                      }))} />) },
                    { key: 'horizontal', label: 'Horizontal bars', node: (
                      <RankChart suffix="%" max={100} rows={depts.map(d => ({
                        label: d.department, value: d.completionRate,
                        note: `· ${d.completed} of ${d.total}`
                      }))} />) },
                    { key: 'table', label: 'Table', node: (
                      <DataTable
                        columns={[{ label: 'Department' }, { label: 'Completion', num: true },
                                  { label: 'Completed', num: true }, { label: 'Tasks', num: true }]}
                        rows={depts.map(d => [d.department, `${d.completionRate}%`, d.completed, d.total])} />) }
                  ]} />
              </div>

              <div className="chart-card">
                <ChartSwitch id="status-mix" title="Status distribution"
                  caption="Every task in range, by status."
                  views={[
                    { key: 'donut', label: 'Donut', node: <DonutChart slices={status} /> },
                    { key: 'bars', label: 'Bars', node: (
                      <BarChart rows={status.map(s => ({
                        label: s.name, values: [{ name: 'Tasks', value: s.value }]
                      }))} />) },
                    { key: 'table', label: 'Table', node: (() => {
                      const all = status.reduce((a, s) => a + s.value, 0);
                      return (
                        <DataTable columns={[{ label: 'Status' }, { label: 'Tasks', num: true },
                                             { label: 'Share', num: true }]}
                          rows={status.map(s => [s.name, s.value,
                            `${all ? Math.round((1000 * s.value) / all) / 10 : 0}%`])} />
                      );
                    })() }
                  ]} />
              </div>

              <div className="chart-card">
                <ChartSwitch id="employee-activity" title="Employee activity"
                  caption="Reported activity, not productivity — task counts say nothing about complexity."
                  views={[
                    { key: 'horizontal', label: 'Horizontal bars', node: (
                      <RankChart rows={employees.map(e => ({
                        label: e.employee, value: e.total,
                        note: `· ${e.completionRate}% done`
                      }))} />) },
                    { key: 'bars', label: 'Vertical bars', node: (
                      <BarChart stacked rows={employees.map(e => ({
                        label: e.employee,
                        values: [{ name: 'Completed', value: e.completed },
                                 { name: 'Other', value: e.total - e.completed }]
                      }))} />) },
                    { key: 'table', label: 'Table', node: (
                      <DataTable
                        columns={[{ label: 'Employee' }, { label: 'Department' },
                                  { label: 'Tasks', num: true }, { label: 'Completed', num: true },
                                  { label: 'Days', num: true }]}
                        rows={employees.map(e => [e.employee, e.department, e.total,
                                                  e.completed, e.days])} />) }
                  ]} />
                {/* Older imports filed some task titles as names. They are left
                    exactly as imported and still count in every department
                    total; they are only kept out of a list of people. */}
                {activity.hiddenNames > 0 && (
                  <p className="chart-note">
                    {activity.hiddenTasks} task{activity.hiddenTasks === 1 ? '' : 's'} under{' '}
                    {activity.hiddenNames} name{activity.hiddenNames === 1 ? '' : 's'} that
                    {activity.hiddenNames === 1 ? ' is' : ' are'} not a person
                    (e.g. &ldquo;{activity.hiddenExamples[0]}&rdquo;) are counted in the
                    department totals but not listed here. Add people to the{' '}
                    <Link href="/roster">Team roster</Link> to be sure they always appear.
                  </p>
                )}
              </div>
            </div>

            <h2>Exceptions in detail</h2>
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

            {/* Cards when there are departments to compare; the table below
                stays for the detail. A single card would be a table with extra
                steps, and "Unassigned" is not a department — it is the absence
                of one, and saying so is more useful than styling it as one. */}
            {depts.length > 1 && (
              <>
                <h2>By department</h2>
                <div className="dept-grid">
                  {depts.map(d => {
                    const unknown = d.department === 'Unassigned' || !d.department;
                    return (
                      <Link key={d.department} className="card-link"
                            href={qs({ department: unknown ? '' : d.department })}>
                        <div className="dept-card">
                          <div className="name">
                            {unknown ? 'Department not identified' : d.department}
                          </div>
                          <div className="big">{d.total}</div>
                          <div className="rows">
                            <div><span>Completed</span><b>{d.completed}</b></div>
                            <div><span>Open</span><b>{d.total - d.completed}</b></div>
                            <div><span>Completion</span><b>{d.completionRate}%</b></div>
                            <div><span>People</span><b>{d.employees}</b></div>
                          </div>
                          <div className="bar-mini" role="img"
                               aria-label={`${d.completionRate}% complete`}>
                            <span style={{ width: `${Math.min(100, d.completionRate)}%` }} />
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </>
            )}

            {depts.length === 1 && depts[0].department === 'Unassigned' && (
              <div className="empty" style={{ marginTop: '1.5rem' }}>
                <div className="title">Department not identified</div>
                <div className="why">
                  These reports contain no department column, and the sender&rsquo;s address
                  does not identify one, so no department was assumed. Add a Department
                  column to the report, or set it against the people listed on Data quality.
                </div>
                <Link className="btn secondary" href="/quality">Review attribution</Link>
              </div>
            )}

            {(() => {
              const un = depts.find(x => x.department === 'Unassigned'
                                      || x.department === 'Unknown');
              if (!un) return null;
              const share = Math.round(100 * un.total /
                Math.max(1, depts.reduce((a, x) => a + x.total, 0)));
              return (
                <div className="banner warn">
                  <strong>{un.total} task{un.total === 1 ? '' : 's'} ({share}%) sit under
                  &ldquo;Unassigned&rdquo;.</strong> Department reporting is only as complete
                  as the list of who belongs where. Fill it in on the{' '}
                  <a href="/roster">Team roster</a> and this work moves to its department
                  immediately &mdash; including the rows already imported.
                </div>
              );
            })()}

            <h2>Department detail</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Department</th><th>Manager</th>
                    <th className="num">Tasks</th><th className="num">Completed</th>
                    <th className="num">Pending</th><th className="num">Blocked</th>
                    <th className="num">Completion</th><th className="num">Slow</th>
                    <th className="num">Repeated</th><th className="num">People</th>
                  </tr>
                </thead>
                <tbody>
                  {depts.map(d => (
                    <tr key={d.department}>
                      <td><Link href={qs({ department: d.department })}>{d.department}</Link></td>
                      {/* Asked for by name: without it the only people on this
                          screen are the ones filing reports, and a manager
                          reading it cannot tell who is accountable for a
                          department from who is reporting into it. */}
                      <td>{d.manager || <span className="muted">not set</span>}</td>
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
