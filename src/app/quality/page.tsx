import { redirect } from 'next/navigation';
import Nav from '../nav';
import { getSession } from '@/lib/auth';
import { formatDay, formatStamp } from '@/lib/format-date';
import {
  getAutoCreatedEmployees, getDocuments, getMessageOutcomes, getRejections
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function QualityPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const [rejections, documents, invented, outcomes] = await Promise.all([
    getRejections(session.userId), getDocuments(session.userId, 30),
    getAutoCreatedEmployees(session.userId), getMessageOutcomes(session.userId, 50)
  ]);

  // A decision the assistant made and finished with, versus something it could
  // not finish. Only the second needs anyone's attention.
  const NEEDS_A_PERSON = new Set(['REVIEW_REQUIRED', 'UNSUPPORTED_FORMAT', 'POSSIBLE_REPORT']);
  const needsReview = outcomes.filter(o => NEEDS_A_PERSON.has(o.classification));
  const settled = outcomes.filter(o => !NEEDS_A_PERSON.has(o.classification));
  const LABEL: Record<string, string> = {
    REVIEW_REQUIRED: 'Needs a look',
    UNSUPPORTED_FORMAT: 'Format not readable',
    POSSIBLE_REPORT: 'Looked like a report',
    NON_REPORT: 'Not a report'
  };
  const byReason = rejections.reduce<Record<string, number>>((acc, r) => {
    acc[r.reason] = (acc[r.reason] || 0) + 1; return acc;
  }, {});

  return (
    <>
      <Nav />
      <main className="shell">
        <h1>Data quality</h1>
        <p className="sub">
          Every row &mdash; and every attachment &mdash; that did not become a task is here,
          with its original values and an actionable reason. Nothing is silently dropped: a
          spreadsheet that was too large, unreadable or not a report says so by name.
        </p>

        {Object.keys(byReason).length > 0 && (
          <div className="kpis">
            {Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([reason, n]) => (
              <div className="kpi" key={reason}>
                <div className="label">{reason.replace(/_/g, ' ').toLowerCase()}</div>
                <div className="value">{n}</div>
              </div>
            ))}
          </div>
        )}

        <h2>Rejected rows</h2>
        {rejections.length === 0 ? (
          <div className="card">No rejected rows. Every row imported cleanly.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Logged</th><th>Reason</th><th>Why, and how to fix it</th>
                  <th>Date</th><th>Employee</th><th>Task or file</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rejections.map(r => (
                  <tr key={r.id}>
                    <td className="small">{formatStamp(r.loggedAt)}</td>
                    <td><span className="pill bad">{r.reason}</span></td>
                    <td className="small">{r.detail}</td>
                    <td className="small">{r.raw.date || '—'}</td>
                    <td className="small">{r.raw.employee || '—'}</td>
                    {/* Whole attachments are rejected too — an unreadable
                        workbook has no task or employee, only a filename. */}
                    <td className="small">{r.raw.task || r.raw.attachment || '—'}</td>
                    <td className="small">{r.raw.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h2>Messages that need a person</h2>
        {needsReview.length === 0 ? (
          <div className="card small muted">
            Nothing is waiting. Every message was either processed or decided against.
          </div>
        ) : (
          <>
            <p className="small muted">
              Something in these messages looked like a report and could not be read.
              Each says what happened and what would fix it.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Received</th><th>From</th><th>Subject</th>
                    <th>Outcome</th><th>What happened, and what would fix it</th>
                  </tr>
                </thead>
                <tbody>
                  {needsReview.map((o, i) => (
                    <tr key={i}>
                      <td className="small">{formatDay(o.receivedAt)}</td>
                      <td className="small">{o.sender.slice(0, 40)}</td>
                      <td className="small">{o.subject.slice(0, 60)}</td>
                      <td><span className="pill warn">{LABEL[o.classification]}</span></td>
                      <td className="small muted">{o.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <h2>Messages decided against</h2>
        {settled.length === 0 ? (
          <div className="card small muted">No messages have been ruled out yet.</div>
        ) : (
          <>
            <p className="small muted">
              Read, judged not to be reports, and not looked at again. Shown so that a
              report ruled out by mistake is findable rather than invisible.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Received</th><th>From</th><th>Subject</th><th>Why</th>
                      <th className="num">Score</th></tr>
                </thead>
                <tbody>
                  {settled.slice(0, 25).map((o, i) => (
                    <tr key={i}>
                      <td className="small">{formatDay(o.receivedAt)}</td>
                      <td className="small">{o.sender.slice(0, 40)}</td>
                      <td className="small">{o.subject.slice(0, 60)}</td>
                      <td className="small muted">
                        {o.evidence}
                        {/* The signals that decided it, so a report ignored by
                            mistake can be argued with rather than guessed at. */}
                        {o.prefilterSignals && (
                          <div className="small muted" style={{ marginTop: '.2rem' }}>
                            {o.prefilterSignals}
                          </div>
                        )}
                      </td>
                      <td className="num small muted">
                        {o.prefilterScore === null ? '—' : o.prefilterScore}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <h2>People the assistant assumed</h2>
        {invented.length === 0 ? (
          <div className="card small muted">
            Every name in every report matched someone already on the roster.
          </div>
        ) : (
          <>
            <p className="small muted">
              A report named someone who was not on the roster, so a record was created for
              them. The department below is a guess taken from the first report they appeared
              in &mdash; and it decides where their later rows are filed when a report has no
              department column. Correct any that are wrong.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th><th>Assumed department</th><th className="num">Tasks</th>
                    <th>First seen</th><th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {invented.map(e => (
                    <tr key={e.id}>
                      <td>{e.name}</td>
                      <td><span className="pill warn">{e.department || 'none'}</span></td>
                      <td className="num">{e.tasks}</td>
                      <td className="small">{e.firstSeen || '—'}</td>
                      <td className="small">{e.lastSeen || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <h2>Import history</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Processed</th><th>Source</th><th>Subject</th><th>Department</th>
                <th>Status</th><th className="num">Extracted</th><th className="num">Imported</th>
                <th className="num">Already present</th><th className="num">Rejected</th>
              </tr>
            </thead>
            <tbody>
              {documents.map(d => (
                <tr key={d.reportId}>
                  <td className="small">{formatStamp(d.processedAt)}</td>
                  <td className="small">{d.source}</td>
                  <td className="small">{d.subject}</td>
                  <td className="small">{d.department || '—'}</td>
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
