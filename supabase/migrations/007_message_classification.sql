-- Every message the assistant looks at should end with a decision somebody can
-- read: what it was judged to be, how sure that judgement was, and what the
-- judgement rested on. Without it, "0 reports found" is the only thing a
-- manager ever learns, and it explains nothing.
alter table documents add column if not exists classification text;
alter table documents add column if not exists confidence numeric;
alter table documents add column if not exists evidence text;

create index if not exists idx_documents_classification
  on documents (owner_user_id, classification);
