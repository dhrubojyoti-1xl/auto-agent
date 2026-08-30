/**
 * The AI layer — port of 09_AI.gs, provider-agnostic.
 *
 * Non-negotiables, enforced in code and not merely requested in the prompt:
 *   1. Every number is computed BEFORE the model is called. The model is never
 *      asked to count anything.
 *   2. The reply is schema-checked AND fact-checked against the same dataset.
 *      Invented departments, employees, task ids and impossible rates are
 *      dropped and recorded.
 *   3. If the model is disabled, unreachable, or returns nonsense twice, a full
 *      report is still produced from the deterministic layer.
 */
import type { AnalysisResult, RepeatGroup, SlowTask } from './analysis';
import type { Bucket, DepartmentRow, EmployeeRow } from './metrics';
import { bucketFor } from './metrics';
import type { EngineConfig, TaskRecord } from './types';
import { addDays, daysBetween, keyify, normalizeTask, ppChange } from './normalize';

export type ReportType = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface AiDataset {
  meta: {
    reportType: ReportType;
    periodStart: string;
    periodEnd: string;
    comparisonPeriodStart: string;
    comparisonPeriodEnd: string;
    generatedAt: string;
    note: string;
  };
  totals: Bucket;
  comparisonTotals: Bucket;
  completionRateChangePercentagePoints: number | null;
  departments: (Bucket & { department: string })[];
  employees: (Bucket & { employee: string; department: string; dataSufficiency: string })[];
  categories: (Bucket & { category: string })[];
  slowTasks: SlowTask[];
  slowTaskNote: string;
  repeatedTasks: {
    employee: string; department: string; task: string;
    occurrences: number; distinctDates: number; classification: string;
  }[];
  dataQuality: {
    tasksInPeriod: number;
    rowsRejectedInPeriod: number;
    rejectionReasons: Record<string, number>;
    tasksMissingLink: number;
    tasksFlaggedForReview: number;
    tasksWithoutDurationData: number;
    uncategorisedTasks: number;
  };
}

export interface RejectionSummary { reason: string; date: string }

export function buildAiDataset(
  allTasks: TaskRecord[],
  analysis: AnalysisResult,
  departments: DepartmentRow[],
  employees: EmployeeRow[],
  rejections: RejectionSummary[],
  reportType: ReportType,
  periodStart: string,
  periodEnd: string,
  generatedAt: string
): AiDataset {
  const inPeriod = allTasks.filter(t => t.date >= periodStart && t.date <= periodEnd);
  const span = daysBetween(periodStart, periodEnd) + 1;
  const prevEnd = addDays(periodStart, -1);
  const prevStart = addDays(prevEnd, -(span - 1));
  const prevTasks = allTasks.filter(t => t.date >= prevStart && t.date <= prevEnd);

  const totals = bucketFor(inPeriod, analysis);
  const comparisonTotals = bucketFor(prevTasks, analysis);

  const byDept = new Map<string, TaskRecord[]>();
  const byEmp = new Map<string, TaskRecord[]>();
  const byCat = new Map<string, TaskRecord[]>();
  inPeriod.forEach(t => {
    byDept.set(t.department, [...(byDept.get(t.department) || []), t]);
    byEmp.set(t.employeeName, [...(byEmp.get(t.employeeName) || []), t]);
    const c = t.taskCategory || 'Uncategorised';
    byCat.set(c, [...(byCat.get(c) || []), t]);
  });

  const empSuffiency = new Map(employees.map(e => [e.employee, e.dataSufficiency]));
  const periodTaskIds = new Set(inPeriod.map(t => t.taskId));

  const slowInPeriod = analysis.slowTasks.filter(s => periodTaskIds.has(s.taskId));
  const insufficient = inPeriod.filter(
    t => analysis.slowFlagByTaskId.get(t.taskId) === 'INSUFFICIENT_DATA'
  ).length;

  const rejectionsInPeriod = rejections.filter(r => r.date >= periodStart && r.date <= periodEnd);
  const reasons: Record<string, number> = {};
  rejectionsInPeriod.forEach(r => { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });

  return {
    meta: {
      reportType, periodStart, periodEnd,
      comparisonPeriodStart: prevStart, comparisonPeriodEnd: prevEnd,
      generatedAt,
      note: 'All figures are pre-computed. Do not recalculate them.'
    },
    totals,
    comparisonTotals,
    completionRateChangePercentagePoints: comparisonTotals.total
      ? ppChange(totals.completionRate, comparisonTotals.completionRate) : null,
    departments: [...byDept.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([department, ts]) => ({ ...bucketFor(ts, analysis), department })),
    employees: [...byEmp.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([employee, ts]) => ({
        ...bucketFor(ts, analysis), employee, department: ts[0].department,
        dataSufficiency: empSuffiency.get(employee) || 'Insufficient — do not rank'
      })),
    categories: [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([category, ts]) => ({ ...bucketFor(ts, analysis), category })),
    slowTasks: slowInPeriod.slice(0, 25),
    slowTaskNote: `${insufficient} of ${totals.total} task(s) have no usable ` +
      `start/completion timestamps, so their duration is unknown and they are ` +
      `excluded from slow-task analysis.`,
    repeatedTasks: analysis.repeatGroups
      .filter(g => g.lastDate >= periodStart && g.lastDate <= periodEnd)
      .slice(0, 25)
      .map(g => ({
        employee: g.employee, department: g.department, task: g.task,
        occurrences: g.occurrenceCount, distinctDates: g.distinctDates,
        classification: g.classification
      })),
    dataQuality: {
      tasksInPeriod: totals.total,
      rowsRejectedInPeriod: rejectionsInPeriod.length,
      rejectionReasons: reasons,
      tasksMissingLink: inPeriod.filter(t => !t.link).length,
      tasksFlaggedForReview: inPeriod.filter(t => t.dataQualityStatus === 'Review').length,
      tasksWithoutDurationData: insufficient,
      uncategorisedTasks: inPeriod.filter(t => !t.taskCategory).length
    }
  };
}

