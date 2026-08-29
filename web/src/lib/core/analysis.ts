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
import { addDays, keyify, normalizeTask, pct, taskTokens, tokenSimilarity, shortHash } from './normalize';

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
}

export interface AnalysisResult {
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
        if (tokenSimilarity(buckets.get(k)!.tokens, buckets.get(c)!.tokens) >= cfg.similarityThreshold) {
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

export function analyzeSlowTasks(tasks: TaskRecord[], cfg: EngineConfig): {
  slowTasks: SlowTask[];
  flagByTaskId: Map<string, SlowFlag>;
  varianceByTaskId: Map<string, number | null>;
  insufficientCount: number;
} {
  const slowTasks: SlowTask[] = [];
  const flagByTaskId = new Map<string, SlowFlag>();
  const varianceByTaskId = new Map<string, number | null>();
  let insufficientCount = 0;

  tasks.forEach(t => {
    const exp = t.expectedDuration;
    const act = t.actualDuration;
    // BOTH numbers must exist. A missing expectation is not zero — treating it
    // as zero would make every task infinitely slow.
    if (exp === null || act === null || isNaN(exp) || isNaN(act) || exp <= 0) {
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
        taskStatus: t.taskStatus, expectedDuration: exp, actualDuration: act,
        varianceHours: variance, variancePct: pct(act - exp, exp),
        durationBasis: t.durationBasis
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
    insufficientDurationCount: slow.insufficientCount
  };
}
