-- ============================================================
-- JAG CRM — admin fix. Run ONCE in Supabase → SQL Editor → New query.
-- Safe to run again (run it again if you ran an earlier version). Does three things:
--   1) adds the column that stores an edited "estimated qualifying amount"
--   2) re-asserts that every signed-in team member can read AND update leads
--      (status, notes, estimate), in case the live table drifted from supabase-setup.sql
--   3) adds the "Delete this client" function for every signed-in team member.
-- ============================================================

alter table public.jag_leads add column if not exists est_amount numeric;

grant select, update on public.jag_leads to authenticated;

alter table public.jag_leads enable row level security;

drop policy if exists "admins can read leads"   on public.jag_leads;
create policy "admins can read leads"   on public.jag_leads for select to authenticated using (true);

drop policy if exists "admins can update leads" on public.jag_leads;
create policy "admins can update leads" on public.jag_leads for update to authenticated using (true) with check (true);

-- ------------------------------------------------------------
-- Delete a client from the admin page. Any signed-in team member can delete.
-- ------------------------------------------------------------
create or replace function public.jag_delete_lead(p_lead_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'reason', 'not_allowed');
  end if;

  -- the encrypted SSN / ITIN goes with the client
  if to_regclass('public.jag_lead_secure') is not null then
    execute 'delete from public.jag_lead_secure where lead_id = $1' using p_lead_id;
  end if;

  -- lender links and their access log are removed by the table's own cascade
  delete from public.jag_leads where id = p_lead_id;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;
  return json_build_object('ok', true);
end $$;

revoke all on function public.jag_delete_lead(uuid) from public, anon;
grant execute on function public.jag_delete_lead(uuid) to authenticated;

-- tell the API about the new column right away
notify pgrst, 'reload schema';

-- ---------- self-check: every line should say true ----------
select 'est_amount column exists' as check, exists(
  select 1 from information_schema.columns
   where table_schema='public' and table_name='jag_leads' and column_name='est_amount') as ok
union all
select 'team can update leads (grant)', has_table_privilege('authenticated','public.jag_leads','UPDATE')
union all
select 'team can update leads (policy)', exists(
  select 1 from pg_policies where schemaname='public' and tablename='jag_leads' and cmd='UPDATE' and 'authenticated' = any(roles))
union all
select 'delete function exists', to_regprocedure('public.jag_delete_lead(uuid)') is not null
union all
select 'no trigger rewrites leads', not exists(
  select 1 from pg_trigger where tgrelid='public.jag_leads'::regclass and not tgisinternal);
