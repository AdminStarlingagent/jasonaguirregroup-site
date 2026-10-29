-- ============================================================
-- Lola's weekly listing emails to Houston-area leads (contacts without their own saved search).
--
--   jag_lead_alerts       one row per enrolled contact: status (pilot / active / paused / unsub / bounced), what to look
--                         for (criteria: max/min price, cities or ZIPs, beds), where it came from, what was already sent
--   jag_lead_alert_sends  every email sent (homes, Resend id, errors)
--   jag_kv                switches: { lola_listings: { paused, per_day } }
--
-- Who: email on file, not deleted, not in the Dallas / out-of-town / investor ponds or stages, not closed / past client /
--      sphere / unresponsive / listings, not tagged Bounced, Dallas, DFW or #starling_stop, and no saved search of their
--      own in the app (those already get alerts). Pilot = the 100 newest; once the pilot's first email is 6+ days old and
--      fewer than 5% unsubscribed or bounced, 300 more are added each day until everyone is in.
-- What: their budget from a call screening or Follow Up Boss, their top ZIP from the app; otherwise $150K-$300K across
--      the Houston area. Every email has "tell me what you want" (casas.html) and a one-click unsubscribe.
-- Sent by the lola-listings edge function (cron, mornings), from the assigned agent's name, replies to that agent.
-- ============================================================

