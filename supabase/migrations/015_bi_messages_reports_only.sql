-- Reports only, in the charting tool too.
--
-- bi_messages listed every message the assistant ever judged — newsletters,
-- personal mail, unrelated spreadsheets — with subject and sender, to anyone
-- with the read-only charting login. The application no longer shows any of
-- that (src/lib/visibility.ts), and a Looker Studio page must not be the one
-- place it can still be read.
--
-- The rule is the application's, word for word: a row is a report when it was
-- entered in the app, when a report table was found in it or it produced rows,
-- or when a report was detected in a picture that could not be read.
--
-- Same columns in the same order, so this is a plain CREATE OR REPLACE: every
-- existing chart and the bi_reader grant keep working. No data is changed.
-- Safe to run more than once.

create or replace view bi_messages as
select
  d.owner_user_id,
  d.report_id,
  d.received_at,
  d.processed_at,
  d.subject,
  d.sender,
  coalesce(d.classification, 'NON_REPORT')  as classification,
  d.processing_status,
  d.attachment_name,
  d.departments_count,
  d.departments_list,
  d.rows_extracted,
  d.rows_inserted,
  d.rows_rejected,
  d.prefilter_score,
  d.evidence
from documents d
where coalesce(d.source, '') not in ('email', 'attachment')
   or coalesce(d.tables_found, 0) > 0
   or coalesce(d.rows_inserted, 0) > 0
   or (coalesce(d.classification, '') = 'REVIEW_REQUIRED'
       and coalesce(d.evidence, '') ilike '%a report was detected%');

comment on view bi_messages is
  'Reports the assistant received, with the rows each produced. Other messages are never listed.';
