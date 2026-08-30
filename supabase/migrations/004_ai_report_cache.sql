-- The AI commentary is a function of the dataset it was shown. Storing that
-- dataset's fingerprint lets a repeated request reuse the stored commentary
-- instead of paying for an identical one.
alter table ai_reports add column if not exists dataset_fingerprint text;
create index if not exists idx_ai_reports_fingerprint
  on ai_reports (owner_user_id, report_id, dataset_fingerprint);