create table if not exists public.jag_kv (k text primary key, v jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
alter table public.jag_kv enable row level security;
insert into public.jag_kv (k, v) values ('lola_listings', '{"paused": false, "per_day": 300}') on conflict (k) do nothing;

create table if not exists public.jag_lead_alerts (
  contact_id uuid primary key references public.jag_contacts(id) on delete cascade,
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  status text not null default 'pilot' check (status in ('pilot', 'active', 'paused', 'unsub', 'bounced')),
  criteria jsonb not null default '{}'::jsonb,
  criteria_src text,
  lang text check (lang in ('es', 'en')),
  last_sent_at timestamptz,
  first_sent_at timestamptz,
  sent_count int not null default 0,
  sent_mls text[] not null default '{}',
  claimed_at timestamptz,
  errors int not null default 0,
  last_error text,
  prefs_at timestamptz,
  unsub_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jag_lead_alerts_due on public.jag_lead_alerts (status, last_sent_at);
alter table public.jag_lead_alerts enable row level security;

create table if not exists public.jag_lead_alert_sends (
  id bigint generated always as identity primary key,
  contact_id uuid not null,
  sent_at timestamptz not null default now(),
  mls text[] not null default '{}',
  resend_id text,
  error text
);
create index if not exists jag_lead_alert_sends_c on public.jag_lead_alert_sends (contact_id, sent_at desc);
alter table public.jag_lead_alert_sends enable row level security;

-- the Houston-area cities Lola uses when we don't know where someone wants to live
create or replace function public.jag_lola_cities() returns text[] language sql immutable set search_path = '' as $$
  select array['Houston','Katy','Cypress','Spring','Humble','Tomball','Conroe','Pasadena','Baytown','Channelview','Missouri City','Sugar Land',
               'Richmond','Rosenberg','Pearland','League City','Crosby','Porter','New Caney','Splendora','Magnolia','Kingwood','La Porte','Deer Park'];
$$;

-- what to look for: a call screening's max price, else the FUB price; the app's top ZIP; else the Houston default
create or replace function public.jag_lola_criteria(p_contact uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare c public.jag_contacts; v_max numeric; v_src text; v_zip text;
begin
  select * into c from public.jag_contacts where id = p_contact;
  select max(s.est_max) into v_max from public.jag_screenings s
   where s.est_max > 50000 and ((c.email is not null and lower(btrim(s.email)) = c.email) or (c.phone is not null and public.jag_digits10(s.phone) = c.phone));
  if v_max is not null then v_src := 'screener';
  elsif coalesce(c.price, 0) between 60000 and 2000000 then v_max := c.price; v_src := 'fub';
  end if;
  select top_zip into v_zip from public.jag_client_scores where c.user_id is not null and user_id = c.user_id;
  if v_zip is not null then v_src := coalesce(v_src || '+app', 'app'); end if;
  if v_max is null then v_max := 300000; end if;
  return jsonb_build_object(
    'max', (round(v_max * 1.05 / 5000) * 5000)::int,
    'min', greatest(80000, (round(v_max * 0.55 / 5000) * 5000)::int),
    'beds', 2,
    'zips', case when v_zip is not null then jsonb_build_array(v_zip) else '[]'::jsonb end,
    'cities', case when v_zip is null then to_jsonb(public.jag_lola_cities()) else '[]'::jsonb end,
    'src', coalesce(v_src, 'default'));
end $function$;

-- add the next newest eligible contacts
create or replace function public.jag_lead_alerts_enroll(p_status text, p_limit int) returns int language plpgsql security definer set search_path = '' as $function$
declare v_n int;
begin
  with pick as (
    select c.id, c.lang, c.tags from public.jag_contacts c left join public.jag_fub_ponds p on p.id = c.pond_id
     where not c.deleted and c.email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'
       and coalesce(p.name, '') not in ('Out of town', 'Dallas Pond', 'Investors')
       and coalesce(c.stage, '') not in ('Out Of Town', 'Closed', 'Past Client', 'Sphere', 'Investor', 'Unresponsive', 'Listing agreement', 'Active listing', 'Trash')
       and not (c.tags && array['Bounced', 'Dallas', 'DFW', '#starling_stop'])
       and not exists (select 1 from public.jag_lead_alerts a where a.contact_id = c.id)
       and not (c.user_id is not null and exists (select 1 from public.jag_client_searches s where s.user_id = c.user_id))
     order by coalesce(c.fub_created, c.created_at) desc
     limit greatest(0, p_limit)
  ), ins as (
    insert into public.jag_lead_alerts (contact_id, status, criteria, criteria_src, lang)
    select k.id, p_status, public.jag_lola_criteria(k.id) - 'src', public.jag_lola_criteria(k.id)->>'src',
           case when k.lang = 'en' or 'English Speaker' = any(k.tags) then 'en' else 'es' end
      from pick k
    on conflict (contact_id) do nothing returning 1
  ) select count(*) into v_n from ins;
  return v_n;
end $function$;

-- once a day: after the pilot looks healthy, keep adding people (300 a day by default)
create or replace function public.jag_lead_alerts_ramp() returns json language plpgsql security definer set search_path = '' as $function$
declare cfg jsonb; v_today date := (now() at time zone 'America/Chicago')::date; v_first timestamptz; v_sent int; v_bad int; v_rate numeric; v_n int := 0;
begin
  select v into cfg from public.jag_kv where k = 'lola_listings';
  if coalesce((cfg->>'paused')::boolean, false) then return json_build_object('ok', true, 'paused', true); end if;
  if (cfg->>'ramped_on')::date = v_today then return json_build_object('ok', true, 'already', true); end if;
  select min(first_sent_at), count(*) filter (where first_sent_at is not null), count(*) filter (where status in ('unsub', 'bounced'))
    into v_first, v_sent, v_bad from public.jag_lead_alerts where criteria_src is distinct from 'test';
  if v_first is null or v_first > now() - interval '6 days' or v_sent < 50 then return json_build_object('ok', true, 'waiting', true, 'sent', v_sent); end if;
  v_rate := v_bad::numeric / greatest(v_sent, 1);
  if v_rate >= 0.05 then
    update public.jag_kv set v = v || jsonb_build_object('paused', true, 'paused_why', 'Pilot: ' || round(v_rate * 100, 1) || '% unsubscribed or bounced'), updated_at = now() where k = 'lola_listings';
    return json_build_object('ok', true, 'stopped', true, 'rate', v_rate);
  end if;
  update public.jag_lead_alerts set status = 'active', updated_at = now() where status = 'pilot';
  v_n := public.jag_lead_alerts_enroll('active', coalesce((cfg->>'per_day')::int, 300));
  update public.jag_kv set v = v || jsonb_build_object('ramped_on', v_today), updated_at = now() where k = 'lola_listings';
  return json_build_object('ok', true, 'added', v_n, 'rate', v_rate);
end $function$;

-- the sender claims a batch that's due (never emailed, or 7 days since the last one)
create or replace function public.jag_lead_alerts_claim(p_limit int default 50) returns json language plpgsql security definer set search_path = '' as $function$
declare v json;
begin
  if coalesce((select (v->>'paused')::boolean from public.jag_kv where k = 'lola_listings'), false) then return '[]'::json; end if;
  with due as (
    select a.contact_id from public.jag_lead_alerts a join public.jag_contacts c on c.id = a.contact_id
     where a.status in ('pilot', 'active') and not c.deleted and c.email is not null
       and (a.last_sent_at is null or a.last_sent_at < now() - interval '6 days 20 hours')
       and (a.claimed_at is null or a.claimed_at < now() - interval '20 minutes')
     order by a.last_sent_at nulls first, a.created_at
     limit least(greatest(p_limit, 1), 100)
     for update of a skip locked
  ), cl as (
    update public.jag_lead_alerts a set claimed_at = now() from due where a.contact_id = due.contact_id returning a.*
  )
  select coalesce(json_agg(json_build_object('contact_id', cl.contact_id, 'token', cl.token, 'criteria', cl.criteria, 'sent_mls', cl.sent_mls,
           'lang', cl.lang, 'first', cl.sent_count = 0, 'name', c.name, 'first_name', c.first_name, 'email', c.email,
           'agent', (select json_build_object('code', g.code, 'name', g.name, 'first_name', g.first_name, 'email', g.email,
                       'phone', coalesce(g.phone_override, g.phone), 'photo_url', g.photo_url)
                       from public.jag_agents g where g.code = coalesce((select x.code from public.jag_agents x where x.code = c.assigned_code and x.active), 'jason')))), '[]'::json)
    into v from cl join public.jag_contacts c on c.id = cl.contact_id;
  return v;
end $function$;

-- the sender reports back
create or replace function public.jag_lead_alert_done(p_contact uuid, p_mls text[], p_resend text, p_error text) returns void language plpgsql security definer set search_path = '' as $function$
declare a public.jag_lead_alerts;
begin
  select * into a from public.jag_lead_alerts where contact_id = p_contact;
  if a.contact_id is null then return; end if;
  insert into public.jag_lead_alert_sends (contact_id, mls, resend_id, error) values (p_contact, coalesce(p_mls, '{}'), p_resend, p_error);
  if p_error is not null then
    update public.jag_lead_alerts set claimed_at = null, errors = errors + 1, last_error = left(p_error, 300),
           status = case when errors + 1 >= 3 or p_error ~* 'invalid|bounce|suppress|not a valid' then 'bounced' else status end, updated_at = now()
     where contact_id = p_contact;
    return;
  end if;
  update public.jag_lead_alerts set claimed_at = null, errors = 0, last_error = null, last_sent_at = now(), first_sent_at = coalesce(first_sent_at, now()),
         sent_count = sent_count + 1, sent_mls = (coalesce(p_mls, '{}') || sent_mls)[1:300], updated_at = now()
   where contact_id = p_contact;
  if coalesce(array_length(p_mls, 1), 0) > 0 then
    insert into public.jag_contact_notes (contact_id, user_id, agent_code, author_name, kind, subject, meta)
    select c.id, c.user_id, c.assigned_code, 'Lola (AI)', 'system', 'Lola emailed ' || array_length(p_mls, 1) || ' homes (weekly picks)',
           jsonb_build_object('lola_listings', true, 'mls', to_jsonb(p_mls))
      from public.jag_contacts c where c.id = p_contact;
  end if;
end $function$;
-- nothing found for them this week: try again in a week without counting it as a send
create or replace function public.jag_lead_alert_skip(p_contact uuid) returns void language sql security definer set search_path = '' as $$
  update public.jag_lead_alerts set claimed_at = null, last_sent_at = now() - interval '3 days', updated_at = now() where contact_id = p_contact;
$$;

/* ---------- the lead's own page (casas.html?t=<token>): what they want, pause, unsubscribe ---------- */
create or replace function public.jag_lead_alert_get(p_token text) returns json language sql stable security definer set search_path = '' as $$
  select coalesce((select json_build_object('ok', true, 'first_name', coalesce(c.first_name, split_part(c.name, ' ', 1)), 'lang', a.lang,
      'status', a.status, 'criteria', a.criteria, 'cities', to_jsonb(public.jag_lola_cities()),
      'agent', (select json_build_object('name', g.name, 'first_name', g.first_name, 'phone', coalesce(g.phone_override, g.phone), 'photo_url', g.photo_url)
                  from public.jag_agents g where g.code = coalesce((select x.code from public.jag_agents x where x.code = c.assigned_code and x.active), 'jason')))
    from public.jag_lead_alerts a join public.jag_contacts c on c.id = a.contact_id where a.token = p_token and length(p_token) >= 24),
    json_build_object('ok', false));
$$;

create or replace function public.jag_lead_alert_set(p_token text, p jsonb) returns json language plpgsql security definer set search_path = '' as $function$
declare a public.jag_lead_alerts; c public.jag_contacts; v_cr jsonb; v_cities jsonb; v_max int; v_beds int; v_txt text;
begin
  if length(coalesce(p_token, '')) < 24 then return json_build_object('ok', false); end if;
  select * into a from public.jag_lead_alerts where token = p_token;
  if a.contact_id is null then return json_build_object('ok', false); end if;
  select * into c from public.jag_contacts where id = a.contact_id;
  if coalesce((p->>'unsub')::boolean, false) then
    if a.status <> 'unsub' then
      update public.jag_lead_alerts set status = 'unsub', unsub_at = now(), updated_at = now() where contact_id = a.contact_id;
      insert into public.jag_contact_notes (contact_id, user_id, agent_code, author_name, kind, subject)
      values (c.id, c.user_id, c.assigned_code, 'Lola (AI)', 'system', 'Unsubscribed from Lola''s weekly home emails');
    end if;
    return json_build_object('ok', true, 'status', 'unsub');
  end if;
  if coalesce((p->>'pause')::boolean, false) then
    update public.jag_lead_alerts set status = 'paused', updated_at = now() where contact_id = a.contact_id;
    return json_build_object('ok', true, 'status', 'paused');
  end if;
  -- what they want
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_cities from jsonb_array_elements_text(coalesce(p->'cities', '[]'::jsonb)) x where x = any(public.jag_lola_cities());
  v_max := case when (p->>'max') ~ '^\d{5,7}$' then (p->>'max')::int end;
  v_beds := case when (p->>'beds') ~ '^[1-5]$' then (p->>'beds')::int else 2 end;
  v_cr := jsonb_build_object('max', coalesce(v_max, (a.criteria->>'max')::int, 300000),
            'min', greatest(60000, (coalesce(v_max, (a.criteria->>'max')::int, 300000) * 0.5)::int),
            'beds', v_beds, 'zips', '[]'::jsonb,
            'cities', case when jsonb_array_length(v_cities) > 0 then v_cities else to_jsonb(public.jag_lola_cities()) end);
  update public.jag_lead_alerts set criteria = v_cr, criteria_src = 'client', prefs_at = now(),
         status = case when status in ('paused', 'unsub') then 'active' else status end, unsub_at = null,
         last_sent_at = case when coalesce((p->>'send_now')::boolean, false) then null else last_sent_at end, updated_at = now()
   where contact_id = a.contact_id;
  -- tell their agent: someone who says what they want is ready to talk
  v_txt := '🏡 ' || coalesce(c.name, 'A lead') || ' told Lola what they want: up to $' || to_char((v_cr->>'max')::int, 'FM999,999') || ', ' || v_beds || '+ beds' ||
           case when jsonb_array_length(v_cities) between 1 and 4 then ' in ' || (select string_agg(x, ', ') from jsonb_array_elements_text(v_cities) x) else ' around Houston' end ||
           '. Call them while they''re looking: https://jasonaguirregroup.company/workspace#hub=%23c%2F' || c.id::text;
  if c.assigned_code is not null then
    perform public.jag_notify_agent(c.assigned_code, 'lola_prefs', coalesce(c.name, 'A lead') || ' told Lola what they want',
      'Up to $' || to_char((v_cr->>'max')::int, 'FM999,999') || ' · ' || v_beds || '+ beds', c.id, null, v_txt);
  end if;
  insert into public.jag_contact_notes (contact_id, user_id, agent_code, author_name, kind, subject, meta)
  values (c.id, c.user_id, c.assigned_code, coalesce(c.name, 'Client'), 'system', 'Told Lola what they want: up to $' || to_char((v_cr->>'max')::int, 'FM999,999') || ', ' || v_beds || '+ beds',
          jsonb_build_object('lola_prefs', v_cr));
  return json_build_object('ok', true, 'status', 'active', 'criteria', v_cr);
end $function$;

/* ---------- admin: numbers + pause ---------- */
create or replace function public.jag_lead_alerts_stats() returns json language sql stable security definer set search_path = '' as $$
  select case when not public.jag_sees_all() then json_build_object('ok', false) else json_build_object('ok', true,
    'cfg', (select v from public.jag_kv where k = 'lola_listings'),
    'by_status', (select coalesce(json_object_agg(status, n), '{}'::json) from (select status, count(*) n from public.jag_lead_alerts where criteria_src is distinct from 'test' group by status) x),
    'sent_7d', (select count(*) from public.jag_lead_alert_sends where sent_at > now() - interval '7 days' and error is null),
    'errors_7d', (select count(*) from public.jag_lead_alert_sends where sent_at > now() - interval '7 days' and error is not null),
    'prefs', (select count(*) from public.jag_lead_alerts where prefs_at is not null),
    'unsub_7d', (select count(*) from public.jag_lead_alerts where unsub_at > now() - interval '7 days')) end;
$$;
create or replace function public.jag_lead_alerts_pause(p_paused boolean) returns json language plpgsql security definer set search_path = '' as $function$
begin
  if not public.jag_sees_all() then return json_build_object('ok', false); end if;
  update public.jag_kv set v = (v - 'paused_why') || jsonb_build_object('paused', p_paused), updated_at = now() where k = 'lola_listings';
  return json_build_object('ok', true, 'paused', p_paused);
end $function$;

revoke all on function public.jag_lola_criteria(uuid), public.jag_lead_alerts_enroll(text, int), public.jag_lead_alerts_ramp(),
  public.jag_lead_alerts_claim(int), public.jag_lead_alert_done(uuid, text[], text, text), public.jag_lead_alert_skip(uuid) from public, anon, authenticated;
grant execute on function public.jag_lead_alerts_ramp(), public.jag_lead_alerts_claim(int), public.jag_lead_alert_done(uuid, text[], text, text),
  public.jag_lead_alert_skip(uuid), public.jag_lead_alert_set(text, jsonb) to service_role;
revoke all on function public.jag_lead_alert_get(text), public.jag_lead_alert_set(text, jsonb) from public;
grant execute on function public.jag_lead_alert_get(text), public.jag_lead_alert_set(text, jsonb) to anon, authenticated;
revoke all on function public.jag_lead_alerts_stats(), public.jag_lead_alerts_pause(boolean) from public, anon;
grant execute on function public.jag_lead_alerts_stats(), public.jag_lead_alerts_pause(boolean) to authenticated;