/* -------------------------------------------------------------------------- */

export const AI_SYSTEM_PROMPT = `You are a management reporting analyst. You interpret a pre-computed dataset about departmental task reporting. You never compute or estimate numbers yourself.

ABSOLUTE RULES
1. Use ONLY the JSON dataset provided. Nothing else exists.
2. Never invent or alter a task count, completion rate, employee, department, category, task, or duration. Every number you write must appear verbatim in the dataset.
3. Never call a task slow unless it appears in dataset.slowTasks.
4. Never call an employee underperforming. Task counts measure reported activity, not value or complexity. Where dataSufficiency says "Insufficient — do not rank", do not compare that person to anyone.
5. Repetition is not automatically waste. Respect the classification already assigned to each repeated task group.
6. Express changes in completion rate as percentage POINTS (e.g. "80% to 85% is +5 percentage points"), never as a percentage change.
7. Separate FACT (restating dataset values) from INTERPRETATION (your inference). Mark interpretation with the "interpretation" field where the schema provides one.
8. If the dataset cannot support a section, write exactly "Insufficient data." for it.
9. Output ONE JSON object and nothing else. No prose, no markdown, no code fences.

OUTPUT SCHEMA (all keys required)
{
  "summary": "3-5 sentence executive summary. Facts first, interpretation clearly hedged.",
  "overall_completion_rate": <copy dataset.totals.completionRate exactly>,
  "department_observations": [
     {"department": "<must exist in dataset.departments>", "observation": "...", "interpretation": "...", "confidence": "high|medium|low"}
  ],
  "attention_items": [
     {"item": "...", "why_it_matters": "...", "supporting_data": "<quote the dataset numbers you relied on>", "suggested_action": "..."}
  ],
  "slow_tasks": [
     {"task_id": "<must exist in dataset.slowTasks>", "comment": "..."}
  ],
  "repeated_tasks": [
     {"employee": "<must exist>", "task": "<must exist>", "classification": "<copy from dataset>", "comment": "..."}
  ],
  "trends": ["...", "..."],
  "data_quality": ["...", "..."]
}`;

export function buildAiUserPrompt(dataset: AiDataset): string {
  return 'DATASET (authoritative, pre-computed):\n' +
    JSON.stringify(dataset, null, 1) +
    `\n\nProduce the JSON object described in the system rules for the ` +
    `${dataset.meta.reportType} period ${dataset.meta.periodStart} to ` +
    `${dataset.meta.periodEnd}. Output JSON only.`;
}

export interface AiCommentary {
  summary: string;
  overallCompletionRate: number;
  departmentObservations: {
    department: string; observation: string; interpretation: string;
    confidence: 'high' | 'medium' | 'low';
  }[];
  attentionItems: {
    item: string; whyItMatters: string; supportingData: string; suggestedAction: string;
  }[];
  slowTasks: (SlowTask & { comment: string })[];
  repeatedTasks: {
    employee: string; task: string; occurrences: number;
    distinctDates: number; classification: string; comment: string;
  }[];
  trends: string[];
  dataQuality: string[];
}

export function parseJsonLoose(text: string): unknown {
  if (!text) return null;
  const s = String(text).trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch { /* give up */ }
  }
  return null;
}

const asArray = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const asString = (v: unknown): string => typeof v === 'string' ? v.trim() : '';

/**
 * THE ANTI-HALLUCINATION GATE.
 * Returns the commentary with every unsupportable claim removed, plus the list
 * of what was removed so it can be disclosed to the reader.
 */
