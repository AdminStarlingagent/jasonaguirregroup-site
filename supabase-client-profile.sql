-- Admin client profile (admin.html): one view of a person by email/phone — their home-search account,
-- saved searches (theirs and the ones the team set up), saved homes, alerts, homes the team sent, and the
-- Follow Up Boss person. The team can turn a search's alert emails on/off or take a search away.
-- Writes that need an auth account (setting up alerts for a loan-app client) go through jag-client-hub.
-- (applied as migration jag_client_profile, 2026-10-27; jag_person_search_remove via SQL editor)

create table if not exists public.jag_homes_sent (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  agent_code text, sent_by text,
  email text, phone text, user_id uuid,
  channel text not null check (channel in ('email', 'text', 'app')),
  mls text[] not null default '{}', label text, note text, link text
);
create index if not exists jag_homes_sent_email on public.jag_homes_sent (lower(email), created_at desc);
alter table public.jag_homes_sent enable row level security;
do $$ begin create policy "team reads homes sent" on public.jag_homes_sent for select using (public.jag_is_team()); exception when duplicate_object then null; end $$;

create or replace function public.jag_digits10(p text)
returns text language sql immutable set search_path = '' as $$
  select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10);
$$;

-- everything the profile shows about one person
create or replace function public.jag_person(p_email text default null, p_phone text default null)
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_email text := nullif(lower(btrim(coalesce(p_email, ''))), ''); v_ph text := nullif(public.jag_digits10(p_phone), '');
  c public.jag_clients; v_fub bigint;
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if v_ph is not null and length(v_ph) < 10 then v_ph := null; end if;
  if v_email is null and v_ph is null then return json_build_object('ok', false, 'reason', 'empty'); end if;
  select * into c from public.jag_clients x where (v_email is not null and lower(x.email) = v_email)
    or (v_ph is not null and public.jag_digits10(x.phone) = v_ph) order by (lower(x.email) = v_email) desc nulls last limit 1;
  -- Follow Up Boss person: account sync, call screening, or a lead row that already links it
  v_fub := coalesce(
    (select max(q.fub_person_id) from public.jag_fub_queue q where c.user_id is not null and q.user_id = c.user_id),
    (select max(s.fub_person_id) from public.jag_screenings s where (v_email is not null and lower(s.email) = v_email) or (v_ph is not null and public.jag_digits10(s.phone) = v_ph)),
    (select max(substring(l.payload->>'Follow Up Boss' from '/view/([0-9]+)')::bigint) from public.jag_leads l
      where l.payload ? 'Follow Up Boss' and ((v_email is not null and lower(l.email) = v_email) or (v_ph is not null and public.jag_digits10(l.phone) = v_ph))));
  return json_build_object('ok', true, 'fub_person_id', v_fub,
    'investor', exists (select 1 from public.jag_investors i where i.active and v_email is not null and lower(i.email) = v_email),
    'account', case when c.user_id is null then null else json_build_object(
        'user_id', c.user_id, 'email', c.email, 'name', c.name, 'phone', c.phone, 'lang', c.lang, 'created_at', c.created_at, 'last_seen_at', c.last_seen_at,
        'alert_freq', c.alert_freq, 'notify', c.notify, 'paused_by_staff', c.paused_by_staff, 'staff_note', c.staff_note, 'agent_code', c.agent_code,
        'agent_name', (select a.name from public.jag_agents a where a.code = c.agent_code),
        'score', (select row_to_json(s) from public.jag_client_scores s where s.user_id = c.user_id)) end,
    'searches', coalesce((select json_agg(json_build_object('id', s.id, 'label', s.label, 'params', s.params, 'alerts', s.alerts, 'created_at', s.created_at,
        'by', s.params->>'by', 'matches', (select count(*) from public.jag_client_alerts l where l.search_id = s.id)) order by s.created_at desc)
      from public.jag_client_searches s where c.user_id is not null and s.user_id = c.user_id), '[]'::json),
    'favorites', coalesce((select json_agg(f order by f.saved_at desc) from (select mls, snap, last_price, last_status, saved_at from public.jag_client_favorites
      where c.user_id is not null and user_id = c.user_id order by saved_at desc limit 12) f), '[]'::json),
    'alerts', coalesce((select json_agg(l order by l.created_at desc) from (select kind, mls, detail, created_at, emailed_at from public.jag_client_alerts
      where c.user_id is not null and user_id = c.user_id order by created_at desc limit 30) l), '[]'::json),
    'activity', coalesce((select json_agg(a order by a.created_at desc) from (select kind, mls, zip, city, price, beds, created_at from public.jag_client_activity
      where c.user_id is not null and user_id = c.user_id order by created_at desc limit 30) a), '[]'::json),
    'sent', coalesce((select json_agg(h order by h.created_at desc) from (select created_at, channel, mls, label, note, sent_by from public.jag_homes_sent h
      where (v_email is not null and lower(h.email) = v_email) or (c.user_id is not null and h.user_id = c.user_id)
         or (v_ph is not null and public.jag_digits10(h.phone) = v_ph) order by created_at desc limit 30) h), '[]'::json));
