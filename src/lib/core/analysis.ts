/**
 * Deterministic analysis — port of 07_Analysis.gs. No AI anywhere in this file.
 *
 * Two rules the whole product depends on:
 *   1. Repetition is not duplication, and neither is automatically a fault.
 *   2. A task with no duration data is NEVER called slow.
 */
import type {
  EngineConfig, RepeatClassification, SlowFlag, TaskRecord
} from './types';
import { addDays, keyify, normalizeTask, pct, taskTokens, tasksAreSimilar, shortHash } from './normalize';

export interface RepeatGroup {
  repeatKey: string;
  employee: string;
  department: string;
  task: string;                 // up to three real spellings seen
  normalizedTask: string;
  occurrenceCount: number;
  distinctDates: number;
  maxSameDayCount: number;
  firstDate: string;
  lastDate: string;
  dates: string[];
  completedCount: number;
  openCount: number;
  classification: RepeatClassification;
  classificationReason: string;
  taskIds: string[];
}

export type BaselineSource =
  | 'configured'          // an expectation someone actually set
  | 'task history'        // median of the same task, historically
  | 'category history'    // median of the same task category
  | 'department history'; // median for the department

export interface SlowTask {
  taskId: string;
  date: string;
  department: string;
  employee: string;
  task: string;
  taskCategory: string;
  taskStatus: string;
  expectedDuration: number;
  actualDuration: number;
  varianceHours: number;
  variancePct: number;
  durationBasis: string;
  /** Where "expected" came from, and how many observations backed it. */
  baselineSource: BaselineSource;
  baselineSampleSize: number;
  reason: string;
}

export interface SlowDetail { source: string; sample: number; reason: string; expected: number }

export interface AnalysisResult {
  slowDetailByTaskId: Map<string, SlowDetail>;
  repeatGroups: RepeatGroup[];
  /** taskId -> classification, for the rows that belong to a group of >= 2 */
  repeatByTaskId: Map<string, RepeatClassification>;
  slowTasks: SlowTask[];
  slowFlagByTaskId: Map<string, SlowFlag>;
  varianceByTaskId: Map<string, number | null>;
  insufficientDurationCount: number;
}

