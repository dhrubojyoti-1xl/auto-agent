/**
 * The AI writes commentary; the application computes every number. This suite
 * attacks that boundary with output a model plausibly produces — invented
 * percentages, departments that do not exist, tasks nobody reported — and
 * checks that none of it reaches the manager.
 *
 * The structured fields were already guarded field by field. Prose was not,
 * and prose is where an invented figure survives unchallenged: "Sales completed
 * 92% of its tasks" is attached to no field any schema constrains.
 */
import { describe, expect, it } from 'vitest';
import { buildAiDataset, ungroundedNumbers, validateAiJson } from '../src/lib/core/ai';
import { analyze } from '../src/lib/core/analysis';
import { buildDepartmentSummary, buildEmployeeSummary } from '../src/lib/core/metrics';
import { engineConfig } from '../src/lib/pipeline';
import type { TaskRecord } from '../src/lib/core/types';

const CFG = engineConfig();

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    taskId: 'T', reportId: 'R', date: '2026-08-12', department: 'Sales',
    employeeName: 'Rahul Mehta', employeeId: 'E1', task: 'Client call',
    taskNormalized: 'client call', taskCategory: 'Client Work',
    taskStatus: 'Completed', priority: '', startDate: null, startTime: null,
    completionDate: null, completionTime: null, expectedDuration: null,
    actualDuration: null, durationBasis: 'Insufficient Data', link: '',
    sourceDocumentId: 'D', sourceDocumentDate: '2026-08-12T00:00:00.000Z',
    dataQualityStatus: 'OK', dataQualityNotes: '', taskFingerprint: 'f',
    notes: '', ...over
  } as TaskRecord;
}

// Four Sales tasks, three completed: a completion rate of exactly 75.
const TASKS: TaskRecord[] = [
  task({ taskId: 'T1', taskFingerprint: 'f1' }),
  task({ taskId: 'T2', taskFingerprint: 'f2' }),
  task({ taskId: 'T3', taskFingerprint: 'f3' }),
  task({ taskId: 'T4', taskFingerprint: 'f4', taskStatus: 'Pending' })
];

const analysis = analyze(TASKS, CFG);
const DATASET = buildAiDataset(
  TASKS, analysis,
  buildDepartmentSummary(TASKS, analysis, CFG),
  buildEmployeeSummary(TASKS, analysis, CFG),
  [], 'DAILY', '2026-08-12', '2026-08-12', '2026-08-12T09:00:00.000Z'
);

const base = {
  summary: 'Sales reported four tasks and completed three.',
  overall_completion_rate: DATASET.totals.completionRate,
  department_observations: [], attention_items: [],
  slow_tasks: [], repeated_tasks: [], trends: [], data_quality: []
};

describe('the dataset is what it claims to be', () => {
  it('computes the completion rate the tests reason about', () => {
    expect(DATASET.totals.total).toBe(4);
    expect(DATASET.totals.completed).toBe(3);
    expect(DATASET.totals.completionRate).toBe(75);
  });
});

describe('numbers invented in prose are removed', () => {
  it('drops a summary citing a percentage nobody computed', () => {
    const out = validateAiJson({ ...base, summary: 'Sales completed 92% of its tasks.' }, DATASET);
    expect(out.ok).toBe(false);
    expect(out.commentary.summary).toBe('');
    expect(out.errors.join(' ')).toMatch(/92/);
  });

  it('keeps a summary whose numbers all come from the dataset', () => {
    const out = validateAiJson(
      { ...base, summary: 'Completion stands at 75%, with 4 tasks reported.' }, DATASET);
    expect(out.commentary.summary).toContain('75%');
    expect(out.errors.filter(e => /does not contain/.test(e))).toHaveLength(0);
  });

  it('drops an invented figure from a trend line but keeps the honest one', () => {
    const out = validateAiJson({
      ...base,
      trends: ['Completion improved to 75%.', 'Throughput rose 340% week on week.']
    }, DATASET);
    expect(out.commentary.trends).toEqual(['Completion improved to 75%.']);
  });

  it('drops an attention item built on a fabricated count', () => {
    const out = validateAiJson({
      ...base,
      attention_items: [{ item: 'There are 87 blocked tasks in Sales.',
                          why_it_matters: 'x', supporting_data: 'y', suggested_action: 'z' }]
    }, DATASET);
    expect(out.commentary.attentionItems).toHaveLength(0);
  });

  it('does not flag ordinary counting words or years as fabrications', () => {
    const grounded = new Set(['75', '4', '3']);
    expect(ungroundedNumbers('Over the last 3 days, 4 tasks in 2026.', grounded)).toEqual([]);
  });

  it('flags a percentage that resembles, but is not, a computed value', () => {
    expect(ungroundedNumbers('Completion is 76%.', new Set(['75']))).toEqual(['76%']);
  });
});

describe('entities invented by the model are removed', () => {
  it('drops an observation about a department that does not exist', () => {
    const out = validateAiJson({
      ...base,
      department_observations: [
        { department: 'Legal', observation: 'Legal is behind.',
          interpretation: 'x', confidence: 'high' },
        { department: 'Sales', observation: 'Sales is steady.',
          interpretation: 'y', confidence: 'high' }
      ]
    }, DATASET);
    expect(out.commentary.departmentObservations.map(o => o.department)).toEqual(['Sales']);
    expect(out.errors.join(' ')).toMatch(/Legal/);
  });

  it('drops a slow-task comment about a task id that was never flagged', () => {
    const out = validateAiJson(
      { ...base, slow_tasks: [{ task_id: 'NOT-A-TASK', comment: 'This ran long.' }] }, DATASET);
    expect(out.commentary.slowTasks).toHaveLength(0);
    expect(out.errors.join(' ')).toMatch(/NOT-A-TASK/);
  });

  it('drops a repeated-task comment about work nobody reported', () => {
    const out = validateAiJson({
      ...base,
      repeated_tasks: [{ employee: 'Nobody At All', task: 'Invented work', comment: 'c' }]
    }, DATASET);
    expect(out.commentary.repeatedTasks).toHaveLength(0);
  });
});

describe('the completion rate on screen is always the computed one', () => {
  it('overrides a model that states a different rate', () => {
    const out = validateAiJson({ ...base, overall_completion_rate: 99 }, DATASET);
    expect(out.commentary.overallCompletionRate).toBe(75);
    expect(out.ok).toBe(false);
  });

  it('rejects a response that is not an object at all', () => {
    expect(validateAiJson('sorry, I cannot help with that', DATASET).ok).toBe(false);
    expect(validateAiJson(null, DATASET).ok).toBe(false);
  });
});
