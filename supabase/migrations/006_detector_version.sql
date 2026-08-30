-- A message the assistant decided was not a report is never examined again:
-- that is what makes a daily sync cheap and idempotent. But it also means that
-- when detection improves, every message judged by the older code stays judged.
--
-- A real report arrived as a Google Sheets link, was scanned before links were
-- followed, and was recorded as "not a report". Adding link support could not
-- reach it — the message was already marked seen, for ever.
--
-- Recording which version of the detector made the decision lets a smarter
-- detector reconsider its predecessor's rejections exactly once.
alter table documents add column if not exists detector_version int not null default 0;
create index if not exists idx_documents_detector
  on documents (owner_user_id, processing_status, detector_version);
