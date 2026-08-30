'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function SchemaControls() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  return (
    <>
      <button disabled={busy} onClick={async () => {
        setBusy(true); setMsg('');
        try {
          const res = await fetch('/api/admin/migrate', { method: 'POST' });
          const j = await res.json();
          setMsg(res.ok
            ? `Applied ${(j.applied || []).length} file(s); ${j.tables} tables, ${j.views} views.`
            : (j.error || 'Update failed'));
          if (res.ok) router.refresh();
        } catch (e) { setMsg((e as Error).message); }
        finally { setBusy(false); }
      }}>
        {busy ? 'Applying…' : 'Apply database update'}
      </button>
      {msg && <div className="banner" style={{ marginTop: '.7rem', marginBottom: 0 }}>{msg}</div>}
    </>
  );
}
