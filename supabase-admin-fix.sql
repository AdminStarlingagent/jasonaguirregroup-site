-- ============================================================
-- JAG CRM — admin fix. Run ONCE in Supabase → SQL Editor → New query.
-- Safe to run again. Does two things:
--   1) adds the column that stores an edited "estimated qualifying amount"
--   2) re-asserts that every signed-in team member can read AND update leads
--      (status, notes, estimate), in case the live table drifted from supabase-setup.sql
-- ============================================================

alter table public.jag_leads add column if not exists est_amount numeric;

grant select, update on public.jag_leads to authenticated;

alter table public.jag_leads enable row level security;

drop policy if exists "admins can read leads"   on public.jag_leads;
create policy "admins can read leads"   on public.jag_leads for select to authenticated using (true);

drop policy if exists "admins can update leads" on public.jag_leads;
create policy "admins can update leads" on public.jag_leads for update to authenticated using (true) with check (true);

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
select 'no trigger rewrites leads', not exists(
  select 1 from pg_trigger where tgrelid='public.jag_leads'::regclass and not tgisinternal);
