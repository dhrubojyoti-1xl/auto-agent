import { redirect } from 'next/navigation';
import Nav from '../nav';
import { getSession } from '@/lib/auth';
import { listGmailAccounts, listSyncRuns } from '@/lib/accounts';
import { getKpis, getRejections } from '@/lib/queries';
import { googleConfigured } from '@/lib/google-oauth';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** PHASE 24 — everything an operator needs to trust the pipeline, in one place. */
export default async function SyncHealthPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const uid = session.userId;

  let inboxes: Awaited<ReturnType<typeof listGmailAccounts>> = [];
  let runs: Awaited<ReturnType<typeof listSyncRuns>> = [];
  let kpis = null, rejects: Awaited<ReturnType<typeof getRejections>> = [];
  let docStats: { status: string; n: number }[] = [];
  let dbError = '';
  try {
    [inboxes, runs, kpis, rejects, docStats] = await Promise.all([
      listGmailAccounts(uid), listSyncRuns(uid, 25), getKpis(uid), getRejections(uid),
      query<{ status: string; n: number }>(
        `select processing_status as status, count(*)::int as n from documents
         where owner_user_id = $1 group by 1 order by 1`, [uid])
    ]);
  } catch (e) { dbError = (e as Error).message; }

  const totals = runs.reduce((a, r) => ({
    scanned: a.scanned + r.messagesScanned, found: a.found + r.reportsFound,
    imported: a.imported + r.rowsImported, rejected: a.rejected + r.rowsRejected,
    duplicate: a.duplicate + r.rowsDuplicate
  }), { scanned: 0, found: 0, imported: 0, rejected: 0, duplicate: 0 });

  const lastRun = runs[0];
  const lastError = runs.find(r => r.errorMessage)?.errorMessage || '';
  const processed = docStats.filter(d => d.status !== 'NO_DATA')
    .reduce((n, d) => n + d.n, 0);
  const ignored = docStats.find(d => d.status === 'NO_DATA')?.n || 0;
  const failed = docStats.find(d => d.status === 'FAILED')?.n || 0;

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
                   value={lastRun ? String(lastRun.startedAt).slice(0, 16).replace('T', ' ') : 'never'}
                   note={lastRun ? `(${lastRun.trigger})` : ''} />
              <Row label="Sync status" value={lastRun ? lastRun.status : '—'} />
              <Row label="Automatic schedule" value="daily"
                   note="— plus Sync now; hourly needs a Vercel Pro plan" />
            </tbody>
          </table>
        </div>

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
                    <td className="small">{String(r.startedAt).slice(0, 16).replace('T', ' ')}</td>
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
