'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Fallback sign-in, used before a Google client is configured. */
export default function PasswordForm({ hasGoogle }: { hasGoogle: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(!hasGoogle);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    setBusy(false);
    if (res.ok) { router.push('/'); router.refresh(); }
    else setError((await res.json().catch(() => ({}))).error || 'Sign in failed');
  }

  if (!open) {
    return (
      <p className="small muted" style={{ textAlign: 'center', marginTop: '1rem' }}>
        <button className="secondary" style={{ background: 'none', border: 'none',
          color: 'var(--muted)', padding: 0, textDecoration: 'underline', cursor: 'pointer' }}
          onClick={() => setOpen(true)}>
          Use the team password instead
        </button>
      </p>
    );
  }

  return (
    <form onSubmit={submit} style={{ marginTop: hasGoogle ? '1.4rem' : '.4rem',
      borderTop: hasGoogle ? '1px solid var(--border)' : 'none',
      paddingTop: hasGoogle ? '1.1rem' : 0 }}>
      <label htmlFor="pw">Team password</label>
      <input id="pw" type="password" value={password} autoFocus={!hasGoogle}
             onChange={e => setPassword(e.target.value)} />
      {error && <div className="banner bad" style={{ marginBottom: 0 }}>{error}</div>}
      <button type="submit" disabled={busy || !password}
              className={hasGoogle ? 'secondary' : ''}
              style={{ marginTop: '.8rem', width: '100%' }}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
      {hasGoogle && (
        <p className="small muted" style={{ marginTop: '.6rem' }}>
          Password sign-in has its own workspace and cannot read a Gmail inbox.
        </p>
      )}
    </form>
  );
}
