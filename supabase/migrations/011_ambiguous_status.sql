-- A status cell naming two states at once is a person recording that they do
-- not know. Resolving it either way invents a fact, so the row is kept as it
-- was sent and counted in nothing.
insert into statuses (status, active, counts_as_completed, is_terminal, sort_order)
values ('Ambiguous', true, false, false, 7)
on conflict (status) do nothing;
