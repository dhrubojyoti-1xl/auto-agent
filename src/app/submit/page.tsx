'use client';
import Link from 'next/link';
import { useState } from 'react';
import Nav from '../nav';
import type { IngestResult } from '@/lib/core/types';

type Preview = IngestResult & { rowsWritten?: number };

export default function SubmitPage() {
  const [subject, setSubject] = useState('Daily Report');
  const [content, setContent] = useState('');
  // A copy out of Google Sheets or Excel carries the sheet as an HTML table as
  // well as plain text. The table keeps what the text loses — the merged DWR
  // title row, links — so it is what gets sent, while the box shows the text.
  const [pastedHtml, setPastedHtml] = useState('');
  const [employee, setEmployee] = useState('');
  const [date, setDate] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [committed, setCommitted] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setPreview(null); setCommitted(null); };

  async function call(path: string) {
    setBusy(true); setError('');
    try {
      const res = await fetch(path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject, content: pastedHtml || content, employee, date })
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error || 'Request failed'); return null; }
      return body as Preview;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally { setBusy(false); }
  }

  return (
    <>
      <Nav />
      <main className="shell">
        <h1>Manual entry</h1>
        <p className="sub">
          Select the report in Google Sheets or Excel — the DWR title row included — copy it,
          and paste it below. A table copied from an email, or a plain{' '}
          <code>a | b | c</code> table, works too. Nothing is saved until you confirm.
        </p>

        <div className="card">
          <label htmlFor="subject">Subject</label>
          <input id="subject" type="text" value={subject} onChange={e => setSubject(e.target.value)} />
          <label htmlFor="content">Report content</label>
          <textarea id="content" value={content} placeholder={
            'Paste the DWR here (Ctrl+V) — or type:\n' +
            'Date | Employee | Task | Status | Link\n' +
            '29 Aug 2026 | A. Lovelace | Update CRM | Completed | https://…'
          }
            onPaste={e => {
              const html = e.clipboardData.getData('text/html');
              setPastedHtml(/<table[\s>]/i.test(html) ? html : '');
              reset();
            }}
            onChange={e => {
              // Typing over a paste means the text is now the report.
              if (pastedHtml && e.nativeEvent instanceof InputEvent &&
                  e.nativeEvent.inputType !== 'insertFromPaste') setPastedHtml('');
              if (!e.target.value) setPastedHtml('');
              setContent(e.target.value); reset();
            }} />
          {pastedHtml && (
            <p className="small muted" style={{ margin: '.35rem 0 0' }}>
              Pasted as a spreadsheet table — the title row and links are kept.
            </p>
          )}
          <div className="row" style={{ marginTop: '.6rem', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 220px' }}>
              <label htmlFor="employee">Employee <span className="muted">(optional)</span></label>
              <input id="employee" type="text" value={employee} autoComplete="off"
                     placeholder="Only if the report does not name anyone"
                     onChange={e => { setEmployee(e.target.value); reset(); }} />
            </div>
            <div style={{ flex: '0 1 200px' }}>
              <label htmlFor="date">Report date <span className="muted">(optional)</span></label>
              <input id="date" type="date" value={date}
                     onChange={e => { setDate(e.target.value); reset(); }} />
            </div>
          </div>
          <div className="row" style={{ marginTop: '.9rem' }}>
            <button disabled={busy || !content.trim()}
                    onClick={async () => { setCommitted(null); setPreview(await call('/api/preview')); }}>
              {busy ? 'Working…' : 'Preview'}
            </button>
            <button className="secondary" disabled={busy || !preview || !preview.accepted.length}
                    onClick={async () => {
                      const r = await call('/api/commit');
                      if (r) { setCommitted(r); setPreview(null); }
                    }}>
              Confirm import
            </button>
          </div>
        </div>

        {error && <div className="banner bad">{error}</div>}

        {committed && (
          <div className="banner ok">
            <strong>Imported.</strong> {committed.rowsWritten} row(s) written,
            {' '}{committed.skippedIdempotent} already present,
            {' '}{committed.rejected.length} rejected.
            {' '}<Link href="/">View the dashboard</Link>
            {committed.rowsWritten === 0 && committed.skippedIdempotent > 0 && (
              <div className="small muted" style={{ marginTop: '.4rem' }}>
                Every row was already in the database, so nothing was duplicated. Importing the
                same report twice is always safe.
              </div>
            )}
          </div>
        )}

        {preview && <ResultView result={preview} />}
        {committed && <ResultView result={committed} />}
      </main>
    </>
  );
}

function ResultView({ result }: { result: Preview }) {
  return (
    <>
      <h2>What was found</h2>
      <div className="kpis">
        <div className="kpi"><div className="label">Tables</div><div className="value">{result.tablesFound}</div></div>
        <div className="kpi"><div className="label">Rows read</div><div className="value">{result.rowsExtracted}</div></div>
        <div className="kpi"><div className="label">Valid</div><div className="value">{result.accepted.length}</div></div>
        <div className="kpi"><div className="label">Already present</div><div className="value">{result.skippedIdempotent}</div></div>
        <div className="kpi"><div className="label">Rejected</div><div className="value">{result.rejected.length}</div></div>
      </div>

      {result.status === 'NO_DATA' && (
        <div className="banner warn" style={{ marginTop: '1rem' }}>{result.message}</div>
      )}

      {!!result.outsideRoster?.length && (
        <div className="banner" style={{ marginTop: '1rem' }}>
          <strong>Left out — not on the team roster:</strong>{' '}
          {result.outsideRoster.map(o => `${o.name} (${o.rows})`).join(', ')}.
          Only people on the <Link href="/roster">Team roster</Link> are imported.
          Add someone there if they should be included.
        </div>
      )}

      {result.accepted.length > 0 && (
        <>
          <h2>Rows that will be imported</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Department</th><th>Employee</th><th>Task</th>
                  <th>Category</th><th>Status</th><th className="num">Expected</th>
                  <th className="num">Actual</th><th>Duration basis</th>
                </tr>
              </thead>
              <tbody>
                {result.accepted.map(t => (
                  <tr key={t.taskId}>
                    <td>{t.date}</td>
                    <td>{t.department}</td>
                    <td>{t.employeeName}</td>
                    <td>{t.task}</td>
                    <td className="small muted">{t.taskCategory || '—'}</td>
                    <td><span className={'pill ' + (t.taskStatus === 'Completed' ? 'ok'
                      : t.taskStatus === 'Blocked' ? 'bad' : 'mute')}>{t.taskStatus}</span></td>
                    <td className="num">{t.expectedDuration ?? '—'}</td>
                    <td className="num">{t.actualDuration ?? '—'}</td>
                    <td className="small muted">{t.durationBasis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {result.rejected.length > 0 && (
        <>
          <h2>Rows that will NOT be imported</h2>
          <div className="banner warn">
            These rows are kept with their original values and a reason, so nothing is lost.
            Fix the source or the master data and re-submit — the good rows above are unaffected.
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Reason</th><th>Why</th><th>Date</th><th>Employee</th><th>Task</th><th>Status</th></tr>
              </thead>
              <tbody>
                {result.rejected.map((r, i) => (
                  <tr key={i}>
                    <td><span className="pill bad">{r.reason}</span></td>
                    <td className="small">{r.detail}</td>
                    <td className="small">{r.raw.date || '—'}</td>
                    <td className="small">{r.raw.employee || '—'}</td>
                    <td className="small">{r.raw.task || '—'}</td>
                    <td className="small">{r.raw.status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
