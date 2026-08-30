/**
 * One definition of every number the product reports.
 *
 * Pages used to compute these for themselves, and disagreed. The Overview said
 * "Reports processed: 0" because it counted the eight rows it was about to
 * display, while the Inbox said "1 report, 47 rows imported" from the sync
 * summary — both on screen at the same time, both wrong in different ways.
 *
 * Every screen now asks this module. When a definition is wrong it is wrong in
 * one place, and when it changes it changes everywhere at once.
 */
import { query } from './db';

/**
 * What happened to the mail. These names are the vocabulary the interface uses;
 * a screen that needs a different number needs a new field here, not a local
 * calculation.
 */
export interface CoverageTotals {
  /** Messages the assistant has opened and judged. */
  messagesScanned: number;
  /** Messages judged to contain a report, whatever became of the rows. */
  reportsDetected: number;
  /** Reports that produced at least one task. */
  reportsProcessed: number;
  /** Reports whose rows all failed, or whose file could not be read. */
  reportsNeedingReview: number;
  /** Messages read and decided against: newsletters, invoices, personal mail. */
  messagesIgnored: number;
  /** Messages whose format this system cannot read at all. */
  unsupportedFormat: number;
  rowsExtracted: number;
  rowsImported: number;
  rowsRejected: number;
  duplicatesBlocked: number;
}

export async function getCoverage(ownerUserId: number): Promise<CoverageTotals> {
  const [d] = await query<Record<string, number>>(
    `select
       count(*)::int                                                  as scanned,
       count(*) filter (where processing_status <> 'NO_DATA')::int    as detected,
       count(*) filter (where rows_inserted > 0)::int                 as processed,
       count(*) filter (where classification = 'REVIEW_REQUIRED'
                           or (processing_status <> 'NO_DATA'
                               and rows_inserted = 0))::int           as review,
       count(*) filter (where classification = 'NON_REPORT'
                           or (classification is null
                               and processing_status = 'NO_DATA'))::int as ignored,
       count(*) filter (where classification = 'UNSUPPORTED_FORMAT')::int as unsupported,
       coalesce(sum(rows_extracted), 0)::int                          as extracted,
       coalesce(sum(rows_inserted), 0)::int                           as imported,
       coalesce(sum(rows_rejected), 0)::int                           as rejected,
       coalesce(sum(rows_skipped_idempotent), 0)::int                 as duplicates
     from documents where owner_user_id = $1`, [ownerUserId]);

  return {
    messagesScanned: num(d?.scanned), reportsDetected: num(d?.detected),
    reportsProcessed: num(d?.processed), reportsNeedingReview: num(d?.review),
    messagesIgnored: num(d?.ignored), unsupportedFormat: num(d?.unsupported),
    rowsExtracted: num(d?.extracted), rowsImported: num(d?.imported),
    rowsRejected: num(d?.rejected), duplicatesBlocked: num(d?.duplicates)
  };
}

const num = (v: unknown) => Number(v ?? 0);

/* ------------------------------------------------------------------ */
/* Comparisons                                                         */
/* ------------------------------------------------------------------ */

/**
 * A change worth showing, or an honest refusal to show one.
 *
 * "100%" from one task to two is arithmetically true and management nonsense.
 * A comparison is only offered when the previous period had enough in it to
 * mean something; otherwise the caller is told to say so instead.
 */
export interface Delta {
  /** Absolute change, always available. */
  change: number;
  /** Percentage change, only when the base is large enough to carry one. */
  percent: number | null;
  /** Percentage-point change, for comparing two rates. */
  points: number | null;
  direction: 'up' | 'down' | 'flat';
  /** True when the sample is too small for the change to mean anything. */
  weak: boolean;
  label: string;
}

/** Below this, a percentage change says more about the denominator than the work. */
export const MIN_BASE_FOR_PERCENT = 5;

export function compareCounts(current: number, previous: number, noun = ''): Delta {
  const change = current - previous;
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const weak = previous < MIN_BASE_FOR_PERCENT;
  const percent = weak || previous === 0
    ? null
    : Math.round((change / previous) * 1000) / 10;

  const sign = change > 0 ? '+' : '';
  const label = previous === 0
    ? (current === 0 ? 'no change' : 'no previous period to compare')
    : weak
      ? `${sign}${change} vs ${previous}${noun ? ' ' + noun : ''} — small sample`
      : `${sign}${change} vs previous (${sign}${percent}%)`;

  return { change, percent, points: null, direction, weak, label };
}

export function compareRates(current: number, previous: number, sampleSize: number): Delta {
  const points = Math.round((current - previous) * 10) / 10;
  const direction = points > 0 ? 'up' : points < 0 ? 'down' : 'flat';
  const weak = sampleSize < MIN_BASE_FOR_PERCENT;
  const sign = points > 0 ? '+' : '';
  return {
    change: points, percent: null, points, direction, weak,
    label: weak
      ? 'limited sample'
      : previous === 0 && current === 0
        ? 'no change'
        : `${sign}${points} pp vs previous`
  };
}

/* ------------------------------------------------------------------ */
/* Attention                                                           */
/* ------------------------------------------------------------------ */

export type Severity = 'critical' | 'high' | 'medium' | 'info';

export interface AttentionItem {
  severity: Severity;
  title: string;
  detail: string;
  count: number;
  href?: string;
  action?: string;
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, info: 3 };

/**
 * What management should look at, ordered by how much it matters.
 *
 * The bar for "critical" is deliberately high. A dashboard that shouts at
 * normal conditions teaches its reader to ignore it, and then it cannot warn
 * them about anything.
 */
