/**
 * Report generation: dataset -> optional Anthropic call -> validation gate ->
 * rendered report -> archive.
 *
 * The AI never sees the database and never produces a number. If it is
 * disabled, unreachable, or returns nonsense twice, a complete report is still
 * produced from the deterministic layer and says so in its footer.
 */
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { analyze } from './core/analysis';
import {
  AI_OUTPUT_FORMAT, AI_SYSTEM_PROMPT, buildAiDataset, buildAiUserPrompt,
  parseJsonLoose, validateAiJson
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

/**
 * A stable fingerprint of everything the AI is shown.
 *
 * The commentary is a function of the dataset and nothing else, so if the
 * dataset has not changed there is no new commentary to write — only a bill to
 * pay. Pressing "Generate report" twice in a row, or opening the page again
 * after a sync that imported nothing, must not call a paid API a second time.
 * The generatedAt stamp is excluded, or every call would look different.
 */
export function datasetFingerprint(dataset: AiDataset): string {
  const { meta, ...rest } = dataset;
  const stable = { ...rest, meta: { ...meta, generatedAt: '' } };
  return createHash('sha1').update(JSON.stringify(stable)).digest('hex');
}

export async function generateReport(
  type: ReportType, ownerUserId: number, anchorDate?: string, useAi = true,
  opts: { force?: boolean } = {}
): Promise<GeneratedReport> {
  const cfg = engineConfig();
  // Plans are excluded here for the same reason they are excluded from the
  // dashboard: the management summary is about work that happened. Counting
  // tomorrow's intentions as today's output is the one error that would make
  // every figure in the report overstate the team.
  const tasks = (await loadTasks(ownerUserId)).filter(t => t.workKind !== 'PLANNED');
  const anchor = anchorDate ||
    (tasks.length ? tasks.map(t => t.date).sort().slice(-1)[0] : new Date().toISOString().slice(0, 10));
  const { start, end } = periodFor(type, anchor, cfg.weekStart);

  const analysis = analyze(tasks, cfg);
  const departments = buildDepartmentSummary(tasks, analysis, cfg);
  const employees = buildEmployeeSummary(tasks, analysis, cfg);

  const rejections = await query<{ rejection_reason: string; claimed_date: string | null; logged_at: string }>(
    `select rejection_reason, claimed_date, logged_at from data_quality
     where owner_user_id = $1`, [ownerUserId]
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

  const fingerprint = datasetFingerprint(dataset);
  const reportIdEarly = `${type}-${start}-u${ownerUserId}`;

  const key = process.env.ANTHROPIC_API_KEY;

  // Reuse the stored commentary when the underlying figures are identical.
  if (useAi && key && !opts.force) {
    const [cached] = await query<{
      ai_json: unknown; status: string; model: string | null;
      human_report: string | null; summary: string | null; validation_error: string | null;
    }>(
      `select ai_json, status, model, human_report, summary, validation_error
       from ai_reports
       where report_id = $1 and owner_user_id = $2
         and dataset_fingerprint = $3 and generator like 'ai:%'`,
      [reportIdEarly, ownerUserId, fingerprint]);
    if (cached?.ai_json) {
      const v = validateAiJson(cached.ai_json, dataset);
      return {
        reportId: reportIdEarly, reportType: type, periodStart: start, periodEnd: end,
        status: (cached.status as ReportStatus) || 'OK_AI',
        generator: 'ai:cached', model: cached.model || '',
        summary: cached.summary || v.commentary.summary,
        humanReport: cached.human_report ||
          renderReport(dataset, v.commentary, (cached.status as ReportStatus) || 'OK_AI',
                       cached.validation_error || '', cfg),
        dataset, commentary: v.commentary,
        validationError: cached.validation_error || ''
      };
    }
  }

  if (useAi && key) {
    model = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
    const client = new Anthropic({ apiKey: key });
    let lastError = '';
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        // Structured outputs, not prompt instructions. Two earlier attempts
        // failed against this model family and both are documented API
        // changes rather than bugs in the prompt:
        //   temperature      -> removed, returns 400
        //   assistant prefill -> removed, returns 400
        // output_config.format constrains the response to the schema at the
        // API level, so "Response was not valid JSON" cannot recur.
        const res = await client.messages.create({
          model,
          // Generous, because a truncated response is unparseable JSON. The
          // earlier 2000 cap truncated mid-object.
          max_tokens: 8000,
          system: AI_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildAiUserPrompt(dataset) }],
          output_config: { format: AI_OUTPUT_FORMAT }
        } as Parameters<typeof client.messages.create>[0]) as unknown as {
          content: { type: string; text?: string }[];
          stop_reason?: string;
        };

        const text = res.content
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join('\n');
        const parsed = parseJsonLoose(text);
        if (!parsed) {
          lastError = `Response was not valid JSON (stop_reason=${res.stop_reason}, ` +
                      `${text.length} chars)`;
          continue;
        }
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
  const reportId = reportIdEarly;
  const summary = commentary?.summary || humanReport.split('\n\n')[2] || '';

  await query(
    `insert into ai_reports (report_id, report_type, period_start, period_end,
       generator, model, status, summary, human_report, dataset_json, ai_json,
       validation_error, owner_user_id, dataset_fingerprint)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (report_id) do update set
       generated_at = now(), generator = excluded.generator, model = excluded.model,
       status = excluded.status, summary = excluded.summary,
       human_report = excluded.human_report, dataset_json = excluded.dataset_json,
       ai_json = excluded.ai_json, validation_error = excluded.validation_error,
       dataset_fingerprint = excluded.dataset_fingerprint`,
    [reportId, type, start, end, generator, model || null, status, summary.slice(0, 4000),
     humanReport, JSON.stringify(dataset), commentary ? JSON.stringify(commentary) : null,
     validationError || null, ownerUserId, fingerprint]
  );

  return {
    reportId, reportType: type, periodStart: start, periodEnd: end,
    status, generator, model, summary, humanReport, validationError, dataset, commentary
  };
}
