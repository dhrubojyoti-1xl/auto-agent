import { redirect } from 'next/navigation';
import Nav from '../nav';
import { getSession } from '@/lib/auth';
import { getLatestReport } from '@/lib/queries';
import ReportControls from './controls';
import { formatStamp } from '@/lib/format-date';

export const dynamic = 'force-dynamic';

export default async function ReportPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const latest = await getLatestReport(session.userId);
  const aiConfigured = !!process.env.ANTHROPIC_API_KEY;

  return (
    <>
      <Nav />
      <main className="shell">
        <h1>Management report</h1>
        <p className="sub">
          Every number is computed by application code. The AI, when enabled, writes commentary
          only — and anything it invents is removed before you see it.
        </p>

        <div className={'banner ' + (aiConfigured ? 'ok' : '')}>
          {aiConfigured
            ? 'AI commentary is available. Generating with AI adds interpretation; ' +
              'generating without it still produces the complete report.'
            : 'AI is not configured (no ANTHROPIC_API_KEY). Reports are generated from the ' +
              'deterministic layer — every section still works.'}
        </div>

        <ReportControls aiConfigured={aiConfigured} />

        {latest && (
          <>
            <h2>Latest report</h2>
            <div className="row small muted" style={{ marginBottom: '.6rem' }}>
              <span className="pill mute">{latest.report_type}</span>
              <span>{latest.period_start}{latest.period_end !== latest.period_start ? ` → ${latest.period_end}` : ''}</span>
              <span>generated {formatStamp(latest.generated_at)}</span>
              <span className={'pill ' + (latest.status === 'OK_AI' ? 'ok'
                : latest.status === 'OK_AI_PARTIAL' ? 'warn' : 'mute')}>{latest.status}</span>
              <span>by {latest.generator}</span>
            </div>
            {latest.validation_error && (
              <div className="banner warn">
                <strong>Claims removed by the validator:</strong> {latest.validation_error}
              </div>
            )}
            <pre className="report">{latest.human_report}</pre>
          </>
        )}
      </main>
    </>
  );
}
