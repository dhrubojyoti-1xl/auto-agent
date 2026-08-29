'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    setBusy(false);
    if (res.ok) {
      router.push(params.get('next') || '/');
      router.refresh();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error || 'Sign in failed');
    }
  }

  return (
    <div className="center">
      <form className="card" style={{ width: 360 }} onSubmit={submit}>
        <h1>Department Reporting</h1>
        <p className="sub">Enter the team password to continue.</p>
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" value={password} autoFocus
               onChange={e => setPassword(e.target.value)} />
        {error && <div className="banner bad" style={{ marginTop: '.9rem' }}>{error}</div>}
        <button type="submit" disabled={busy || !password} style={{ marginTop: '1rem', width: '100%' }}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<div className="center">Loading…</div>}><LoginForm /></Suspense>;
}
