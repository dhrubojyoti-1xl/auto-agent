'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ConnectControls({
  configured, hasAccounts, accountId, showSync, autoSync
}: {
  configured: boolean; hasAccounts: boolean;
  accountId?: number; showSync?: boolean; autoSync?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [started, setStarted] = useState(false);

  const runSync = async () => {
    setBusy('sync'); setMsg('');
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) setMsg(j.error || 'Sync failed');
      else {
        const s = (j.summaries || []) as { reportsFound: number; rowsImported: number;
          rowsRejected: number; messagesScanned: number; status: string }[];
        const t = s.reduce((a, x) => ({
          scanned: a.scanned + x.messagesScanned, reports: a.reports + x.reportsFound,
          imported: a.imported + x.rowsImported, rejected: a.rejected + x.rowsRejected
        }), { scanned: 0, reports: 0, imported: 0, rejected: 0 });
        setMsg(`Scanned ${t.scanned} message(s), found ${t.reports} report(s), ` +
               `imported ${t.imported} row(s), rejected ${t.rejected}.`);
        router.refresh();
      }
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(''); }
  };

  // Kick off the first sync automatically right after connecting, so the user
  // sees data without being told to press anything.
  useEffect(() => {
    if (autoSync && !started) { setStarted(true); runSync(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSync, started]);

  if (accountId) {
    return (
      <button className="secondary" disabled={busy === 'dis'}
        onClick={async () => {
          setBusy('dis');
          await fetch('/api/accounts/disconnect', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: accountId })
          });
          setBusy(''); router.refresh();
        }}>
        {busy === 'dis' ? 'Disconnecting…' : 'Disconnect'}
      </button>
    );
  }

  return (
    <>
      <div className="row" style={{ marginTop: hasAccounts ? 0 : '.9rem' }}>
        {!hasAccounts && (
          <a className="btn" href="/api/auth/google"
             style={{ pointerEvents: configured ? 'auto' : 'none', opacity: configured ? 1 : .5 }}>
            Connect Gmail
          </a>
        )}
        {hasAccounts && (
          <a className="btn secondary" href="/api/auth/google">Connect another inbox</a>
        )}
        {(showSync || hasAccounts) && (
          <button className="secondary" disabled={!!busy} onClick={runSync}>
            {busy === 'sync' ? 'Reading your inbox…' : 'Sync now'}
          </button>
        )}
      </div>
      {msg && <div className="banner" style={{ marginBottom: 0 }}>{msg}</div>}
      {!hasAccounts && (
        <p className="small muted" style={{ marginTop: '.6rem' }}>
          Read-only. The assistant cannot send, delete or change anything in your mailbox.
        </p>
      )}
    </>
  );
}
