/**
 * Report rendering — port of 10_Reports.gs.
 *
 * A report is ALWAYS produced. The deterministic sections come from the
 * dataset; the AI only supplies commentary. The PROVENANCE footer states
 * exactly which of those happened, including anything the validator removed.
 */
import type { AiCommentary, AiDataset } from './ai';
import type { EngineConfig } from './types';

export type ReportStatus =
  | 'OK_NO_AI' | 'OK_AI' | 'OK_AI_PARTIAL' | 'OK_AI_UNAVAILABLE';

function signed(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'n/a';
  const r = Math.round(Number(n) * 10) / 10;
  return (r > 0 ? '+' : '') + r;
}

export function deterministicSummary(d: AiDataset): string {
  const t = d.totals;
  const parts: string[] = [];
  parts.push(
    `${t.total} task(s) were reported by ${d.departments.length} department(s) and ` +
    `${t.employeesReporting} employee(s) in this period, of which ${t.completed} are ` +
    `marked Completed (${t.completionRate}%).`
  );
  if (d.comparisonTotals.total > 0) {
    parts.push(
      `The previous comparable period had ${d.comparisonTotals.total} task(s) at ` +
      `${d.comparisonTotals.completionRate}% completion, a change of ` +
      `${signed(d.completionRateChangePercentagePoints)} percentage points.`
    );
  } else {
    parts.push('There is no comparable previous period in the database, so no trend is stated.');
  }
  if (d.slowTasks.length) {
    parts.push(`${d.slowTasks.length} task(s) exceeded their expected duration threshold.`);
  } else {
    parts.push(
      `No task exceeded its expected duration threshold; ` +
      `${d.dataQuality.tasksWithoutDurationData} task(s) lack the timestamps needed to judge duration.`
    );
  }
  return parts.join(' ');
}

export function deterministicAttention(d: AiDataset, cfg: EngineConfig): AiCommentary['attentionItems'] {
  const items: AiCommentary['attentionItems'] = [];
  d.departments.forEach(x => {
    if (x.total >= 5 && x.completionRate < 50) {
      items.push({
        item: `${x.department} completion rate is ${x.completionRate}%`,
        whyItMatters: 'Below half of reported tasks are marked Completed.',
        supportingData: `${x.completed} completed of ${x.total} reported; ` +
          `${x.pending} pending, ${x.blocked} blocked.`,
        suggestedAction: 'Confirm whether the work is genuinely open or whether statuses ' +
          'are not being updated at day end.'
      });
    }
    if (x.blocked >= 3) {
      items.push({
        item: `${x.department} has ${x.blocked} blocked task(s)`,
        whyItMatters: 'Blocked work does not move without an external unblock.',
        supportingData: `${x.blocked} of ${x.total} tasks carry status Blocked.`,
        suggestedAction: 'Review the blockers on the department page.'
      });
    }
  });
  if (d.slowTasks.length) {
    const worst = d.slowTasks[0];
    items.push({
      item: `${d.slowTasks.length} task(s) ran beyond ${cfg.slowTaskMultiplier}x their expected duration`,
      whyItMatters: 'Persistent overruns usually mean the estimate is wrong or the process ' +
        'has a hidden step.',
      supportingData: `Largest variance: "${worst.task}" (${worst.employee}) ` +
        `${worst.actualDuration} h actual vs ${worst.expectedDuration} h expected.`,
      suggestedAction: 'Check whether the category estimate is realistic.'
    });
  }
  const review = d.repeatedTasks.filter(r => r.classification === 'Needs Review');
  if (review.length) {
    items.push({
      item: `${review.length} repeated-task group(s) need a human check`,
      whyItMatters: 'Several identical rows on one day may be genuine batched work or a ' +
        'reporting artefact. The system does not guess.',
      supportingData: review.slice(0, 3)
        .map(r => `${r.employee}: "${r.task}" x${r.occurrences}`).join('; '),
      suggestedAction: 'Open the Repeated Tasks page and confirm with the reporter.'
    });
  }
  if (d.dataQuality.rowsRejectedInPeriod > 0) {
    items.push({
      item: `${d.dataQuality.rowsRejectedInPeriod} row(s) were rejected at import`,
      whyItMatters: 'Rejected rows are missing from every metric on the dashboard.',
      supportingData: JSON.stringify(d.dataQuality.rejectionReasons),
      suggestedAction: 'Open the Data Quality page, fix the source format or add the ' +
        'missing alias, then re-send the report.'
    });
  }
  return items;
}

