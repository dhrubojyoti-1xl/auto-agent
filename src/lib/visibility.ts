/**
 * What the app is allowed to show about the mailbox: reports, and nothing else.
 *
 * The assistant has to look at every message to find the reports among them,
 * and it keeps a one-line verdict for each so it never reads the same message
 * twice. Those verdicts are bookkeeping. A newsletter's subject, a colleague's
 * personal mail, the sender of an unrelated spreadsheet — none of it belongs on
 * a screen, in an export, or in a charting tool. Only the fact that N other
 * messages were checked is ever shown.
 *
 * A document counts as a report when:
 *   - it was typed or pasted into the app (Manual entry, the API), or
 *   - a report table was found in it (tables_found > 0), or it produced rows, or
 *   - a report was detected in a picture that could not be read — the one
 *     "could not process" case that is known to be a report.
 *
 * Messages recorded as not-a-report are written with tables_found = 0, so the
 * test holds for everything already in the database without changing a row.
 */

/**
 * SQL: this `documents` row is a report the app may show.
 *
 * Every term is null-safe. A NULL anywhere would make the whole test NULL, and
 * `not NULL` is NULL too — the row would then be neither shown nor counted.
 */
export function reportDocument(alias: string): string {
  const a = alias;
  return `(coalesce(${a}.source, '') not in ('email', 'attachment')
           or coalesce(${a}.tables_found, 0) > 0
           or coalesce(${a}.rows_inserted, 0) > 0
           or (coalesce(${a}.classification, '') = 'REVIEW_REQUIRED'
               and coalesce(${a}.evidence, '') ilike '%a report was detected%'))`;
}

/**
 * SQL: this `data_quality` row may be shown.
 *
 * Row-level rejections come from report tables and are always shown. An entry
 * about an email attachment ("GM-<message id>") is shown only when that message
 * was a report, or when a report was detected in a picture it carried.
 */
export function reportRejection(alias: string): string {
  const a = alias;
  return `(${a}.report_id is null or ${a}.report_id not like 'GM-%'
           or ${a}.rejection_reason = 'IMAGE_REVIEW_REQUIRED'
           or exists (select 1 from documents s
                       where s.owner_user_id = ${a}.owner_user_id
                         and s.gmail_message_id is not null
                         and ${a}.report_id = 'GM-' || s.gmail_message_id
                         and (coalesce(s.tables_found, 0) > 0
                              or coalesce(s.rows_inserted, 0) > 0)))`;
}
