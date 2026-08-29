/**
 * Deterministic aggregation — port of 08_Metrics.gs.
 *
 * Every rate here is computed from summed counts, never by averaging stored
 * rates: averaging a 100%-of-1 department with a 50%-of-40 department gives 75%,
 * which is wrong and is the classic way these dashboards mislead.
 */
import type { AnalysisResult } from './analysis';
import type { EngineConfig, TaskRecord } from './types';
import { addDays, monthLabel, monthStartOf, pct, ppChange, weekStartOf } from './normalize';

export interface Bucket {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  blocked: number;
  cancelled: number;
  notStarted: number;
  completionRate: number;
  pendingRate: number;
  slowTasks: number;
  repeatedTasks: number;
  employeesReporting: number;
  dates: string[];
}

export interface PeriodRow extends Bucket {
  periodKey: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  department: string;
  prevCompletionRate: number | null;
  completionRatePpChange: number | null;
}

export interface DepartmentRow extends Bucket {
  department: string;
  firstDate: string;
  lastDate: string;
  last7dTasks: number;
  prev7dTasks: number;
  last7dCompletionRate: number;
  prev7dCompletionRate: number;
  wowPpChange: number | null;
}

export interface EmployeeRow extends Bucket {
  employee: string;
  employeeId: string;
  department: string;
  distinctDaysReported: number;
  firstDate: string;
  lastDate: string;
  last7dTasks: number;
  prev7dTasks: number;
  last7dCompletionRate: number;
  prev7dCompletionRate: number;
  wowPpChange: number | null;
  /**
   * Honest label. Task counts measure reported ACTIVITY, not value or
   * complexity, and a thin sample must never be turned into a league table.
   */
  dataSufficiency: 'Sufficient for trend' | 'Indicative only' | 'Insufficient — do not rank';
}

class Acc {
  total = 0; completed = 0; inProgress = 0; pending = 0;
  blocked = 0; cancelled = 0; notStarted = 0;
  slow = 0; repeated = 0;
  employees = new Set<string>();
  dates = new Set<string>();

  add(t: TaskRecord, analysis: AnalysisResult) {
    this.total++;
    switch (t.taskStatus) {
      case 'Completed': this.completed++; break;
      case 'In Progress': this.inProgress++; break;
      case 'Pending': this.pending++; break;
      case 'Blocked': this.blocked++; break;
      case 'Cancelled': this.cancelled++; break;
      case 'Not Started': this.notStarted++; break;
    }
    if (analysis.slowFlagByTaskId.get(t.taskId) === 'TRUE') this.slow++;
    if (analysis.repeatByTaskId.has(t.taskId)) this.repeated++;
    if (t.employeeName) this.employees.add(t.employeeName);
    if (t.date) this.dates.add(t.date);
  }

  toBucket(): Bucket {
    return {
      total: this.total, completed: this.completed, inProgress: this.inProgress,
      pending: this.pending, blocked: this.blocked, cancelled: this.cancelled,
      notStarted: this.notStarted,
      completionRate: pct(this.completed, this.total),
      pendingRate: pct(this.pending, this.total),
      slowTasks: this.slow, repeatedTasks: this.repeated,
      employeesReporting: this.employees.size,
      dates: [...this.dates].sort()
    };
  }
}

type Grain = 'daily' | 'weekly' | 'monthly';

function periodStartFor(date: string, grain: Grain, cfg: EngineConfig): string {
  if (grain === 'daily') return date;
  if (grain === 'weekly') return weekStartOf(date, cfg.weekStart);
  return monthStartOf(date);
}

