-- ============================================================
-- Every showing request alerts the WHOLE team (Jason's call, Oct 30 2026: "for now anyone that books a showing
-- the whole team gets an alert") and lands in Follow Up Boss — signed-in clients AND website visitors.
--   · Visitors who ask for a tour on a listing (jag_leads type 'home-search', Request 'Tour request') now also
--     become a jag_showing_requests row (no account: user_id null, their name/phone/email in `visitor`).
--   · n8n "JAG Site · Showing requests" picks both up (8 AM–8 PM CT): FUB Property Inquiry event + Showing task +
--     note, then Lola texts everyone in ops_showing_alert_team() (all active team members with a mobile).
--   · The team email for visitor requests (jag_leads_email) stays as it is.
-- ============================================================
alter table public.jag_showing_requests alter column user_id drop not null;
alter table public.jag_showing_requests add column if not exists visitor jsonb;
alter table public.jag_showing_requests add column if not exists lead_id uuid;

-- who gets showing texts: the whole team (active, with a mobile), lead_alerts or not
create or replace function public.ops_showing_alert_team()
returns json language sql stable security definer set search_path to '' as $$
  select coalesce(json_agg(json_build_object('member_id', t.id, 'name', t.name, 'fub_user_id', t.fub_user_id, 'mobile', t.mobile_e164) order by t.id), '[]'::json)
    from ops.team t where t.active and t.mobile_e164 is not null;
$$;
revoke all on function public.ops_showing_alert_team() from public, anon, authenticated;
grant execute on function public.ops_showing_alert_team() to service_role;

-- n8n's queue: clients and visitors
create or replace function public.jag_showing_pending(p_limit integer default 10)
returns json language sql stable security definer set search_path to '' as $$
  select coalesce(json_agg(x order by x.id), '[]'::json) from (
    select r.id, r.created_at, r.mls, r.home, r.times, r.note,
           coalesce(c.email, r.visitor->>'email') as email, coalesce(c.name, r.visitor->>'name') as name,
           coalesce(c.phone, r.visitor->>'phone') as phone, coalesce(c.lang, r.visitor->>'lang') as lang,
           (r.user_id is null) as visitor,
           a.code as agent_code, a.name as agent_name, a.first_name as agent_first, a.fub_user_id as agent_fub_user_id,
           t.id as agent_member_id, t.mobile_e164 as agent_mobile
      from public.jag_showing_requests r
      left join public.jag_clients c on c.user_id = r.user_id
      left join public.jag_agents a on a.code = r.agent_code
      left join ops.team t on t.fub_user_id = a.fub_user_id and t.active and t.mobile_e164 is not null
     where r.sent_at is null and r.tries < 5
       and (r.user_id is not null or r.visitor is not null)
       and extract(hour from now() at time zone 'America/Chicago') between 8 and 19
     order by r.id limit greatest(1, least(coalesce(p_limit, 10), 25))) x;
$$;

-- admin list shows visitors too
create or replace function public.jag_showing_list(p_days integer default 30)
returns json language plpgsql stable security definer set search_path to '' as $$
begin
  if not coalesce(public.jag_is_team(), false) then return '[]'::json; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select r.id, r.created_at, r.mls, r.home, r.times, r.note, r.sent_at, r.error, r.handled_at, r.handled_by, r.fub_person_id,
           coalesce(c.name, r.visitor->>'name') as name, coalesce(c.email, r.visitor->>'email') as email,
           coalesce(c.phone, r.visitor->>'phone') as phone, coalesce(c.lang, r.visitor->>'lang') as lang,
           (r.user_id is null) as visitor, r.agent_code, a.first_name as agent_first
      from public.jag_showing_requests r left join public.jag_clients c on c.user_id = r.user_id
      left join public.jag_agents a on a.code = r.agent_code
     where r.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
     order by r.created_at desc limit 200) x);
end $$;

-- a visitor's tour request on a listing → a showing request
create or replace function public.jag_leads_showing_trg()
returns trigger language plpgsql security definer set search_path to '' as $$
declare p jsonb := coalesce(new.payload, '{}'::jsonb); v_code text; v_when text; v_price numeric; v_ph text;
begin
  if new.type <> 'home-search' or coalesce(p->>'Request', '') <> 'Tour request' then return null; end if;
  v_ph := right(regexp_replace(coalesce(new.phone, p->>'Phone', ''), '\D', '', 'g'), 10);
  if length(v_ph) < 10 and coalesce(new.email, p->>'Email', '') = '' then return null; end if;
  -- the agent whose page/link they came from, else the default agent
  select a.code into v_code from public.jag_agents a where a.active and p->>'Agent' is not null and lower(a.name) = lower(p->>'Agent') limit 1;
  v_code := coalesce(v_code, (select a.code from public.jag_agents a where a.active and a.code = coalesce(ops.s_text('default_agent'), 'jason')), 'jason');
  v_when := nullif(btrim(concat_ws(' · ', nullif(regexp_replace(coalesce(p->>'Preferred Day', ''), ', \d{4}$', ''), ''), nullif(p->>'Preferred Time', ''))), '');
  v_price := case when (p->>'List Price') ~ '^\d{1,10}(\.\d+)?$' then (p->>'List Price')::numeric end;
  insert into public.jag_showing_requests (user_id, agent_code, mls, home, times, note, visitor, lead_id)
  values (null, v_code, left(nullif(btrim(coalesce(p->>'MLS #', '')), ''), 30),
          jsonb_strip_nulls(jsonb_build_object('addr', left(split_part(coalesce(p->>'Property', ''), ',', 1), 160),
            'city', nullif(btrim(split_part(coalesce(p->>'Property', ''), ',', 2)), ''),
            'zip', substring(coalesce(p->>'Property', '') from '(\d{5})\s*$'), 'price', v_price)),
          jsonb_build_array(coalesce(v_when, 'Any time (call to set it up)')),
          left(nullif(btrim(coalesce(p->>'Message', '')), ''), 500),
          jsonb_strip_nulls(jsonb_build_object('name', left(coalesce(new.name, p->>'__name'), 120), 'phone', nullif(v_ph, ''),
            'email', nullif(lower(btrim(coalesce(new.email, p->>'Email', ''))), ''),
            'lang', case when coalesce(new.lang, p->>'Preferred Language', '') ilike 'en%' then 'en' else 'es' end)),
          new.id);
  begin perform ops.kick_showing(); exception when others then null; end;   -- the 5-minute timer is the fallback
  return null;
exception when others then return null;   -- never block the lead itself
end $$;
create or replace trigger jag_leads_showing after insert on public.jag_leads for each row execute function public.jag_leads_showing_trg();