export function deterministicTrends(d: AiDataset): string[] {
  const out: string[] = [];
  if (d.comparisonTotals.total > 0) {
    out.push(
      `Task volume moved from ${d.comparisonTotals.total} to ${d.totals.total} ` +
      `(${signed(d.totals.total - d.comparisonTotals.total)}).`
    );
    out.push(
      `Completion rate moved from ${d.comparisonTotals.completionRate}% to ` +
      `${d.totals.completionRate}% (${signed(d.completionRateChangePercentagePoints)} ` +
      `percentage points — not a percentage change).`
    );
  }
  const top = [...d.departments].sort((a, b) => b.total - a.total)[0];
  if (top) out.push(`Highest reported volume: ${top.department} with ${top.total} task(s).`);
  const rec = d.repeatedTasks.filter(r => r.classification === 'Highly Repetitive');
  if (rec.length) {
    out.push(
      `${rec.length} task pattern(s) are highly repetitive and may be automation ` +
      `candidates: ${rec.slice(0, 3).map(r => `"${r.task}"`).join(', ')}.`
    );
  }
  return out;
}

export function renderReport(
  d: AiDataset,
  ai: AiCommentary | null,
  status: ReportStatus,
  validationError: string,
  cfg: EngineConfig
): string {
  const L: string[] = [];
  const title = d.meta.reportType === 'DAILY' ? 'DAILY DEPARTMENT REPORT'
    : d.meta.reportType === 'WEEKLY' ? 'WEEKLY DEPARTMENT REPORT'
    : 'MONTHLY DEPARTMENT REPORT';

  L.push(title);
  L.push('Period: ' + d.meta.periodStart +
    (d.meta.periodStart === d.meta.periodEnd ? '' : ' to ' + d.meta.periodEnd));
  L.push('Generated: ' + d.meta.generatedAt);
  L.push('');
  L.push('EXECUTIVE SUMMARY');
  L.push('');
  L.push(ai?.summary || deterministicSummary(d));
  L.push('');
  L.push('Total Tasks:');
  L.push('  ' + d.totals.total);
  L.push('');
  L.push('Completed:');
  L.push('  ' + d.totals.completed);
  L.push('');
  L.push('Pending:');
  L.push('  ' + d.totals.pending);
  L.push('');
  L.push('In Progress:');
  L.push('  ' + d.totals.inProgress);
  L.push('');
  L.push('Completion Rate:');
  L.push('  ' + d.totals.completionRate + '%');
  if (d.totals.blocked || d.totals.cancelled || d.totals.notStarted) {
    L.push('');
    L.push(`Blocked: ${d.totals.blocked}   Not Started: ${d.totals.notStarted}   ` +
      `Cancelled: ${d.totals.cancelled}`);
  }
  L.push('');
  L.push(`Versus ${d.meta.comparisonPeriodStart} to ${d.meta.comparisonPeriodEnd}:`);
  if (d.comparisonTotals.total === 0) {
    L.push('  No comparable data in the previous period. Insufficient data.');
  } else {
    L.push(`  Tasks: ${d.comparisonTotals.total} -> ${d.totals.total} ` +
      `(${signed(d.totals.total - d.comparisonTotals.total)})`);
    L.push(`  Completion rate: ${d.comparisonTotals.completionRate}% -> ` +
      `${d.totals.completionRate}% (${signed(d.completionRateChangePercentagePoints)} ` +
      `percentage points)`);
  }
  L.push('');
  L.push('');
  L.push('DEPARTMENT PERFORMANCE');
  L.push('');
  if (!d.departments.length) L.push('Insufficient data.');
  d.departments.forEach(x => {
    L.push(x.department + ':');
    L.push(`  ${x.completionRate}%  (${x.completed} of ${x.total} completed, ` +
      `${x.pending} pending, ${x.inProgress} in progress, ` +
      `${x.employeesReporting} employee(s) reporting)`);
    const obs = ai?.departmentObservations.find(o => o.department === x.department);
    if (obs) {
      if (obs.observation) L.push('  Observation: ' + obs.observation);
      if (obs.interpretation) {
        L.push(`  Interpretation (${obs.confidence} confidence): ${obs.interpretation}`);
      }
    }
    L.push('');
  });
  L.push('');
  L.push('AREAS REQUIRING ATTENTION');
  L.push('');
  const attention = ai?.attentionItems.length ? ai.attentionItems : deterministicAttention(d, cfg);
  if (!attention.length) L.push('Nothing flagged by the deterministic rules for this period.');
  attention.forEach((a, i) => {
    L.push(`${i + 1}. ${a.item}`);
    if (a.whyItMatters) L.push('   Why it matters: ' + a.whyItMatters);
    if (a.supportingData) L.push('   Supporting data: ' + a.supportingData);
    if (a.suggestedAction) L.push('   Suggested action: ' + a.suggestedAction);
  });
  L.push('');
  L.push('');
  L.push('SLOW TASKS');
  L.push('');
  if (!d.slowTasks.length) {
    L.push('None identified. ' + d.slowTaskNote);
  } else {
    d.slowTasks.slice(0, 15).forEach(s => {
      const c = ai?.slowTasks.find(x => x.taskId === s.taskId);
      L.push('Task:       ' + s.task);
      L.push('Employee:   ' + s.employee);
      L.push('Department: ' + s.department);
      L.push('Expected:   ' + s.expectedDuration + ' h');
      L.push('Actual:     ' + s.actualDuration + ' h');
      L.push('Variance:   ' + signed(s.varianceHours) + ' h');
      if (c?.comment) L.push('Comment:    ' + c.comment);
      L.push('');
    });
    L.push(d.slowTaskNote);
  }
  L.push('');
  L.push('');
  L.push('REPEATED TASK PATTERNS');
  L.push('');
  if (!d.repeatedTasks.length) {
    L.push('No repeated task groups in this period.');
  } else {
    d.repeatedTasks.slice(0, 15).forEach(r => {
      const c = ai?.repeatedTasks.find(x => x.employee === r.employee && x.task === r.task);
      L.push('Task:           ' + r.task);
      L.push('Employee:       ' + r.employee);
      L.push(`Occurrences:    ${r.occurrences} across ${r.distinctDates} date(s)`);
      L.push('Classification: ' + r.classification);
      if (c?.comment) L.push('Comment:        ' + c.comment);
      L.push('');
    });
  }
  L.push('');
  L.push('KEY TRENDS');
  L.push('');
  const trends = ai?.trends.length ? ai.trends : deterministicTrends(d);
  if (!trends.length) L.push('- Insufficient data.');
  trends.forEach(t => L.push('- ' + t));
  L.push('');
  L.push('');
  L.push('DATA QUALITY');
  L.push('');
  const q = d.dataQuality;
  L.push('- Tasks in period: ' + q.tasksInPeriod);
  L.push('- Rows rejected during import: ' + q.rowsRejectedInPeriod +
    (Object.keys(q.rejectionReasons).length
      ? ' (' + Object.entries(q.rejectionReasons).map(([k, v]) => `${k}: ${v}`).join(', ') + ')'
      : ''));
  L.push('- Tasks missing a link: ' + q.tasksMissingLink);
  L.push('- Tasks flagged for review: ' + q.tasksFlaggedForReview);
  L.push('- Tasks without duration information: ' + q.tasksWithoutDurationData +
    ' (duration and efficiency cannot be measured for these)');
  L.push('- Unclassified tasks: ' + q.uncategorisedTasks);
  ai?.dataQuality.forEach(x => L.push('- ' + x));
  L.push('');
  L.push('');
  L.push('PROVENANCE');
  L.push('- All counts, rates and flags above are computed by application code, not by an AI.');
  if (status === 'OK_NO_AI') {
    L.push('- AI commentary: disabled. Deterministic commentary used.');
  } else if (status === 'OK_AI_UNAVAILABLE') {
    L.push('- AI commentary: UNAVAILABLE this run. ' + validationError);
  } else if (status === 'OK_AI_PARTIAL') {
    L.push('- AI commentary: included, but some claims failed validation and were removed: ' +
      validationError);
  } else {
    L.push('- AI commentary: included and validated against the dataset.');
  }
  return L.join('\n');
}