function periodEndFor(start: string, grain: Grain): string {
  if (grain === 'daily') return start;
  if (grain === 'weekly') return addDays(start, 6);
  const [y, m] = start.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function periodLabel(start: string, grain: Grain): string {
  if (grain === 'daily') return start;
  if (grain === 'weekly') return 'Week of ' + start;
  return monthLabel(start);
}

/**
 * Builds one row per period per department, PLUS a `department: 'ALL'` roll-up
 * row so a KPI card reads a single row instead of summing a filtered range.
 */
export function buildPeriodSummary(
  tasks: TaskRecord[], analysis: AnalysisResult, cfg: EngineConfig, grain: Grain
): PeriodRow[] {
  const acc = new Map<string, { start: string; department: string; a: Acc }>();
  tasks.forEach(t => {
    if (!t.date) return;
    const start = periodStartFor(t.date, grain, cfg);
    [t.department || cfg.defaultDepartment, 'ALL'].forEach(dept => {
      const key = start + '||' + dept;
      let e = acc.get(key);
      if (!e) { e = { start, department: dept, a: new Acc() }; acc.set(key, e); }
      e.a.add(t, analysis);
    });
  });

  const prevRate = new Map<string, number>();
  return [...acc.values()]
    .sort((x, y) => x.start.localeCompare(y.start) || x.department.localeCompare(y.department))
    .map(e => {
      const b = e.a.toBucket();
      const prev = prevRate.get(e.department);
      prevRate.set(e.department, b.completionRate);
      return {
        ...b,
        periodKey: e.start + '|' + e.department,
        label: periodLabel(e.start, grain),
        periodStart: e.start,
        periodEnd: periodEndFor(e.start, grain),
        department: e.department,
        prevCompletionRate: prev === undefined ? null : prev,
        completionRatePpChange: prev === undefined ? null : ppChange(b.completionRate, prev)
      };
    });
}

/** Windows are anchored on the newest task date, not on "today". */
function anchorDate(tasks: TaskRecord[]): string | null {
  const dates = tasks.map(t => t.date).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

export function buildDepartmentSummary(
  tasks: TaskRecord[], analysis: AnalysisResult, cfg: EngineConfig
): DepartmentRow[] {
  const anchor = anchorDate(tasks);
  if (!anchor) return [];
  const w1 = addDays(anchor, -6), w2 = addDays(anchor, -13);

  const acc = new Map<string, { a: Acc; l7: Acc; p7: Acc; first: string; last: string }>();
  tasks.forEach(t => {
    if (!t.date) return;
    const dept = t.department || cfg.defaultDepartment;
    let e = acc.get(dept);
    if (!e) { e = { a: new Acc(), l7: new Acc(), p7: new Acc(), first: t.date, last: t.date }; acc.set(dept, e); }
    e.a.add(t, analysis);
    if (t.date < e.first) e.first = t.date;
    if (t.date > e.last) e.last = t.date;
    if (t.date >= w1 && t.date <= anchor) e.l7.add(t, analysis);
    else if (t.date >= w2 && t.date < w1) e.p7.add(t, analysis);
  });

  return [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dept, e]) => {
    const b = e.a.toBucket();
    const l7 = e.l7.toBucket(), p7 = e.p7.toBucket();
    return {
      ...b, department: dept, firstDate: e.first, lastDate: e.last,
      last7dTasks: l7.total, prev7dTasks: p7.total,
      last7dCompletionRate: l7.completionRate,
      prev7dCompletionRate: p7.completionRate,
      wowPpChange: p7.total ? ppChange(l7.completionRate, p7.completionRate) : null
    };
  });
}

export function buildEmployeeSummary(
  tasks: TaskRecord[], analysis: AnalysisResult, cfg: EngineConfig
): EmployeeRow[] {
  const anchor = anchorDate(tasks);
  if (!anchor) return [];
  const w1 = addDays(anchor, -6), w2 = addDays(anchor, -13);

  const acc = new Map<string, {
    a: Acc; l7: Acc; p7: Acc; first: string; last: string; id: string; dept: string;
  }>();
  tasks.forEach(t => {
    const name = (t.employeeName || '').trim();
    if (!name || !t.date) return;
    let e = acc.get(name);
    if (!e) {
      e = { a: new Acc(), l7: new Acc(), p7: new Acc(), first: t.date, last: t.date,
            id: t.employeeId, dept: t.department };
      acc.set(name, e);
    }
    e.a.add(t, analysis);
    if (t.date < e.first) e.first = t.date;
    if (t.date > e.last) e.last = t.date;
    if (t.date >= w1 && t.date <= anchor) e.l7.add(t, analysis);
    else if (t.date >= w2 && t.date < w1) e.p7.add(t, analysis);
  });

  return [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, e]) => {
    const b = e.a.toBucket();
    const l7 = e.l7.toBucket(), p7 = e.p7.toBucket();
    const days = b.dates.length;
    const dataSufficiency: EmployeeRow['dataSufficiency'] =
      b.total >= 30 && days >= 10 ? 'Sufficient for trend'
        : b.total >= 10 ? 'Indicative only'
        : 'Insufficient — do not rank';
    return {
      ...b, employee: name, employeeId: e.id, department: e.dept,
      distinctDaysReported: days, firstDate: e.first, lastDate: e.last,
      last7dTasks: l7.total, prev7dTasks: p7.total,
      last7dCompletionRate: l7.completionRate,
      prev7dCompletionRate: p7.completionRate,
      wowPpChange: p7.total ? ppChange(l7.completionRate, p7.completionRate) : null,
      dataSufficiency
    };
  });
}

export function bucketFor(tasks: TaskRecord[], analysis: AnalysisResult): Bucket {
  const a = new Acc();
  tasks.forEach(t => a.add(t, analysis));
  return a.toBucket();
}
