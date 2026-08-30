'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ReportControls({ aiConfigured }: { aiConfigured: boolean }) {
  const router = useRouter();
  const [type, setType] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('DAILY');
  const [useAi, setUseAi] = useState(aiConfigured);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  async function post(path: string, body: unknown, label: string) {
    setBusy(label); setError(''); setDone('');
    try {
      const res = await fetch(path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (!res.ok) setError(json.error || 'Request failed');
      else {
        // Rebuilding changes rows on other pages, not this one, so without a
        // line of feedback the button looks like it did nothing at all.
        if (label === 'rebuild') {
          setDone(`Re-analysed ${json.tasks} task(s): ${json.repeatGroups} repeat ` +
                  `group(s), ${json.slowTasks} slow task(s).`);
        }
        router.refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(''); }
  }

  return (
    <div className="card">
      <div className="row">
        <select value={type} onChange={e => setType(e.target.value as typeof type)}
                style={{ width: 'auto' }}>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
        </select>
        <label style={{ margin: 0, display: 'flex', gap: '.4rem', alignItems: 'center' }}>
          <input type="checkbox" checked={useAi} disabled={!aiConfigured}
                 onChange={e => setUseAi(e.target.checked)} style={{ width: 'auto' }} />
          Use AI commentary
        </label>
        <button disabled={!!busy}
                onClick={() => post('/api/report', { type, useAi }, 'report')}>
          {busy === 'report' ? 'Generating…' : 'Generate report'}
        </button>
        <button className="secondary" disabled={!!busy}
                onClick={() => post('/api/rebuild', {}, 'rebuild')}>
          {busy === 'rebuild' ? 'Rebuilding…' : 'Rebuild analysis'}
        </button>
      </div>
      {error && <div className="banner bad" style={{ marginBottom: 0 }}>{error}</div>}
      {done && <div className="banner ok" style={{ marginBottom: 0 }}>{done}</div>}
    </div>
  );
}
