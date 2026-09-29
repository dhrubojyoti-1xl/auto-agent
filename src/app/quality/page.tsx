import { redirect } from 'next/navigation';
import Nav from '../nav';
import { getSession } from '@/lib/auth';
import { formatDay, formatStamp } from '@/lib/format-date';
import OtherMessagesNote from '../other-messages';
import { likelySamePerson, looksLikePersonName } from '@/lib/core/person-name';
import { loadRoster } from '@/lib/db';
import {
  getAutoCreatedEmployees, getDocuments, getMessageOutcomes, getOtherMessageCount,
  getRejections
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function QualityPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const [rejections, documents, invented, outcomes, otherMessages, roster] = await Promise.all([
    getRejections(session.userId), getDocuments(session.userId, 30),
    getAutoCreatedEmployees(session.userId), getMessageOutcomes(session.userId, 50),
    getOtherMessageCount(session.userId), loadRoster()
  ]);
  const rosterNames = roster.people.filter(p => !p.autoCreated).map(p => p.name);
  const hasRoster = rosterNames.length > 0;

  // An earlier importer recorded task titles, places and lists of names as
  // people ("Attendance Monitoring", "Dubai", "Admin Panel"). The records are
  // left as they are; only names that could be a person are listed, and the
  // rest are counted, because five hundred task titles bury the handful of
  // real people a manager needs to check.
  //
  // A guessed name with no work filed under it in this account is not this
  // account's business: test names from another inbox, filed under departments
  // this company does not have, were being listed here as colleagues.
  const personLike = invented.filter(e => looksLikePersonName(e.name));
  const assumedPeople = personLike.filter(e => e.tasks > 0);
  const idleGuesses = personLike.length - assumedPeople.length;
  const notPeople = invented.filter(e => !looksLikePersonName(e.name));
  const notPeopleTasks = notPeople.reduce((a, e) => a + e.tasks, 0);

  // A decision the assistant made and finished with, versus something it could
  // not finish. Only the second needs anyone's attention.
  const NEEDS_A_PERSON = new Set(['REVIEW_REQUIRED', 'UNSUPPORTED_FORMAT', 'POSSIBLE_REPORT']);
  const needsReview = outcomes.filter(o => NEEDS_A_PERSON.has(o.classification));
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

        <h2>Reports that need a person</h2>
        {needsReview.length === 0 ? (
          <div className="card small muted">
            Nothing is waiting. Every report that arrived was processed.
          </div>
        ) : (
          <>
            <p className="small muted">
              These were recognised as reports and could not be fully read.
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

        {/* Only reports are ever shown. Every other message is checked to find
            the reports among them, and is reduced here to a number. */}
        <div style={{ marginTop: '1rem' }}><OtherMessagesNote {...otherMessages} /></div>

        <h2>People the assistant assumed</h2>
        {notPeople.length > 0 && (
          <p className="small muted">
            {notPeople.length} more record{notPeople.length === 1 ? ' is' : 's are'} not
            {notPeople.length === 1 ? ' a person' : ' people'} &mdash; task titles, places and
            lists of names that an earlier version filed as employees
            {notPeopleTasks > 0
              ? ` (${notPeopleTasks} task${notPeopleTasks === 1 ? '' : 's'} in this account are filed under them)`
              : ' (no tasks in this account are filed under them)'}.
            They are not shown{hasRoster
              ? <>. The <a href="/roster">Team roster</a> is the list of real people.</>
              : <>. Importing the <a href="/roster">Team roster</a> puts the real people on
                record.</>}
          </p>
        )}
        {idleGuesses > 0 && (
          <p className="small muted">
            {idleGuesses} more name{idleGuesses === 1 ? '' : 's'} taken from old reports
            {idleGuesses === 1 ? ' has' : ' have'} no work filed in this account and
            {idleGuesses === 1 ? ' is' : ' are'} not shown.
          </p>
        )}
        {assumedPeople.length === 0 ? (
          <div className="card small muted">
            {notPeople.length || idleGuesses
              ? 'No one else was assumed.'
              : 'Every name in every report matched someone already on the roster.'}
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
                    <th>First seen</th><th>Last seen</th><th>Possibly the same as</th>
                  </tr>
                </thead>
                <tbody>
                  {assumedPeople.map(e => (
                    <tr key={e.id}>
                      <td>{e.name}</td>
                      <td><span className="pill warn">{e.department || 'none'}</span></td>
                      <td className="num">{e.tasks}</td>
                      <td className="small">{e.firstSeen || '—'}</td>
                      <td className="small">{e.lastSeen || '—'}</td>
                      <td className="small">{likelySamePerson(e.name, rosterNames) || '—'}</td>
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
              {documents.length === 0 && (
                <tr><td colSpan={9} className="small muted">No imports yet.</td></tr>
              )}
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
