import Nav from '../nav';
import { getDocuments, getRejections } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function QualityPage() {
  const [rejections, documents] = await Promise.all([getRejections(), getDocuments(30)]);
  const byReason = rejections.reduce<Record<string, number>>((acc, r) => {
    acc[r.reason] = (acc[r.reason] || 0) + 1; return acc;
  }, {});

  return (
    <>
      <Nav />
      <main className="shell">
        <h1>Data quality</h1>
        <p className="sub">
          Every row that did not become a task is here, with its original values and an
          actionable reason. Nothing is ever silently dropped.
        </p>

        {Object.keys(byReason).length > 0 && (
          <div className="kpis">
            {Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([reason, n]) => (
              <div className="kpi" key={reason}>
                <div className="label">{reason.replace(/_/g, ' ').toLowerCase()}</div>
                <div className="value">{n}</div>
              </div>
            ))}
          </div>
        )}

        <h2>Rejected rows</h2>
        {rejections.length === 0 ? (
          <div className="card">No rejected rows. Every row imported cleanly.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Logged</th><th>Reason</th><th>Why, and how to fix it</th>
                  <th>Date</th><th>Employee</th><th>Task</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rejections.map(r => (
                  <tr key={r.id}>
                    <td className="small">{String(r.loggedAt).slice(0, 16).replace('T', ' ')}</td>
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
        )}

        <h2>Import history</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Processed</th><th>Source</th><th>Subject</th><th>Department</th>
                <th>Status</th><th className="num">Extracted</th><th className="num">Imported</th>
                <th className="num">Already present</th><th className="num">Rejected</th>
              </tr>
            </thead>
            <tbody>
              {documents.map(d => (
                <tr key={d.reportId}>
                  <td className="small">{String(d.processedAt).slice(0, 16).replace('T', ' ')}</td>
                  <td className="small">{d.source}</td>
                  <td className="small">{d.subject}</td>
                  <td className="small">{d.department || '—'}</td>
                  <td>
                    <span className={'pill ' + (
                      d.status === 'SUCCESS' ? 'ok' : d.status === 'PARTIAL' ? 'warn' : 'mute')}>
                      {d.status}
                    </span>
                  </td>
                  <td className="num">{d.extracted}</td>
                  <td className="num">{d.inserted}</td>
                  <td className="num">{d.skipped}</td>
                  <td className="num">{d.rejected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
