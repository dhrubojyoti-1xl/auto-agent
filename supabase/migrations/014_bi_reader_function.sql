-- Creating the read-only charting login, as a function.
--
-- The obvious way to do this from the application is a DO block with the
-- password bound as a parameter. It does not work: a DO block's body is a
-- string literal, so $1 inside it is never a placeholder, and Postgres reports
-- "bind message supplies 2 parameters, but prepared statement requires 0".
--
-- A function can take parameters. The password arrives as a real argument and
-- reaches the DDL through format(%L), which quotes it as a literal, so its
-- contents cannot become SQL however they are written. Concatenating it into a
-- statement instead is the thing this exists to avoid.
--
-- SECURITY DEFINER because creating a role needs more privilege than the
-- caller has, and the search_path is pinned so the function cannot be
-- redirected at a shadowed object.
create or replace function create_bi_reader(new_password text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
declare
  role_name constant text := 'bi_reader';
  v         text;
begin
  if new_password is null or length(new_password) < 12 then
    raise exception 'The password must be at least 12 characters';
  end if;

  if exists (select 1 from pg_roles where rolname = role_name) then
    execute format('alter role %I with login password %L', role_name, new_password);
  else
    execute format('create role %I with login password %L', role_name, new_password);
  end if;

  execute format('grant connect on database %I to %I', current_database(), role_name);
  execute format('grant usage on schema public to %I', role_name);

  -- Everything is revoked first, so a grant made by an earlier version of this
  -- function cannot survive into a narrower one.
  execute format('revoke all on all tables in schema public from %I', role_name);
  execute format('revoke all on schema public from %I', role_name);
  execute format('grant usage on schema public to %I', role_name);

  foreach v in array array['bi_tasks', 'bi_daily_by_department', 'bi_messages'] loop
    execute format('grant select on %I to %I', v, role_name);
  end loop;
end;
$fn$;

comment on function create_bi_reader(text) is
  'Creates or re-passwords the read-only login a charting tool connects with. '
  'Grants SELECT on the three bi_ views and nothing else.';

-- Only the application's own database user may call it.
revoke all on function create_bi_reader(text) from public;
