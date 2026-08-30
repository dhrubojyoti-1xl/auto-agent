'use client';
import { useState } from 'react';

interface Details {
  host: string; port: string; database: string; user: string; views: string[];
}

/**
 * Sets up the read-only login a charting tool connects with.
 *
 * The password is typed here and sent straight to this application's own
 * database. It is never stored, never logged and never shown again — losing it
 * costs one more click, which is a better trade than keeping a copy of it
 * anywhere.
 */
export default function BiControls() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState<Details | null>(null);
  const [copied, setCopied] = useState('');

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 1500);
    } catch { /* a browser that refuses the clipboard is not worth an error */ }
  };

  async function create() {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/admin/bi-access', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const json = await res.json();
      if (!res.ok) setError(json.error || 'Could not create the login');
      else { setDetails(json); setPassword(''); }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  if (details) {
    const rows: [string, string][] = [
      ['Host', details.host], ['Port', details.port],
      ['Database', details.database], ['Username', details.user]
    ];
    return (
      <div>
        <div className="banner ok" style={{ marginBottom: '.9rem' }}>
          <strong>Ready.</strong> Paste these into Looker Studio, with the password you
          just chose. Tick <strong>Enable SSL</strong>.
        </div>
        <div className="conn">
          {rows.map(([label, value]) => (
            <div key={label}>
              <span className="k">{label}</span>
              <code>{value}</code>
              <button className="secondary tiny" onClick={() => copy(label, value)}>
                {copied === label ? 'Copied' : 'Copy'}
              </button>
            </div>
          ))}
          <div>
            <span className="k">Password</span>
            <code className="muted">the one you just typed &mdash; not shown again</code>
            <span />
          </div>
        </div>
        <p className="small muted" style={{ marginTop: '.8rem' }}>
          This login can read {details.views.join(', ')} and nothing else. It cannot
          change anything, and it cannot see your Google connection.
        </p>
        <p className="small" style={{ marginTop: '.6rem' }}>
          <a href="https://lookerstudio.google.com/" target="_blank" rel="noreferrer">
            Open Looker Studio
          </a>{' '}
          &rarr; Create &rarr; Data source &rarr; PostgreSQL.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Creates a read-only login so a charting tool can read your reporting data
        without your database password. Choose a password below &mdash; it is sent
        straight to the database and never stored here, so write it down.
      </p>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <input type="password" value={password} autoComplete="new-password"
               placeholder="Choose a password (12+ characters)"
               onChange={e => setPassword(e.target.value)}
               style={{ maxWidth: '22rem' }} />
        <button disabled={busy || password.length < 12} onClick={create}>
          {busy ? 'Setting up…' : 'Create read-only login'}
        </button>
      </div>
      {error && <div className="banner bad" style={{ marginTop: '.7rem', marginBottom: 0 }}>{error}</div>}
    </div>
  );
}
