/**
 * Report generation: dataset -> optional Anthropic call -> validation gate ->
 * rendered report -> archive.
 *
 * The AI never sees the database and never produces a number. If it is
 * disabled, unreachable, or returns nonsense twice, a complete report is still
 * produced from the deterministic layer and says so in its footer.
 */
import Anthropic from '@anthropic-ai/sdk';
import { analyze } from './core/analysis';
import {
  AI_SYSTEM_PROMPT, buildAiDataset, buildAiUserPrompt, parseJsonLoose, validateAiJson
} from './core/ai';
import type { AiCommentary, AiDataset, ReportType } from './core/ai';
import { buildDepartmentSummary, buildEmployeeSummary } from './core/metrics';
import { addDays, monthStartOf, weekStartOf } from './core/normalize';
import type { ReportStatus } from './core/report';
import { renderReport } from './core/report';
import { loadTasks, query } from './db';
import { engineConfig } from './pipeline';

export interface GeneratedReport {
  reportId: string;
  reportType: ReportType;
  periodStart: string;
  periodEnd: string;
  status: ReportStatus;
  generator: string;
  model: string;
  summary: string;
  humanReport: string;
  validationError: string;
  dataset: AiDataset;
  commentary: AiCommentary | null;
}

export function periodFor(type: ReportType, anchor: string, weekStart: 'MONDAY' | 'SUNDAY') {
  if (type === 'DAILY') return { start: anchor, end: anchor };
  if (type === 'WEEKLY') {
    const s = weekStartOf(anchor, weekStart);
    return { start: s, end: addDays(s, 6) };
  }
  const s = monthStartOf(anchor);
  const [y, m] = s.split('-').map(Number);
  return { start: s, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

export async function generateReport(
  type: ReportType, anchorDate?: string, useAi = true
): Promise<GeneratedReport> {
  const cfg = engineConfig();
  const tasks = await loadTasks();
  const anchor = anchorDate ||
    (tasks.length ? tasks.map(t => t.date).sort().slice(-1)[0] : new Date().toISOString().slice(0, 10));
  const { start, end } = periodFor(type, anchor, cfg.weekStart);

  const analysis = analyze(tasks, cfg);
  const departments = buildDepartmentSummary(tasks, analysis, cfg);
  const employees = buildEmployeeSummary(tasks, analysis, cfg);

  const rejections = await query<{ rejection_reason: string; claimed_date: string | null; logged_at: string }>(
    'select rejection_reason, claimed_date, logged_at from data_quality'
  );

  const dataset = buildAiDataset(
    tasks, analysis, departments, employees,
    rejections.map(r => ({
      reason: r.rejection_reason,
      date: r.claimed_date || String(r.logged_at).slice(0, 10)
    })),
    type, start, end, new Date().toISOString().slice(0, 16).replace('T', ' ')
  );

  let commentary: AiCommentary | null = null;
  let status: ReportStatus = 'OK_NO_AI';
  let validationError = '';
  let generator = 'deterministic';
  let model = '';

  const key = process.env.ANTHROPIC_API_KEY;
  if (useAi && key) {
    model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
    const client = new Anthropic({ apiKey: key });
    let lastError = '';
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const res = await client.messages.create({
          model,
          max_tokens: 2000,
          temperature: 0.2,
          system: AI_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildAiUserPrompt(dataset) }]
        });
        const text = res.content
          .filter(b => b.type === 'text')
          .map(b => (b as { text: string }).text)
          .join('\n');
        const parsed = parseJsonLoose(text);
        if (!parsed) { lastError = 'Response was not valid JSON'; continue; }
        const v = validateAiJson(parsed, dataset);
        commentary = v.commentary;
        validationError = v.errors.join(' | ');
        generator = 'ai:anthropic';
        status = v.ok ? 'OK_AI' : 'OK_AI_PARTIAL';
        break;
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    if (!commentary) {
      status = 'OK_AI_UNAVAILABLE';
      validationError = 'AI unavailable: ' + lastError;
    }
  }

  const humanReport = renderReport(dataset, commentary, status, validationError, cfg);
  const reportId = `${type}-${start}`;
  const summary = commentary?.summary || humanReport.split('\n\n')[2] || '';

  await query(
    `insert into ai_reports (report_id, report_type, period_start, period_end,
       generator, model, status, summary, human_report, dataset_json, ai_json, validation_error)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (report_id) do update set
       generated_at = now(), generator = excluded.generator, model = excluded.model,
       status = excluded.status, summary = excluded.summary,
       human_report = excluded.human_report, dataset_json = excluded.dataset_json,
       ai_json = excluded.ai_json, validation_error = excluded.validation_error`,
    [reportId, type, start, end, generator, model || null, status, summary.slice(0, 4000),
     humanReport, JSON.stringify(dataset), commentary ? JSON.stringify(commentary) : null,
     validationError || null]
  );

  return {
    reportId, reportType: type, periodStart: start, periodEnd: end,
    status, generator, model, summary, humanReport, validationError, dataset, commentary
  };
}