end $$;
revoke all on function public.jag_person(text, text) from public, anon;
grant execute on function public.jag_person(text, text) to authenticated;

-- a text the agent sends from their own phone (sms: link) is logged here so the profile shows it
create or replace function public.jag_homes_sent_log(p jsonb)
returns json language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  insert into public.jag_homes_sent (agent_code, sent_by, email, phone, user_id, channel, mls, label, note, link)
  values (public.jag_agent_code_me(), auth.jwt()->>'email', nullif(lower(btrim(coalesce(p->>'email', ''))), ''), nullif(public.jag_digits10(p->>'phone'), ''),
    (select user_id from public.jag_clients where lower(email) = lower(p->>'email') limit 1),
    case when p->>'channel' in ('email', 'text', 'app') then p->>'channel' else 'text' end,
    coalesce((select array_agg(left(x, 24)) from jsonb_array_elements_text(coalesce(p->'mls', '[]'::jsonb)) x), '{}'),
    left(p->>'label', 200), left(p->>'note', 1000), left(p->>'link', 600))
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.jag_homes_sent_log(jsonb) from public, anon;
grant execute on function public.jag_homes_sent_log(jsonb) to authenticated;

-- turn one search's alert emails on/off
create or replace function public.jag_person_search_alerts(p_id uuid, p_on boolean)
returns json language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  update public.jag_client_searches set alerts = coalesce(p_on, false), last_checked_at = case when p_on then now() else last_checked_at end where id = p_id;
  return json_build_object('ok', found);
end $$;
revoke all on function public.jag_person_search_alerts(uuid, boolean) from public, anon;
grant execute on function public.jag_person_search_alerts(uuid, boolean) to authenticated;

-- the team's client list leaves investors out (they live in the Investor portal panel)
create or replace function public.jag_staff_clients()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.jag_is_staff() then return json_build_object('ok', false, 'reason', 'not_allowed'); end if;
  return json_build_object('ok', true, 'clients', coalesce((
    select json_agg(x order by x.last_seen_at desc) from (
      select c.user_id, c.email, c.name, c.phone, c.lang, c.alert_freq, c.created_at, c.last_seen_at,
             c.paused_by_staff, c.staff_note, c.lead_id, c.agent_code,
             (select count(*) from public.jag_client_favorites f where f.user_id = c.user_id) as favorites,
             (select count(*) from public.jag_client_searches s where s.user_id = c.user_id) as searches,
             (select count(*) from public.jag_client_activity a where a.user_id = c.user_id and a.kind = 'view' and a.created_at > now() - interval '30 days') as views_30d,
             (select count(*) from public.jag_client_alerts l where l.user_id = c.user_id) as alerts,
             (select max(l.emailed_at) from public.jag_client_alerts l where l.user_id = c.user_id) as last_emailed_at,
             (select array_agg(distinct z) from (select a.zip as z from public.jag_client_activity a
                where a.user_id = c.user_id and a.zip is not null order by a.zip limit 8) zz) as zips
        from public.jag_clients c
       where not exists (select 1 from public.jag_investors i where i.active and (i.user_id = c.user_id or lower(i.email) = lower(c.email)))) x), '[]'::json),
    'investor_emails', coalesce((select json_agg(lower(i.email)) from public.jag_investors i where i.active), '[]'::json));
end $$;

-- take away one saved search (applied with the SQL editor; the migration tool refuses this keyword)
-- create or replace function public.jag_person_search_remove(p_id uuid)
-- returns json language plpgsql security definer set search_path = '' as $$
-- begin
--   if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
--   delete from public.jag_client_searches where id = p_id;
--   return json_build_object('ok', found);
-- end $$;
-- revoke all on function public.jag_person_search_remove(uuid) from public, anon;
-- grant execute on function public.jag_person_search_remove(uuid) to authenticated;
