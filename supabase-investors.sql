-- Investor portal (invite only): flip / wholesale deal analyzer at jasonaguirregroup.company/invest.
-- Applied as migrations jag_investor_portal + jag_investor_menu. Engine: edge function jag-invest
-- (RentCast property record + value estimate, HAR sold comps via Repliers, worst/mid/best ARV).
-- Lola's review: n8n "JAG Investor · Lola deal review" (webhook jag-invest-lola, X-JAG-Ops-Secret).
-- Invite email: jag-client-email kind 'investor_invite'. RentCast key: vault secret jag_rentcast_key.
create table if not exists public.jag_investors (
  id bigint generated always as identity primary key,
  email text not null, name text,
  user_id uuid,
  active boolean not null default true,
  runs_per_day int not null default 40,
  invited_by text, created_at timestamptz not null default now(), accepted_at timestamptz,
  email_sent_at timestamptz, email_error text, note text
);
create unique index if not exists jag_investors_email on public.jag_investors (lower(email));
alter table public.jag_investors enable row level security;
do $$ begin create policy "staff reads investors" on public.jag_investors for select using (public.jag_is_staff()); exception when duplicate_object then null; end $$;

create table if not exists public.jag_investor_runs (
  id bigint generated always as identity primary key,
  user_id uuid not null, address text not null,
  input jsonb, result jsonb, deal jsonb, lola text, lola_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists jag_investor_runs_user on public.jag_investor_runs (user_id, created_at desc);
alter table public.jag_investor_runs enable row level security;
do $$ begin create policy "investor reads own runs" on public.jag_investor_runs for select using (user_id = auth.uid()); exception when duplicate_object then null; end $$;
do $$ begin create policy "staff reads runs" on public.jag_investor_runs for select using (public.jag_is_staff()); exception when duplicate_object then null; end $$;

-- the signed-in person's investor access (links their account on first visit)
create or replace function public.jag_investor_me()
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_email text := lower(coalesce(auth.jwt()->>'email', '')); i public.jag_investors;
begin
  if v_uid is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  select * into i from public.jag_investors where (user_id = v_uid or lower(email) = v_email) and active order by user_id is null limit 1;
  if i.id is null then return json_build_object('ok', false, 'reason', 'not_invited'); end if;
  if i.user_id is null or i.accepted_at is null then update public.jag_investors set user_id = v_uid, accepted_at = coalesce(accepted_at, now()) where id = i.id; end if;
  return json_build_object('ok', true, 'name', i.name, 'runs_left', greatest(0, i.runs_per_day - (select count(*) from public.jag_investor_runs r where r.user_id = v_uid and r.created_at > now() - interval '24 hours')),
    'runs', coalesce((select json_agg(json_build_object('id', r.id, 'address', r.address, 'at', r.created_at, 'mid', r.result->'arv'->'mid', 'profit', r.deal->'mid'->'profit') order by r.id desc)
      from (select * from public.jag_investor_runs where user_id = v_uid order by id desc limit 25) r), '[]'::json));
end $$;
revoke all on function public.jag_investor_me() from public, anon;
grant execute on function public.jag_investor_me() to authenticated;

-- the account menu shows "Portal de inversionista" only to invited, active investors
create or replace function public.jag_is_investor()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (select 1 from public.jag_investors i
    where i.active and (i.user_id = auth.uid() or lower(i.email) = lower(coalesce(auth.jwt()->>'email', ''))));
$$;
revoke all on function public.jag_is_investor() from public, anon;
grant execute on function public.jag_is_investor() to authenticated;

-- one saved analysis (the investor's own), without the cached RentCast record
create or replace function public.jag_investor_run(p_id bigint)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce((select json_build_object('ok', true, 'id', r.id, 'address', r.address, 'at', r.created_at, 'input', r.input, 'result', r.result - 'rc', 'deal', r.deal, 'lola', r.lola, 'lola_at', r.lola_at)
    from public.jag_investor_runs r where r.id = p_id and r.user_id = auth.uid()), json_build_object('ok', false));
$$;
revoke all on function public.jag_investor_run(bigint) from public, anon;
grant execute on function public.jag_investor_run(bigint) to authenticated;

-- the investor's numbers (calculator inputs + results) saved with the run
create or replace function public.jag_investor_save_deal(p_id bigint, p_deal jsonb)
returns json language sql security definer set search_path = '' as $$
  update public.jag_investor_runs set deal = p_deal where id = p_id and user_id = auth.uid() returning json_build_object('ok', true);
$$;
revoke all on function public.jag_investor_save_deal(bigint, jsonb) from public, anon;
grant execute on function public.jag_investor_save_deal(bigint, jsonb) to authenticated;

-- staff: invite / list / turn off
create or replace function public.jag_investor_admin_list()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(public.jag_is_staff(), false) then return json_build_object('ok', false, 'reason', 'not_staff'); end if;
  return json_build_object('ok', true, 'investors', coalesce((select json_agg(json_build_object('id', i.id, 'email', i.email, 'name', i.name, 'active', i.active,
      'invited_at', i.created_at, 'accepted_at', i.accepted_at, 'email_error', i.email_error,
      'runs', (select count(*) from public.jag_investor_runs r where r.user_id = i.user_id),
      'last_run', (select max(created_at) from public.jag_investor_runs r where r.user_id = i.user_id)) order by i.created_at desc)
    from public.jag_investors i), '[]'::json));
end $$;

create or replace function public.jag_investor_invite(p_email text, p_name text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_id bigint;
begin
  if not coalesce(public.jag_is_staff(), false) then return json_build_object('ok', false, 'reason', 'not_staff'); end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then return json_build_object('ok', false, 'reason', 'email'); end if;
  insert into public.jag_investors (email, name, invited_by) values (v_email, nullif(btrim(coalesce(p_name, '')), ''), auth.jwt()->>'email')
  on conflict (lower(email)) do update set active = true, name = coalesce(excluded.name, public.jag_investors.name)
  returning id into v_id;
  update public.jag_investors set email_sent_at = now(), email_error = null where id = v_id;
  begin perform ops.kick_client_email('investor_invite', v_id); exception when others then null; end;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.jag_investor_set_active(p_id bigint, p_active boolean)
returns json language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.jag_is_staff(), false) then return json_build_object('ok', false, 'reason', 'not_staff'); end if;
  update public.jag_investors set active = p_active where id = p_id;
  return json_build_object('ok', found);
end $$;
revoke all on function public.jag_investor_admin_list() from public, anon;
revoke all on function public.jag_investor_invite(text, text) from public, anon;
revoke all on function public.jag_investor_set_active(bigint, boolean) from public, anon;
grant execute on function public.jag_investor_admin_list() to authenticated;
grant execute on function public.jag_investor_invite(text, text) to authenticated;
grant execute on function public.jag_investor_set_active(bigint, boolean) to authenticated;

-- server side only: the RentCast key from the vault (the key itself is never in the repo)
create or replace function public.jag_rentcast_key()
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'jag_rentcast_key' limit 1;
$$;
revoke all on function public.jag_rentcast_key() from public, anon, authenticated;
grant execute on function public.jag_rentcast_key() to service_role;
