import { redirect } from 'next/navigation';
import Nav from '../nav';
import { getSession } from '@/lib/auth';
import { getUser } from '@/lib/users';
import { listGmailAccounts, listSyncRuns } from '@/lib/accounts';
import { googleConfigured } from '@/lib/google-oauth';
import ConnectControls from './controls';
import SchemaControls from './schema-controls';
import { getSchemaStatus } from '@/lib/schema-status';
import { safeErrorMessage } from '@/lib/safe-error';
import { formatStamp } from '@/lib/format-date';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  not_configured: 'Google sign-in is not configured on this deployment yet. An administrator needs to set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
  state_mismatch: 'The sign-in attempt could not be verified. Please try again.',
  missing_code: 'Google did not return an authorisation code. Please try again.',
  no_refresh_token: 'Google did not issue a refresh token, so the assistant could not keep reading your inbox unattended. Remove this app at myaccount.google.com/permissions and connect again.',
  gmail_scope_denied: 'Gmail read access was not granted, so reports cannot be collected. Please connect again and leave the Gmail permission ticked.',
  no_id_token: 'Google did not return an identity token. Please try again.'
};

export default async function ConnectPage({
  searchParams
}: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  const params = await searchParams;
  const configured = googleConfigured();
  const me = await getUser(session.userId).catch(() => null);

  let accounts: Awaited<ReturnType<typeof listGmailAccounts>> = [];
  let runs: Awaited<ReturnType<typeof listSyncRuns>> = [];
  let schema: Awaited<ReturnType<typeof getSchemaStatus>> | null = null;
  let dbError = '';
  try {
    [accounts, runs, schema] = await Promise.all([
      listGmailAccounts(session.userId), listSyncRuns(session.userId, 10),
      getSchemaStatus()
    ]);
  } catch (e) {
    dbError = safeErrorMessage(e);
  }

  const errKey = params.error || '';
  const errMsg = errKey ? (ERRORS[errKey] || decodeURIComponent(errKey)) : '';

  return (
    <>
      <Nav />
      <main className="shell">
        <h1>Connect your inbox</h1>
        {me && (
          <p className="small muted" style={{ marginTop: '-.4rem' }}>
            Signed in as <strong>{me.email}</strong>
            {me.kind === 'local' && ' (password sign-in)'}
          </p>
        )}
        <p className="sub">
          Sign in with Google once. After that the assistant reads report emails from your
          inbox on its own — you never label, forward or upload anything.
        </p>

        {errMsg && <div className="banner bad">{errMsg}</div>}
        {params.connected && !errMsg && (
          <div className="banner ok">
            Connected. The first sync is running now; reports will appear on the
            Overview page within a minute or two.
          </div>
        )}
        {dbError && (
          <div className="banner bad">
            <strong>Database unavailable.</strong> {dbError}
          </div>
        )}

        {!configured && (
          <div className="banner warn">
            <strong>Administrator setup required.</strong> This deployment has no Google
            OAuth client yet. See <code>docs/GOOGLE_OAUTH_SETUP.md</code> — it is a one-time
            job and takes about ten minutes.
          </div>
        )}

        {schema && !schema.ok && (
          <div className="card" style={{ borderColor: 'var(--warn, #b45309)' }}>
            <h3>Database update pending</h3>
            <p className="small muted">
              This deployment is running newer code than the database has been given.
              Missing: {[...schema.missingColumns, ...schema.missingViews].join(', ')}.
              Applying is safe to repeat and does not touch imported data.
            </p>
            <SchemaControls />
          </div>
        )}

        <h2>Connected accounts</h2>
        {accounts.length === 0 ? (
          <div className="card">
            <h3>No inbox connected</h3>
            <p className="small muted">
              The assistant has nothing to read yet. Connecting grants
              <strong> read-only </strong> access to Gmail: it can see messages and
              attachments, and it cannot send, delete, label or modify anything.
            </p>
            <ConnectControls configured={configured} hasAccounts={false}
                             autoSync={!!params.sync} />
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Account</th><th>Connected</th><th>Last sync</th>
                    <th>Status</th><th>Detail</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(a => (
                    <tr key={a.id}>
                      <td>
                        <strong>{a.email}</strong>
                        {a.displayName && a.displayName !== a.email && (
                          <div className="small muted">{a.displayName}</div>
                        )}
                      </td>
                      <td className="small">{formatStamp(a.connectedAt)}</td>
                      <td className="small">
                        {formatStamp(a.lastSyncAt, 'not yet')}
                      </td>
                      <td>
                        <span className={'pill ' + (
                          a.lastSyncStatus === 'OK' ? 'ok'
                            : a.lastSyncStatus === 'REAUTH_REQUIRED' ? 'bad'
                            : a.lastSyncStatus ? 'warn' : 'mute')}>
                          {a.lastSyncStatus || 'pending'}
                        </span>
                      </td>
                      <td className="small muted">{a.lastSyncMessage || '—'}</td>
                      <td><ConnectControls configured={configured} hasAccounts accountId={a.id} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {accounts.some(a => a.lastSyncStatus === 'REAUTH_REQUIRED') && (
              <div className="banner bad">
                Google access was revoked or expired for one of these accounts. Reconnect it
                to resume automatic collection.
              </div>
            )}
            <div style={{ marginTop: '1rem' }}>
              <ConnectControls configured={configured} hasAccounts showSync
                               autoSync={!!params.sync} />
            </div>
          </>
        )}

        <h2>What the assistant does on its own</h2>
        <div className="card small">
          <ol style={{ margin: 0, paddingLeft: '1.1rem', lineHeight: 1.8 }}>
            <li>
              Checks your inbox once a day, and whenever you press
              <strong> Sync now</strong>.
            </li>
            <li>
              Reads each new message, any spreadsheet or CSV attached to it, and any
              Google Sheet it links to.
            </li>
            <li>
              Decides whether it is a report from what the columns mean, not from their
              exact names &mdash; &ldquo;Work Done Today&rdquo;, &ldquo;Staff Member&rdquo;
              and &ldquo;Current State&rdquo; are understood without anyone configuring
              them. No labels, no template, no rules for you to maintain.
            </li>
            <li>
              Keeps yesterday&rsquo;s work, today&rsquo;s work and tomorrow&rsquo;s plan
              apart, so a plan never counts as something that was done.
            </li>
            <li>Normalises statuses, names, dates and departments.</li>
            <li>Rejects rows it cannot trust, with a reason, instead of guessing.</li>
            <li>Refuses to import the same report twice, however often it is re-sent.</li>
            <li>Updates the dashboard and regenerates the management summary.</li>
          </ol>
        </div>

        <h2>Recent activity</h2>
        {runs.length === 0 ? (
          <div className="card small muted">No syncs yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th><th>Account</th><th>Trigger</th><th>Status</th>
                  <th className="num">Scanned</th><th className="num">Reports</th>
                  <th className="num">Imported</th><th className="num">Rejected</th>
                  <th className="num">Duplicates</th><th>Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id}>
                    <td className="small">{formatStamp(r.startedAt)}</td>
                    <td className="small">{r.email}</td>
                    <td className="small">{r.trigger}</td>
                    <td>
                      <span className={'pill ' + (
                        r.status === 'OK' ? 'ok' : r.status === 'RUNNING' ? 'mute'
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
