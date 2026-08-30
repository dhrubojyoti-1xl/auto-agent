-- Deciding whether a message is worth opening, before anything expensive
-- happens to it.
--
-- Rules live in a table rather than in code so they can be tuned against a
-- real mailbox without a deploy. They contain no names, no companies and no
-- addresses: a rule that mentions a particular sender is a rule that stops
-- working for the next client.
create table if not exists prefilter_rules (
  rule_id     text primary key,
  signal      text not null,          -- what is being looked for
  kind        text not null,          -- header | body | subject | sender | attachment | structure
  pattern     text,                   -- regex or token list, interpreted per kind
  weight      int  not null,
  cap         int,                    -- most this signal may contribute in total
  active      boolean not null default true,
  note        text
);

alter table documents add column if not exists prefilter_score int;
alter table documents add column if not exists prefilter_signals text;

insert into prefilter_rules (rule_id, signal, kind, pattern, weight, cap, note) values
  ('pos-spreadsheet',  'spreadsheet attached',      'attachment', 'xlsx|xlsm|csv|tsv|ods',  3, null, 'A spreadsheet is the commonest report carrier'),
  ('pos-html-table',   'table in the body',         'structure',  'table>=3x2',             3, null, 'Three rows and two columns is a table, not a layout'),
  ('pos-sheets-link',  'Google Sheets link',        'body',       'docs\.google\.com/spreadsheets', 3, null, null),
  ('pos-image',        'image attached',            'attachment', 'png|jpg|jpeg|gif|webp',  2, null, 'Might be a screenshot of a table'),
  ('pos-work-vocab',   'work vocabulary',           'body',       'task|activity|work|assignment|deliverable|progress|status|completed|pending|update|report|daily', 1, 4, null),
  ('pos-dept-vocab',   'department vocabulary',     'body',       'department|team|division|unit',  2, null, null),
  ('pos-tenant-domain','sender is a colleague',     'sender',     'tenant-domain',          2, null, null),
  ('pos-roster',       'sender is on the roster',   'sender',     'roster',                 3, null, null),
  ('pos-thread',       'thread produced a report',  'sender',     'thread-history',         4, null, null),
  ('pos-self',         'sent by the mailbox owner',  'sender',     'self',                   3, null, 'People mail reports to themselves'),
  ('neg-unsubscribe-h','bulk mail header',          'header',     'list-unsubscribe',      -6, null, 'Only bulk senders set this'),
  ('neg-commerce',     'commerce vocabulary',       'body',       'price|invoice|sku|qty|order value|subtotal|amount due|gst|vat|checkout', -2, -6, null),
  ('neg-noreply',      'no-reply sender',           'sender',     'noreply|no-reply|donotreply|do-not-reply', -3, null, null),
  ('neg-category',     'promotions or social',      'header',     'category_promotions|category_social|category_forums', -4, null, null),
  ('neg-unsub-body',   'unsubscribe language',      'body',       'unsubscribe|view in browser|manage preferences|email preferences', -3, null, null)
on conflict (rule_id) do nothing;

-- The thread a message belonged to, so a thread that has produced a report
-- before counts in favour of the next message on it.
alter table documents add column if not exists gmail_thread_id text;
create index if not exists idx_documents_thread on documents (owner_user_id, gmail_thread_id);
