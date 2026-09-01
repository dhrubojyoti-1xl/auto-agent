'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Person { name: string; department: string; email: string; aliases: string[]; role: string }
interface Dept { name: string; manager: string; managerEmail: string }
interface Rejected { row: number; values: string[]; reason: string }
interface Refiled {
  moved: number;
  changes: { from: string; to: string; tasks: number }[];
  rosterWithoutWork: string[];
  stillUnassigned: { employee: string; tasks: number }[];
}
interface Result {
  preview?: boolean; ok?: boolean; error?: string; note?: string;
  mapping?: Record<string, string>;
  people?: Person[]; departments?: Dept[]; rejected?: Rejected[];
  written?: { people: number; departments: number };
  refiled?: Refiled;
}

const SLOT_LABEL: Record<string, string> = {
  name: 'employee name', department: 'department', email: 'email',
  aliases: 'other names', role: 'role', manager: 'manager', managerEmail: 'manager email'
};

export default function ImportForm() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const router = useRouter();

  async function post(preview: boolean) {
    setBusy(preview ? 'preview' : 'save');
    setRes(null);
    try {
      const r = await fetch('/api/roster', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, preview })
      });
      const body = await r.json();
      setRes(body);
      if (!preview && body.ok) { setText(''); router.refresh(); }
    } catch (e) {
      // Without this the button looks like it did nothing at all.
      setRes({ error: (e as Error).message });
    } finally {
      setBusy('');
    }
  }

  async function onFile(file: File) {
    setText(await file.text());
    setRes(null);
  }

  return (
    <div className="chart-card">
      <h3>Import the team list</h3>
      <p className="cap">
        Open your staff spreadsheet, select the rows, copy, and paste them below &mdash;
        or drop a CSV in. Column headings can be whatever yours already says:
        &ldquo;Team&rdquo;, &ldquo;Staff Member&rdquo; and &ldquo;Mail ID&rdquo; are all understood.
        Only two are needed: a name and a department.
      </p>

      <textarea
        value={text}
        onChange={e => { setText(e.target.value); setRes(null); }}
        rows={8}
        spellCheck={false}
        placeholder={'Department\tEmployee\tEmail\tAlso known as\nSOP\tRahul Koli\trahul@1xl.com\tRahul K'}
        style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' }}
      />

      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.6rem' }}>
        <button disabled={!!busy || !text.trim()} onClick={() => post(true)}>
          {busy === 'preview' ? 'Reading…' : 'Check it first'}
        </button>
        <button className="secondary" disabled={!!busy || !text.trim()} onClick={() => post(false)}>
          {busy === 'save' ? 'Saving…' : 'Save roster'}
        </button>
        <label className="cap" style={{ cursor: 'pointer' }}>
          <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain"
                 style={{ display: 'none' }}
                 onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          <span style={{ textDecoration: 'underline' }}>or choose a CSV file</span>
        </label>
      </div>

      {res?.error && <p className="bad" style={{ marginTop: '0.8rem' }}>{res.error}</p>}

      {res?.note && <p className="good" style={{ marginTop: '0.8rem' }}>{res.note}</p>}

      {res?.written && (
        <p style={{ marginTop: '0.4rem' }}>
          <b>{res.written.people}</b> {res.written.people === 1 ? 'person' : 'people'} and{' '}
          <b>{res.written.departments}</b>{' '}
          {res.written.departments === 1 ? 'department' : 'departments'} saved.
        </p>
      )}

      {!!res?.refiled?.changes.length && (
        <>
          <h4 style={{ marginTop: '1rem' }}>Work already imported has been moved</h4>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>From</th><th>To</th><th className="num">Rows</th></tr></thead>
              <tbody>
                {res.refiled.changes.map(c => (
                  <tr key={c.from + c.to}>
                    <td>{c.from}</td><td>{c.to}</td><td className="num">{c.tasks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!!res?.refiled?.stillUnassigned.length && (
        <p className="cap" style={{ marginTop: '0.8rem' }}>
          Still unassigned, because these names are not on the roster:{' '}
          {res.refiled.stillUnassigned.slice(0, 10)
            .map(u => `${u.employee} (${u.tasks})`).join(', ')}
          {res.refiled.stillUnassigned.length > 10 &&
            ` and ${res.refiled.stillUnassigned.length - 10} more`}.
          Add them above and their work moves too.
        </p>
      )}

      {!!res?.refiled?.rosterWithoutWork.length && (
        <p className="cap" style={{ marginTop: '0.4rem' }}>
          On the roster but with no reported work yet:{' '}
          {res.refiled.rosterWithoutWork.slice(0, 10).join(', ')}
          {res.refiled.rosterWithoutWork.length > 10 &&
            ` and ${res.refiled.rosterWithoutWork.length - 10} more`}.
        </p>
      )}

      {res?.mapping && Object.keys(res.mapping).length > 0 && (
        <p className="cap" style={{ marginTop: '0.8rem' }}>
          Read as:{' '}
          {Object.entries(res.mapping)
            .map(([heading, slot]) => `${heading || '(no heading)'} → ${SLOT_LABEL[slot] || slot}`)
            .join(' · ')}
        </p>
      )}

      {res?.preview && !!res.people?.length && (
        <>
          <h4 style={{ marginTop: '1rem' }}>
            {res.people.length} {res.people.length === 1 ? 'person' : 'people'} would be saved
          </h4>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>Name</th><th>Department</th><th>Email</th><th>Also known as</th></tr>
              </thead>
              <tbody>
                {res.people.slice(0, 50).map(p => (
                  <tr key={p.name}>
                    <td>{p.name}</td><td>{p.department}</td>
                    <td>{p.email || '—'}</td><td>{p.aliases.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {res.people.length > 50 && (
            <p className="cap">Showing the first 50 of {res.people.length}.</p>
          )}
        </>
      )}

      {!!res?.rejected?.length && (
        <>
          <h4 style={{ marginTop: '1rem' }}>
            {res.rejected.length} {res.rejected.length === 1 ? 'row' : 'rows'} could not be used
          </h4>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Row</th><th>Reason</th><th>What was there</th></tr></thead>
              <tbody>
                {res.rejected.slice(0, 30).map(r => (
                  <tr key={r.row}>
                    <td className="num">{r.row}</td>
                    <td>{r.reason}</td>
                    <td className="cap">{r.values.filter(Boolean).join(' | ') || '(empty)'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
