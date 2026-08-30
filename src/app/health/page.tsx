import { redirect } from 'next/navigation';
import Nav from '../nav';
import { getSession } from '@/lib/auth';
import { listGmailAccounts, listSyncRuns } from '@/lib/accounts';
import { getKpis, getRejections } from '@/lib/queries';
import { getCoverage } from '@/lib/analytics';
import { googleConfigured } from '@/lib/google-oauth';
import { query } from '@/lib/db';
import { safeErrorMessage } from '@/lib/safe-error';
import { formatStamp } from '@/lib/format-date';

export const dynamic = 'force-dynamic';

/**
 * When the scheduled check next runs, in the manager's terms.
 *
 * The cron fires at 03:00 UTC daily, so "next run" is either later today or
 * tomorrow. Computed rather than stated, because a fixed sentence goes stale
 * the moment somebody reads it at 04:00.
 */
function nextScheduledSync(): string {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(),
    now.getUTCDate() + (now.getUTCHours() >= 3 ? 1 : 0), 3, 0, 0));
  return `${next.toISOString().slice(0, 10)} 03:00 UTC`;
}

/** PHASE 24 — everything an operator needs to trust the pipeline, in one place. */
export default async function SyncHealthPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const uid = session.userId;

  let inboxes: Awaited<ReturnType<typeof listGmailAccounts>> = [];
  let runs: Awaited<ReturnType<typeof listSyncRuns>> = [];
  let kpis = null, rejects: Awaited<ReturnType<typeof getRejections>> = [];
  let coverage: Awaited<ReturnType<typeof getCoverage>> | null = null;
  let dbError = '';
  try {
    [inboxes, runs, kpis, rejects, coverage] = await Promise.all([
      listGmailAccounts(uid), listSyncRuns(uid, 25), getKpis(uid), getRejections(uid),
      getCoverage(uid)
    ]);
  } catch (e) { dbError = safeErrorMessage(e); }

  const totals = runs.reduce((a, r) => ({
    scanned: a.scanned + r.messagesScanned, found: a.found + r.reportsFound,
    imported: a.imported + r.rowsImported, rejected: a.rejected + r.rowsRejected,
    duplicate: a.duplicate + r.rowsDuplicate
  }), { scanned: 0, found: 0, imported: 0, rejected: 0, duplicate: 0 });

  const lastRun = runs[0];
  const needsReconnect =
    inboxes.some(a => a.lastSyncStatus === 'GMAIL_AUTH_ERROR' ||
                      a.lastSyncStatus === 'REAUTH_REQUIRED') ||
    runs.slice(0, 3).some(r => r.status === 'GMAIL_AUTH_ERROR' ||
                               r.status === 'REAUTH_REQUIRED');
  const lastError = runs.find(r => r.errorMessage)?.errorMessage || '';
  // Every one of these comes from the analytics module, so this page cannot
  // disagree with the dashboard about what happened.
  const processed = coverage?.reportsDetected ?? 0;
  const ignored = coverage?.messagesIgnored ?? 0;
  const failed = coverage?.reportsNeedingReview ?? 0;

  function Row({ label, value, note }: { label: string; value: string | number; note?: string }) {
    return (
      <tr>
        <td style={{ width: 220 }}>{label}</td>
        <td><strong>{value}</strong>{note && <span className="small muted"> {note}</span>}</td>
      </tr>
    );
  }

  return (
    <>
      <Nav />
      <main className="shell">
        <h1>Sync health</h1>
        <p className="sub">What the assistant has actually done, without reading logs.</p>

        {dbError && <div className="banner bad"><strong>Database unavailable.</strong> {dbError}</div>}

        {/* The one condition a manager must be able to clear themselves, and
            the one that will actually happen: an OAuth app in Testing status
            expires its refresh token every seven days. It has to read as a
            button, not as a failure. */}
        {needsReconnect && (
          <div className="banner bad" style={{ display: 'grid', gap: '.6rem' }}>
            <div>
              <strong>Gmail access has expired.</strong> Google stopped accepting the saved
              authorisation, so reports are not being collected. Nothing already imported is
              affected, and no report is lost &mdash; unread mail is read on the next sync.
            </div>
            <div className="small">
              This happens roughly every seven days while the Google app is in Testing
              status. One click fixes it.
            </div>
            <div className="row">
              <a className="btn" href="/api/auth/google">Reconnect Gmail</a>
            </div>
          </div>
        )}

        <h2>Connection</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              <Row label="Google sign-in configured"
                   value={googleConfigured() ? 'yes' : 'NO'}
                   note={googleConfigured() ? '' : '— set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET'} />
              <Row label="Connected Gmail"
                   value={inboxes.length ? inboxes.map(a => a.email).join(', ') : 'none'} />
              <Row label="Last sync"
                   value={formatStamp(lastRun?.startedAt, 'never')}
                   note={lastRun ? `(${lastRun.trigger})` : ''} />
              <Row label="Sync status"
                   value={lastRun ? lastRun.status : '—'}
                   note={needsReconnect ? '— reconnect above to resume' : ''} />
              <Row label="Last successful sync"
                   value={formatStamp(runs.find(r => r.status === 'OK')?.startedAt, 'never')} />
              <Row label="Automatic schedule" value="daily at 03:00 UTC"
                   note={`— next run ${nextScheduledSync()}; plus Sync now. Hourly needs a Vercel Pro plan`} />
              <Row label="AI commentary"
                   value={process.env.ANTHROPIC_API_KEY ? 'configured' : 'not configured'}
                   note={process.env.ANTHROPIC_API_KEY
                     ? '— reused when the figures have not changed'
                     : '— the dashboard and reports work without it'} />
              <Row label="Running build"
                   value={(process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7)}
                   note={process.env.VERCEL_REGION ? `— ${process.env.VERCEL_REGION}` : '— local'} />
            </tbody>
          </table>
        </div>

        <h2>Keep a copy</h2>
        <div className="card">
          <p className="small muted" style={{ marginTop: 0 }}>
            Supabase&rsquo;s free plan has no point-in-time recovery, so the safety net is a
            file you hold. The export contains your tasks, rejected rows, import history and
            master data &mdash; everything that cannot simply be re-read from Gmail. It never
            contains your Gmail token.
          </p>
          <div className="row">
            <a className="btn secondary" href="/api/export?format=json">Download full export (JSON)</a>
            <a className="btn secondary" href="/api/export?format=csv">Download tasks (CSV)</a>
          </div>
        </div>

        {coverage && (
          <>
            <h2>Reporting coverage</h2>
            <p className="small muted">
              The same figures the dashboard uses. &ldquo;Detected&rdquo; means a report was
              recognised; &ldquo;processed&rdquo; means it became tasks.
            </p>
            <div className="kpis secondary">
              <div className="kpi"><div className="label">Messages read</div>
                <div className="value">{coverage.messagesScanned}</div></div>
              <div className="kpi"><div className="label">Reports detected</div>
                <div className="value">{coverage.reportsDetected}</div></div>
              <div className="kpi"><div className="label">Reports processed</div>
                <div className="value">{coverage.reportsProcessed}</div></div>
              <div className="kpi"><div className="label">Needing review</div>
                <div className="value">{coverage.reportsNeedingReview}</div></div>
              <div className="kpi"><div className="label">Rows imported</div>
                <div className="value">{coverage.rowsImported}</div></div>
              <div className="kpi"><div className="label">Rows rejected</div>
                <div className="value">{coverage.rowsRejected}</div></div>
              <div className="kpi"><div className="label">Duplicates blocked</div>
                <div className="value">{coverage.duplicatesBlocked}</div></div>
              <div className="kpi"><div className="label">Not reports</div>
                <div className="value">{coverage.messagesIgnored}</div></div>
            </div>
          </>
        )}

        <h2>Throughput (last {runs.length} run{runs.length === 1 ? '' : 's'})</h2>
        <div className="kpis">
          <div className="kpi"><div className="label">Emails scanned</div><div className="value">{totals.scanned}</div></div>
          <div className="kpi"><div className="label">Reports found</div><div className="value">{totals.found}</div></div>
          <div className="kpi"><div className="label">Reports processed</div><div className="value">{processed}</div></div>
          <div className="kpi"><div className="label">Reports failed</div><div className="value">{failed}</div></div>
          <div className="kpi"><div className="label">Ignored (not reports)</div><div className="value">{ignored}</div></div>
          <div className="kpi"><div className="label">Tasks imported</div><div className="value">{kpis?.total ?? 0}</div></div>
          <div className="kpi"><div className="label">Duplicates blocked</div><div className="value">{totals.duplicate}</div></div>
          <div className="kpi"><div className="label">Invalid rows</div><div className="value">{rejects.length}</div></div>
        </div>

        {lastError && (
          <div className="banner bad" style={{ marginTop: '1rem' }}>
            <strong>Last error:</strong> {lastError}
          </div>
        )}
        {!lastError && runs.length > 0 && (
          <div className="banner ok" style={{ marginTop: '1rem' }}>No errors in the recent runs.</div>
        )}

        <h2>Run history</h2>
        {runs.length === 0 ? (
          <div className="card small muted">
            No syncs yet. Connect an inbox on the <a href="/connect">Inbox</a> page.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th><th>Trigger</th><th>Status</th>
                  <th className="num">Scanned</th><th className="num">Reports</th>
                  <th className="num">Imported</th><th className="num">Rejected</th>
                  <th className="num">Duplicates</th><th>Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id}>
                    <td className="small">{formatStamp(r.startedAt)}</td>
                    <td className="small">{r.trigger}</td>
                    <td>
                      <span className={'pill ' + (r.status === 'OK' ? 'ok'
                        : r.status === 'RUNNING' ? 'mute'
                        : r.status === 'PARTIAL' ? 'warn' : 'bad')}>{r.status}</span>
                    </td>
                    <td className="num">{r.messagesScanned}</td>
                    <td className="num">{r.reportsFound}</td>
                    <td className="num">{r.rowsImported}</td>
                    <td className="num">{r.rowsRejected}</td>
                    <td className="num">{r.rowsDuplicate}</td>
                    <td className="small muted">{r.errorMessage || '—'}</td>
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
