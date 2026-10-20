-- JAG call screener (screener.html): one row per screened call. Team only.
-- Logged in Follow Up Boss by the Supabase edge function "jag-screening-fub"
-- (new clients: unassigned, Calls pond, stage Applied, tags Screened + Ruta + #starling_stop).
-- Run once in Supabase → SQL Editor. Safe to run again.
create table if not exists public.jag_screenings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  screener text,
  client_name text not null,
  phone text,
  email text,
  lang text default 'es',
  lane text check (lane in ('listo','revision','prep')),
  answers jsonb not null default '{}'::jsonb,
  reasons jsonb not null default '[]'::jsonb,
  missing jsonb not null default '[]'::jsonb,
  note text,
  follow_at timestamptz,
  status text not null default 'nueva' check (status in ('nueva','revisada')),
  reviewed_at timestamptz,
  reviewed_by uuid,
  fub_status text not null default 'pending' check (fub_status in ('pending','sent','error')),
  fub_person_id bigint,
  fub_created boolean,
  fub_error text,
  fub_tries int not null default 0,
  fub_sent_at timestamptz
);
create index if not exists jag_screenings_created_idx on public.jag_screenings (created_at desc);
alter table public.jag_screenings enable row level security;

drop policy if exists "screenings: team reads" on public.jag_screenings;
create policy "screenings: team reads" on public.jag_screenings for select to authenticated using (public.jag_is_team());
drop policy if exists "screenings: team adds" on public.jag_screenings;
create policy "screenings: team adds" on public.jag_screenings for insert to authenticated with check (public.jag_is_team());
drop policy if exists "screenings: team updates" on public.jag_screenings;
create policy "screenings: team updates" on public.jag_screenings for update to authenticated using (public.jag_is_team()) with check (public.jag_is_team());
drop policy if exists "screenings: staff deletes" on public.jag_screenings;
create policy "screenings: staff deletes" on public.jag_screenings for delete to authenticated using (public.jag_is_staff());

revoke all on public.jag_screenings from anon;
grant select, insert, update, delete on public.jag_screenings to authenticated;

-- Optional: lets the edge function read the FUB key from Vault instead of an Edge Function secret.
create or replace function public.jag_fub_key() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'jag_fub_api_key' limit 1;
$$;
revoke all on function public.jag_fub_key() from public, anon, authenticated;
grant execute on function public.jag_fub_key() to service_role;

select 'jag_screenings ready' as ok;
