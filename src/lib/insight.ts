/**
 * The paragraph at the top of the management view.
 *
 * Written by application code from figures the application computed, so it is
 * always available, always correct, and costs nothing. The AI commentary on
 * the Management report is a richer interpretation of the same numbers; this
 * is the sentence a manager reads before deciding whether to open it.
 *
 * Everything here is deliberately conservative. A dashboard that says
 * "completion improved 100%" because one task became two, or "Sales is the
 * strongest department" when Sales is the only department, is not being
 * helpful — it is being confidently wrong, and a reader who catches it once
 * stops believing the rest.
 */
import type { Kpis, PeriodPoint } from './queries';
import { compareCounts, compareRates, MIN_BASE_FOR_PERCENT } from './analytics';
import type { CoverageTotals } from './analytics';

export interface Insight {
  headline: string;
  points: { tone: 'good' | 'warn' | 'info'; mark: string; text: string }[];
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function buildInsight(
  kpis: Kpis, series: PeriodPoint[], coverage: CoverageTotals, grainNoun: string
): Insight {
  const latest = series[series.length - 1];
  const previous = series[series.length - 2];
  const points: Insight['points'] = [];

  const headline = kpis.total === 0
    ? 'No work has been reported yet.'
    : `${plural(kpis.total, 'task')} reported across ` +
      `${plural(kpis.departmentsReporting, 'department')} by ` +
      `${plural(kpis.employeesReporting, 'person', 'people')}. ` +
      `${kpis.completed} completed, ${kpis.total - kpis.completed} still open.`;

  if (kpis.total === 0) {
    return {
      headline,
      points: coverage.messagesScanned > 0
        ? [{ tone: 'info', mark: 'ℹ', text:
            `${plural(coverage.messagesScanned, 'message')} read so far; none contained ` +
            `a report. Anything unreadable is listed on Data quality.` }]
        : []
    };
  }

  points.push({
    tone: 'good', mark: '✓',
    text: `${plural(kpis.completed, 'task')} completed — ` +
          `${kpis.completionRate}% of everything reported.`
  });

  // Period-on-period movement, but only when the comparison carries weight.
  if (latest && previous) {
    const rate = compareRates(latest.completionRate, previous.completionRate, previous.total);
    if (!rate.weak && rate.points !== null && Math.abs(rate.points) >= 1) {
      points.push({
        tone: rate.points > 0 ? 'good' : 'warn',
        mark: rate.points > 0 ? '↑' : '↓',
        text: `Completion rate ${rate.points > 0 ? 'improved' : 'fell'} by ` +
              `${Math.abs(rate.points)} percentage points against the previous ${grainNoun}.`
      });
    }
    const vol = compareCounts(latest.total, previous.total);
    if (!vol.weak && vol.percent !== null && Math.abs(vol.percent) >= 20) {
      points.push({
        tone: 'info', mark: vol.change > 0 ? '↑' : '↓',
        text: `Reported volume ${vol.change > 0 ? 'rose' : 'fell'} from ` +
              `${previous.total} to ${latest.total} against the previous ${grainNoun}.`
      });
    }
  }

  const open = kpis.total - kpis.completed;
  if (open > 0) {
    points.push({
      tone: open > kpis.completed ? 'warn' : 'info',
      mark: open > kpis.completed ? '⚠' : 'ℹ',
      text: `${plural(open, 'task')} still open` +
            (kpis.blocked > 0 ? `, of which ${kpis.blocked} blocked.` : '.')
    });
  }

  if (kpis.slowTasks > 0) {
    points.push({
      tone: 'warn', mark: '⚠',
      text: `${plural(kpis.slowTasks, 'task')} took materially longer than comparable work.`
    });
  } else if (kpis.insufficientDuration === kpis.total && kpis.total > 0) {
    points.push({
      tone: 'info', mark: 'ℹ',
      text: `No task can be timed: none of the ${kpis.total} carries start and ` +
            `end times, so nothing is called slow without evidence.`
    });
  }

  if (kpis.repeatGroups > 0) {
    points.push({
      tone: kpis.repeatAttention > 0 ? 'warn' : 'info',
      mark: kpis.repeatAttention > 0 ? '⚠' : 'ℹ',
      text: kpis.repeatAttention > 0
        ? `${plural(kpis.repeatAttention, 'repeated item')} worth checking, out of ` +
          `${kpis.repeatGroups} recurring overall.`
        : `${plural(kpis.repeatGroups, 'piece')} of recurring work, none unusual.`
    });
  }

  if (coverage.reportsNeedingReview > 0) {
    points.push({
      tone: 'warn', mark: '⚠',
      text: `${plural(coverage.reportsNeedingReview, 'message')} looked like a report ` +
            `and could not be read.`
    });
  }

  // Only ever a statement of fact about coverage, never a claim about
  // performance: one department is not "the best department".
  if (kpis.departmentsReporting === 1) {
    points.push({
      tone: 'info', mark: 'ℹ',
      text: 'Only one department is reporting, so no comparison between ' +
            'departments is possible yet.'
    });
  }

  return { headline, points: points.slice(0, 6) };
}

/**
 * True when a period-on-period figure would be arithmetic rather than
 * information. Exported so screens can suppress the same comparisons the
 * paragraph does.
 */
export function comparisonIsMeaningful(previousTotal: number): boolean {
  return previousTotal >= MIN_BASE_FOR_PERCENT;
}