export async function getAttention(ownerUserId: number): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  const [sync] = await query<Record<string, string | number | null>>(
    `select
       (select count(*)::int from sync_runs
         where owner_user_id = $1 and status in ('FAILED','REAUTH_REQUIRED')
           and started_at > now() - interval '3 days')            as recent_failures,
       (select count(*)::int from gmail_accounts
         where owner_user_id = $1 and active
           and last_sync_status = 'REAUTH_REQUIRED')              as reauth,
       (select max(started_at) from sync_runs
         where owner_user_id = $1 and status = 'OK')              as last_ok`, [ownerUserId]);

  if (num(sync?.reauth) > 0) {
    items.push({
      severity: 'critical', count: num(sync.reauth),
      title: 'Gmail access needs reconnecting',
      detail: 'Reports cannot be collected until the inbox is reconnected. ' +
              'Nothing already imported is affected.',
      href: '/connect', action: 'Reconnect'
    });
  } else if (num(sync?.recent_failures) > 0) {
    items.push({
      severity: 'high', count: num(sync.recent_failures),
      title: 'Recent syncs failed',
      detail: 'One or more scheduled checks of the inbox did not complete.',
      href: '/health', action: 'See sync health'
    });
  }

  const [quality] = await query<Record<string, number>>(
    `select
       (select count(*)::int from data_quality where owner_user_id = $1
          and resolution_status = 'Open')                                  as open_rows,
       (select count(*)::int from documents where owner_user_id = $1
          and classification = 'REVIEW_REQUIRED')                          as review_msgs,
       (select count(*)::int from documents where owner_user_id = $1
          and classification = 'UNSUPPORTED_FORMAT')                       as unsupported,
       (select count(*)::int from tasks where owner_user_id = $1
          and work_kind <> 'PLANNED' and slow_task_flag = 'TRUE')          as slow,
       (select count(*)::int from tasks where owner_user_id = $1
          and work_kind <> 'PLANNED'
          and slow_task_flag = 'INSUFFICIENT_DATA')                        as no_duration,
       (select count(*)::int from tasks where owner_user_id = $1
          and work_kind <> 'PLANNED'
          and task_status in ('Pending','In Progress','Blocked'))          as backlog,
       (select count(*)::int from tasks where owner_user_id = $1
          and work_kind <> 'PLANNED' and task_status = 'Blocked')          as blocked,
       (select count(*)::int from tasks where owner_user_id = $1
          and work_kind <> 'PLANNED')                                      as total,
       (select count(*)::int from tasks where owner_user_id = $1
          and work_kind <> 'PLANNED'
          and coalesce(department,'') in ('', 'Unassigned'))               as unattributed,
       (select count(*)::int from repeat_groups where owner_user_id = $1
          and classification in ('Needs Review','Potential Duplication'))  as repeats`,
    [ownerUserId]);

  if (num(quality?.review_msgs) > 0) {
    items.push({
      severity: 'high', count: num(quality.review_msgs),
      title: 'Messages could not be read',
      detail: 'Something in these looked like a report and could not be processed. ' +
              'Each says what happened and what would fix it.',
      href: '/quality', action: 'Review'
    });
  }
  if (num(quality?.blocked) > 0) {
    items.push({
      severity: 'high', count: num(quality.blocked),
      title: 'Blocked work',
      detail: 'Reported as blocked and not moving without a decision.',
      href: '/management', action: 'See tasks'
    });
  }
  if (num(quality?.open_rows) > 0) {
    items.push({
      severity: 'medium', count: num(quality.open_rows),
      title: 'Rows that could not be imported',
      detail: 'Kept with their original values and a reason. Nothing was discarded.',
      href: '/quality', action: 'See rows'
    });
  }
  if (num(quality?.repeats) > 0) {
    items.push({
      severity: 'medium', count: num(quality.repeats),
      title: 'Repeated work worth a look',
      detail: 'Groups classified as possible duplication or needing review. ' +
              'Repetition on its own is normal.',
      href: '/repeats', action: 'See groups'
    });
  }
  if (num(quality?.slow) > 0) {
    items.push({
      severity: 'medium', count: num(quality.slow),
      title: 'Work that took materially longer than comparable work',
      detail: 'Each shows the baseline it was measured against and where it came from.',
      href: '/slow', action: 'See tasks'
    });
  }
  if (num(quality?.unsupported) > 0) {
    items.push({
      severity: 'info', count: num(quality.unsupported),
      title: 'Reports arrived in a format that cannot be read',
      detail: 'PDFs and documents are not parsed. A spreadsheet, an inline table ' +
              'or a shared Google Sheet works.',
      href: '/quality', action: 'See messages'
    });
  }
  if (num(quality?.unattributed) > 0 && num(quality?.total) > 0) {
    items.push({
      severity: 'info', count: num(quality.unattributed),
      title: 'Work not attributed to a department',
      detail: 'These reports carry no department column, and the sender address ' +
              'identifies none, so no department was guessed.',
      href: '/quality', action: 'Review attribution'
    });
  }
  if (num(quality?.no_duration) > 0) {
    items.push({
      severity: 'info', count: num(quality.no_duration),
      title: 'Tasks without timing information',
      detail: 'Duration cannot be measured, so these are excluded from slow-task ' +
              'analysis rather than assumed to be on time. Add start and end time ' +
              'columns to the report to enable it.',
      href: '/slow', action: 'How this works'
    });
  }

  return items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.count - a.count);
}