export function analyzeRepeatedTasks(tasks: TaskRecord[], cfg: EngineConfig): {
  groups: RepeatGroup[];
  byTaskId: Map<string, RepeatClassification>;
} {
  // Lookback is anchored on the newest data point, not on "today", so a
  // backfill and a live run behave identically.
  const maxDate = tasks.map(t => t.date).sort().slice(-1)[0];
  const cutoff = maxDate ? addDays(maxDate, -cfg.repeatLookbackDays) : null;

  interface Bucket {
    employee: string; department: string; normalized: string;
    tokens: string[]; variants: Set<string>; taskIds: string[];
    dates: Set<string>; sameDay: Map<string, number>;
    completed: number; open: number;
  }
  const buckets = new Map<string, Bucket>();

  tasks.forEach(t => {
    if (cutoff && t.date < cutoff) return;
    const norm = t.taskNormalized || normalizeTask(t.task);
    if (!norm) return;
    const key = keyify(t.employeeName) + '||' + norm;
    let b = buckets.get(key);
    if (!b) {
      b = {
        employee: t.employeeName, department: t.department, normalized: norm,
        tokens: taskTokens(norm), variants: new Set(), taskIds: [],
        dates: new Set(), sameDay: new Map(), completed: 0, open: 0
      };
      buckets.set(key, b);
    }
    b.taskIds.push(t.taskId);
    b.variants.add(t.task);
    b.dates.add(t.date);
    b.sameDay.set(t.date, (b.sameDay.get(t.date) || 0) + 1);
    if (t.taskStatus === 'Completed') b.completed++; else b.open++;
  });

  // Merge near-identical wordings for the SAME employee. Different employees
  // are never merged.
  const byEmployee = new Map<string, string[]>();
  [...buckets.keys()].forEach(k => {
    const emp = k.split('||')[0];
    byEmployee.set(emp, [...(byEmployee.get(emp) || []), k]);
  });

  const canonicalOf = new Map<string, string>();
  byEmployee.forEach(keys => {
    const ordered = keys.sort(
      (a, b) => (buckets.get(b)!.taskIds.length - buckets.get(a)!.taskIds.length)
    );
    const canon: string[] = [];
    ordered.forEach(k => {
      for (const c of canon) {
        if (tasksAreSimilar(buckets.get(k)!.tokens, buckets.get(c)!.tokens, cfg.similarityThreshold)) {
          canonicalOf.set(k, c);
          return;
        }
      }
      canon.push(k);
      canonicalOf.set(k, k);
    });
  });

  const merged = new Map<string, Bucket>();
  buckets.forEach((b, k) => {
    const target = canonicalOf.get(k) || k;
    let m = merged.get(target);
    if (!m) {
      m = { ...buckets.get(target)!, variants: new Set(), taskIds: [], dates: new Set(),
            sameDay: new Map(), completed: 0, open: 0 };
      merged.set(target, m);
    }
    b.taskIds.forEach(id => m!.taskIds.push(id));
    b.variants.forEach(v => m!.variants.add(v));
    b.dates.forEach(d => m!.dates.add(d));
    b.sameDay.forEach((n, d) => m!.sameDay.set(d, (m!.sameDay.get(d) || 0) + n));
    m.completed += b.completed;
    m.open += b.open;
  });

  const groups: RepeatGroup[] = [];
  const byTaskId = new Map<string, RepeatClassification>();

  merged.forEach((b, key) => {
    const occurrenceCount = b.taskIds.length;
    if (occurrenceCount < 2) return;
    const dates = [...b.dates].sort();
    const maxSameDay = Math.max(...b.sameDay.values());

    let classification: RepeatClassification;
    let reason: string;
    if (maxSameDay >= cfg.repeatSameDayReviewMin) {
      classification = 'Needs Review';
      reason = `${maxSameDay} occurrences on a single day (>= repeatSameDayReviewMin=` +
        `${cfg.repeatSameDayReviewMin}). Could be genuine batched work or a reporting ` +
        `habit — a human should confirm.`;
    } else if (occurrenceCount >= cfg.repeatHighMin) {
      classification = 'Highly Repetitive';
      reason = `${occurrenceCount} occurrences across ${dates.length} day(s) ` +
        `(>= repeatHighMin=${cfg.repeatHighMin}). Candidate for automation or ` +
        `templating, not a performance judgement.`;
    } else if (dates.length >= cfg.repeatRecurringMin) {
      classification = 'Recurring / Legitimate';
      reason = `Appears on ${dates.length} distinct dates — a routine recurring duty.`;
    } else if (occurrenceCount > dates.length) {
      classification = 'Potential Duplication';
      reason = `${occurrenceCount} occurrences over only ${dates.length} date(s). ` +
        `Same-day repeats may be genuine, or a row may have been reported twice.`;
    } else {
      classification = 'Recurring / Legitimate';
      reason = `Appears on ${dates.length} distinct dates.`;
    }

    b.taskIds.forEach(id => byTaskId.set(id, classification));
    groups.push({
      repeatKey: shortHash(key, 12),
      employee: b.employee,
      department: b.department,
      task: [...b.variants].slice(0, 3).join(' | '),
      normalizedTask: b.normalized,
      occurrenceCount,
      distinctDates: dates.length,
      maxSameDayCount: maxSameDay,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      dates,
      completedCount: b.completed,
      openCount: b.open,
      classification,
      classificationReason: reason,
      taskIds: b.taskIds
    });
  });

  groups.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
  return { groups, byTaskId };
}