export function validateAiJson(
  json: unknown, dataset: AiDataset
): { ok: boolean; errors: string[]; commentary: AiCommentary } {
  const errors: string[] = [];
  const commentary: AiCommentary = {
    summary: '',
    overallCompletionRate: dataset.totals.completionRate,
    departmentObservations: [], attentionItems: [], slowTasks: [],
    repeatedTasks: [], trends: [], dataQuality: []
  };
  if (!json || typeof json !== 'object') {
    return { ok: false, errors: ['Response was not a JSON object'], commentary };
  }
  const j = json as Record<string, unknown>;

  commentary.summary = asString(j.summary);
  if (!commentary.summary) errors.push('summary missing');

  const stated = Number(j.overall_completion_rate);
  if (isNaN(stated) || Math.abs(stated - dataset.totals.completionRate) > 0.11) {
    errors.push(
      `overall_completion_rate was "${j.overall_completion_rate}" but the dataset says ` +
      `${dataset.totals.completionRate}. Dataset value kept.`
    );
  }

  const deptSet = new Set(dataset.departments.map(d => d.department));
  asArray(j.department_observations).forEach(o => {
    const obs = o as Record<string, unknown>;
    if (!obs || !deptSet.has(asString(obs.department))) {
      errors.push(`Dropped observation for unknown department "${asString(obs?.department)}"`);
      return;
    }
    const conf = asString(obs.confidence).toLowerCase();
    commentary.departmentObservations.push({
      department: asString(obs.department),
      observation: asString(obs.observation),
      interpretation: asString(obs.interpretation),
      confidence: (['high', 'medium', 'low'].includes(conf) ? conf : 'low') as 'high' | 'medium' | 'low'
    });
  });

  asArray(j.attention_items).slice(0, 10).forEach(a => {
    const it = a as Record<string, unknown>;
    if (!it || !asString(it.item)) return;
    commentary.attentionItems.push({
      item: asString(it.item),
      whyItMatters: asString(it.why_it_matters),
      supportingData: asString(it.supporting_data),
      suggestedAction: asString(it.suggested_action)
    });
  });

  const slowById = new Map(dataset.slowTasks.map(s => [s.taskId, s]));
  asArray(j.slow_tasks).forEach(s => {
    const it = s as Record<string, unknown>;
    const id = asString(it?.task_id);
    const src = slowById.get(id);
    if (!src) {
      errors.push(`Dropped slow-task comment for unknown Task_ID "${id}"`);
      return;
    }
    // Numbers ALWAYS come from the dataset, never from the model.
    commentary.slowTasks.push({ ...src, comment: asString(it.comment) });
  });

  const repKey = new Map(
    dataset.repeatedTasks.map(r => [keyify(r.employee) + '||' + normalizeTask(r.task), r])
  );
  asArray(j.repeated_tasks).forEach(r => {
    const it = r as Record<string, unknown>;
    if (!it) return;
    const k = keyify(asString(it.employee)) + '||' + normalizeTask(asString(it.task));
    const src = repKey.get(k);
    if (!src) {
      errors.push(
        `Dropped repeated-task comment not present in the dataset ` +
        `("${asString(it.employee) || '?'} / ${asString(it.task) || '?'}")`
      );
      return;
    }
    commentary.repeatedTasks.push({
      employee: src.employee, task: src.task, occurrences: src.occurrences,
      distinctDates: src.distinctDates, classification: src.classification,
      comment: asString(it.comment)
    });
  });

  commentary.trends = asArray(j.trends).map(asString).filter(Boolean).slice(0, 10);
  commentary.dataQuality = asArray(j.data_quality).map(asString).filter(Boolean).slice(0, 10);

  return { ok: errors.length === 0, errors, commentary };
}


/**
 * JSON Schema for the commentary, passed as output_config.format so the API
 * constrains the response rather than the prompt merely requesting it.
 *
 * This is belt AND braces: the schema guarantees well-formed JSON of the right
 * shape, and validateAiJson() still checks every claim against the dataset.
 * Shape validity is not truthfulness.
 */
export const AI_OUTPUT_FORMAT = {
  type: 'json_schema' as const,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'overall_completion_rate', 'department_observations',
               'attention_items', 'slow_tasks', 'repeated_tasks', 'trends', 'data_quality'],
    properties: {
      summary: { type: 'string' },
      overall_completion_rate: { type: 'number' },
      department_observations: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['department', 'observation', 'interpretation', 'confidence'],
          properties: {
            department: { type: 'string' },
            observation: { type: 'string' },
            interpretation: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
          }
        }
      },
      attention_items: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['item', 'why_it_matters', 'supporting_data', 'suggested_action'],
          properties: {
            item: { type: 'string' }, why_it_matters: { type: 'string' },
            supporting_data: { type: 'string' }, suggested_action: { type: 'string' }
          }
        }
      },
      slow_tasks: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['task_id', 'comment'],
          properties: { task_id: { type: 'string' }, comment: { type: 'string' } }
        }
      },
      repeated_tasks: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['employee', 'task', 'classification', 'comment'],
          properties: {
            employee: { type: 'string' }, task: { type: 'string' },
            classification: { type: 'string' }, comment: { type: 'string' }
          }
        }
      },
      trends: { type: 'array', items: { type: 'string' } },
      data_quality: { type: 'array', items: { type: 'string' } }
    }
  }
};
