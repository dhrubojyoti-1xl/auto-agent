import { query } from './db';

/**
 * Columns and views the running code depends on. A deploy can ship code that
 * expects a column the database has not been given yet — the code lands the
 * moment the build finishes, the migration does not. Rather than let that
 * surface as a 500 on a dashboard page, /connect checks this list and offers
 * to apply the pending migrations.
 *
 * Only add entries the code would actually break without.
 */
const REQUIRED_COLUMNS: [table: string, column: string][] = [
  ['tasks', 'owner_user_id'],
  ['tasks', 'slow_baseline_source'],
  ['tasks', 'slow_baseline_sample'],
  ['tasks', 'slow_reason'],
  ['documents', 'owner_user_id'],
  ['gmail_accounts', 'refresh_token_enc'],
  ['sync_runs', 'rows_duplicate'],
  ['ai_reports', 'dataset_fingerprint'],
  ['employees', 'auto_created'],
  ['documents', 'detector_version'],
  ['documents', 'classification'],
  ['tasks', 'work_kind']
];

const REQUIRED_VIEWS = [
  'slow_tasks', 'daily_summary', 'weekly_summary', 'monthly_summary',
  'department_summary', 'employee_summary'
];

export type SchemaStatus = {
  ok: boolean;
  missingColumns: string[];
  missingViews: string[];
};

export async function getSchemaStatus(): Promise<SchemaStatus> {
  const cols = await query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
     where table_schema = 'public'`);
  const have = new Set(cols.map(c => `${c.table_name}.${c.column_name}`));
  const missingColumns = REQUIRED_COLUMNS
    .map(([t, c]) => `${t}.${c}`).filter(k => !have.has(k));

  const views = await query<{ table_name: string }>(
    `select table_name from information_schema.views where table_schema = 'public'`);
  const haveViews = new Set(views.map(v => v.table_name));
  const missingViews = REQUIRED_VIEWS.filter(v => !haveViews.has(v));

  return { ok: missingColumns.length === 0 && missingViews.length === 0,
           missingColumns, missingViews };
}