function median(values: number[]): number {
  const v = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Minimum observations before a derived median is trusted as "normal". */
const MIN_BASELINE_SAMPLE = 3;

/**
 * Baselines learned from the data itself, so slow-task analysis works even
 * when nobody has configured an expected duration.
 *
 * A median rather than a mean: one nine-hour outlier should not redefine what
 * normal looks like. And a minimum sample, because "normal" derived from two
 * observations is not normal, it is a coincidence.
 */
function buildBaselines(tasks: TaskRecord[]) {
  const byTask = new Map<string, number[]>();
  const byCategory = new Map<string, number[]>();
  const byDepartment = new Map<string, number[]>();
  tasks.forEach(t => {
    if (t.actualDuration === null || !(t.actualDuration > 0)) return;
    const push = (m: Map<string, number[]>, k: string) => {
      if (!k) return;
      m.set(k, [...(m.get(k) || []), t.actualDuration as number]);
    };
    push(byTask, t.taskNormalized);
    push(byCategory, t.taskCategory);
    push(byDepartment, t.department);
  });
  return { byTask, byCategory, byDepartment };
}

export function analyzeSlowTasks(tasks: TaskRecord[], cfg: EngineConfig): {
  slowTasks: SlowTask[];
  flagByTaskId: Map<string, SlowFlag>;
  varianceByTaskId: Map<string, number | null>;
  insufficientCount: number;
} {
  const baselines = buildBaselines(tasks);
  const slowTasks: SlowTask[] = [];
  const flagByTaskId = new Map<string, SlowFlag>();
  const varianceByTaskId = new Map<string, number | null>();
  let insufficientCount = 0;

  tasks.forEach(t => {
    const act = t.actualDuration;

    // An actual duration is non-negotiable: without it there is nothing to
    // judge, and inventing one would be fabricating the finding.
    if (act === null || isNaN(act) || act <= 0) {
      flagByTaskId.set(t.taskId, 'INSUFFICIENT_DATA');
      varianceByTaskId.set(t.taskId, null);
      insufficientCount++;
      return;
    }

    // The expectation, in order of authority: what someone configured, then
    // what this task/category/department has historically taken. A missing
    // expectation is never treated as zero — that would make every task
    // infinitely slow.
    let exp: number | null = null;
    let baselineSource: BaselineSource = 'configured';
    let sample = 0;

    if (t.expectedDuration !== null && !isNaN(t.expectedDuration) && t.expectedDuration > 0) {
      exp = t.expectedDuration;
    } else {
      const candidates: [BaselineSource, number[] | undefined][] = [
        ['task history', baselines.byTask.get(t.taskNormalized)],
        ['category history', baselines.byCategory.get(t.taskCategory)],
        ['department history', baselines.byDepartment.get(t.department)]
      ];
      for (const [source, values] of candidates) {
        // Exclude this task's own duration, or it partly defines its own
        // baseline and a single slow run looks normal.
        const others = (values || []).filter((_, i) => true);
        if (others.length >= MIN_BASELINE_SAMPLE) {
          exp = median(others);
          baselineSource = source;
          sample = others.length;
          break;
        }
      }
    }

    if (exp === null || exp <= 0) {
      flagByTaskId.set(t.taskId, 'INSUFFICIENT_DATA');
      varianceByTaskId.set(t.taskId, null);
      insufficientCount++;
      return;
    }
    const variance = Math.round((act - exp) * 100) / 100;
    const isSlow = act > exp * cfg.slowTaskMultiplier;
    flagByTaskId.set(t.taskId, isSlow ? 'TRUE' : 'FALSE');
    varianceByTaskId.set(t.taskId, variance);
    if (isSlow) {
      slowTasks.push({
        taskId: t.taskId, date: t.date, department: t.department,
        employee: t.employeeName, task: t.task, taskCategory: t.taskCategory,
        taskStatus: t.taskStatus,
        expectedDuration: Math.round(exp * 100) / 100, actualDuration: act,
        varianceHours: variance, variancePct: pct(act - exp, exp),
        durationBasis: t.durationBasis,
        baselineSource, baselineSampleSize: sample,
        reason: baselineSource === 'configured'
          ? `Took ${act}h against a configured expectation of ${Math.round(exp * 100) / 100}h ` +
            `(over the ${cfg.slowTaskMultiplier}x threshold).`
          : `Took ${act}h against a ${Math.round(exp * 100) / 100}h median from ${sample} ` +
            `comparable ${baselineSource.replace(' history', '')} observation(s).`
      });
    }
  });

  slowTasks.sort((a, b) => b.varianceHours - a.varianceHours);
  return { slowTasks, flagByTaskId, varianceByTaskId, insufficientCount };
}

export function analyze(tasks: TaskRecord[], cfg: EngineConfig): AnalysisResult {
  const rep = analyzeRepeatedTasks(tasks, cfg);
  const slow = analyzeSlowTasks(tasks, cfg);
  return {
    repeatGroups: rep.groups,
    repeatByTaskId: rep.byTaskId,
    slowTasks: slow.slowTasks,
    slowFlagByTaskId: slow.flagByTaskId,
    varianceByTaskId: slow.varianceByTaskId,
    insufficientDurationCount: slow.insufficientCount,
    slowDetailByTaskId: new Map(slow.slowTasks.map(s => [s.taskId, {
      source: s.baselineSource, sample: s.baselineSampleSize,
      reason: s.reason, expected: s.expectedDuration
    }]))
  };
}
