/**
 * Repeat-similarity and slow-task baselines — the two areas where the
 * management brief asks for judgement, and where being wrong in either
 * direction misrepresents someone's work.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRepeatedTasks, analyzeSlowTasks } from '../src/lib/core/analysis';
import { normalizeTask, stemToken, taskTokens, tasksAreSimilar } from '../src/lib/core/normalize';
import { DEFAULT_ENGINE_CONFIG as CFG } from '../src/lib/core/types';
import type { TaskRecord } from '../src/lib/core/types';

let n = 0;
function mk(over: Partial<TaskRecord> = {}): TaskRecord {
  n++;
  return {
    taskId: 'T' + n, reportId: 'R', date: '2026-08-10', department: 'Ops',
    employeeName: 'John Smith', employeeId: 'e', task: 'Task', taskNormalized: 'task',
    taskCategory: '', taskStatus: 'Completed', priority: '',
    startDate: null, startTime: null, completionDate: null, completionTime: null,
    expectedDuration: null, actualDuration: null, durationBasis: 'Insufficient Data',
    link: '', sourceDocumentId: 'd', sourceDocumentDate: '', dataQualityStatus: 'OK',
    dataQualityNotes: '', taskFingerprint: 'fp' + n, notes: '', ...over
  };
}

describe('stemming', () => {
  it('folds the inflections that appear in real task text', () => {
    const pairs: [string, string][] = [
      ['update', 'updating'], ['update', 'updated'], ['update', 'updates'],
      ['report', 'reports'], ['report', 'reporting'], ['call', 'calls'],
      ['plan', 'planned'], ['prepare', 'preparing'], ['dispatch', 'dispatched']
    ];
    pairs.forEach(([a, b]) => expect(stemToken(a), `${a} vs ${b}`).toBe(stemToken(b)));
  });

  it('does not collapse genuinely different words', () => {
    expect(stemToken('update')).not.toBe(stemToken('upload'));
    expect(stemToken('report')).not.toBe(stemToken('reset'));
    expect(stemToken('call')).not.toBe(stemToken('cancel'));
  });
});

describe('repeat similarity — the brief\'s own example', () => {
  const base = taskTokens(normalizeTask('Update website'));
  const similar = (s: string) => tasksAreSimilar(base, taskTokens(normalizeTask(s)), CFG.similarityThreshold);

  it('recognises the same work described differently', () => {
    ['Update website', 'Website update', 'Update website content',
     'Updating the website', 'Updated website', 'Updates to website']
      .forEach(v => expect(similar(v), v).toBe(true));
  });

  it('keeps genuinely different work apart', () => {
    ['Update CRM', 'Update pricing sheet', 'Client call', 'Prepare daily report',
     'Delete website backup', 'Website security audit and penetration test']
      .forEach(v => expect(similar(v), v).toBe(false));
  });

  it('a one-word task does not swallow everything containing it', () => {
    const reporting = taskTokens(normalizeTask('Reporting'));
    expect(tasksAreSimilar(reporting, taskTokens(normalizeTask('Reporting bug in payroll')),
      CFG.similarityThreshold)).toBe(false);
  });

  it('groups the variants into ONE repeat group across days', () => {
    const tasks = [
      mk({ date: '2026-08-10', task: 'Update website', taskNormalized: normalizeTask('Update website') }),
      mk({ date: '2026-08-11', task: 'Website update', taskNormalized: normalizeTask('Website update') }),
      mk({ date: '2026-08-12', task: 'Updating the website', taskNormalized: normalizeTask('Updating the website') }),
      mk({ date: '2026-08-13', task: 'Update website content', taskNormalized: normalizeTask('Update website content') })
    ];
    const out = analyzeRepeatedTasks(tasks, CFG);
    expect(out.groups.length).toBe(1);
    expect(out.groups[0].occurrenceCount).toBe(4);
    expect(out.groups[0].distinctDates).toBe(4);
    expect(out.groups[0].classification).toBe('Recurring / Legitimate');
  });

  it('different work stays in separate groups', () => {
    const tasks = [
      mk({ date: '2026-08-10', task: 'Update website', taskNormalized: normalizeTask('Update website') }),
      mk({ date: '2026-08-11', task: 'Update website', taskNormalized: normalizeTask('Update website') }),
      mk({ date: '2026-08-10', task: 'Update CRM', taskNormalized: normalizeTask('Update CRM') }),
      mk({ date: '2026-08-11', task: 'Update CRM', taskNormalized: normalizeTask('Update CRM') })
    ];
    expect(analyzeRepeatedTasks(tasks, CFG).groups.length).toBe(2);
  });
});

describe('slow-task baselines learned from history', () => {
  const history = (hours: number[], task = 'Process orders', dept = 'Ops', cat = 'Order Processing') =>
    hours.map(h => mk({ task, taskNormalized: normalizeTask(task), department: dept,
                        taskCategory: cat, actualDuration: h, durationBasis: 'Derived' }));

  it('flags an outlier against the median of the same task, with no configuration', () => {
    const out = analyzeSlowTasks(history([1.0, 1.1, 0.9, 1.0, 5.0]), CFG);
    expect(out.slowTasks.length).toBe(1);
    const s = out.slowTasks[0];
    expect(s.actualDuration).toBe(5);
    expect(s.expectedDuration).toBe(1);
    expect(s.baselineSource).toBe('task history');
    // Five observations exist, but the task being judged is not counted among
    // the comparisons it is judged against.
    expect(s.baselineSampleSize).toBe(4);
    expect(s.reason).toMatch(/median/);
  });

  it('does not let a slow run pad the baseline it is measured against', () => {
    // Three normal runs and two identical slow ones. Counting a slow task's
    // own duration would pull the median up towards it; excluding just that
    // one instance leaves the other slow run in the sample, where it belongs.
    const out = analyzeSlowTasks(history([1, 1, 1, 6, 6]), CFG);
    expect(out.slowTasks.length).toBe(2);
    for (const s of out.slowTasks) {
      expect(s.expectedDuration).toBe(1);
      expect(s.baselineSampleSize).toBe(4);
    }
  });

  it('uses a median, so one outlier cannot redefine normal', () => {
    // A mean of [1,1,1,1,20] is 4.8 and would hide the outlier entirely.
    const out = analyzeSlowTasks(history([1, 1, 1, 1, 20]), CFG);
    expect(out.slowTasks[0].expectedDuration).toBe(1);
    expect(out.slowTasks.length).toBe(1);
  });

  it('a configured expectation outranks learned history', () => {
    const tasks = history([1, 1, 1, 1]);
    tasks.push(mk({ task: 'Process orders', taskNormalized: normalizeTask('Process orders'),
                    department: 'Ops', taskCategory: 'Order Processing',
                    actualDuration: 2.5, expectedDuration: 4, durationBasis: 'Derived' }));
    const out = analyzeSlowTasks(tasks, CFG);
    // 2.5h is under the configured 4h, so not slow — even though it is well
    // above the 1h historical median.
    expect(out.slowTasks.find(s => s.actualDuration === 2.5)).toBeUndefined();
  });

  it('refuses to judge without enough comparable observations', () => {
    const out = analyzeSlowTasks(history([1, 9]), CFG);   // only 2 observations
    expect(out.slowTasks.length).toBe(0);
    expect(out.insufficientCount).toBe(2);
  });

  it('never invents a duration that was not reported', () => {
    const out = analyzeSlowTasks([...history([1, 1, 1, 1]), mk({ actualDuration: null })], CFG);
    const noTiming = out.flagByTaskId.get('T' + n);
    expect(noTiming).toBe('INSUFFICIENT_DATA');
  });

  it('falls back through category then department history', () => {
    const tasks = [
      ...history([1, 1, 1], 'Alpha task'),
      mk({ task: 'Beta task', taskNormalized: normalizeTask('Beta task'),
           department: 'Ops', taskCategory: 'Order Processing',
           actualDuration: 6, durationBasis: 'Derived' })
    ];
    const out = analyzeSlowTasks(tasks, CFG);
    const beta = out.slowTasks.find(s => s.task === 'Beta task');
    expect(beta).toBeTruthy();
    expect(['category history', 'department history']).toContain(beta!.baselineSource);
  });
});
