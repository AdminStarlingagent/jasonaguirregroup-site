-- ============================================================
-- Showing agents, client tours, feedback and client offers. (applied as migration jag_showings, 2026-10-28)
--
--  Team jobs (jag_agents.roles, set by Jason in admin → Team access):
--    lead      works clients, can send a client to a showing agent
--    showing   showing agent: gets tours, books them, sends the schedule
--    screener  uses the call screener
--    tc        transaction coordinator: prepares offers (René)
--    offer_ok  approves client offers before they go out for signatures
--  Admin access (jag_staff) stays a separate switch and counts as "lead".
--
--  Flow: a lead agent sends a pre-approved client to a showing agent → the client picks saved homes + a day/time
--  ("Planear mi recorrido") → Lola texts the showing agent → she books each home (Requested / Asked / Confirmed / Declined,
--  time, order) and sends the schedule → the client gets a text + email with a tour page (tour#token) → after each
--  showing, a text asks for quick feedback → hot feedback texts the showing + lead agent → the client can make an offer
--  from the tour page → René prepares it (checklist), Katherine/Jason/showing agent are texted, closings@ is emailed,
--  and it can't go out for signatures until someone with "offer_ok" replies OK <n>.
--  Client texts come from the JAG line (A2P): only clients who opted in, never after an opt-out, only in Texas texting hours.
-- ============================================================

-- ---------- team jobs ----------
alter table public.jag_agents add column if not exists roles text[] not null default '{}';
update public.jag_agents set roles = case code
    when 'jason' then array['lead','screener','offer_ok'] when 'katherine' then array['lead','screener','offer_ok']
    when 'veronica' then array['screener'] when 'martha' then array['screener'] when 'adriana' then array['screener']
    when 'monica' then array['showing'] when 'rene' then array['tc'] else roles end
 where roles = '{}';

create or replace function public.jag_roles_me()
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce((select roles from public.jag_agents where active and user_id = auth.uid() limit 1), '{}'::text[]);
$$;
-- admin access counts as "lead"
create or replace function public.jag_has_role(p_role text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_role = any(public.jag_roles_me()) or (p_role = 'lead' and public.jag_is_staff());
$$;
create or replace function ops.member_has_role(p_member int, p_role text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from ops.team t join public.jag_agents a on a.fub_user_id = t.fub_user_id and a.active
                  where t.id = p_member and p_role = any(a.roles));
$$;
create or replace function ops.members_with_role(p_role text)
returns setof int language sql stable security definer set search_path = '' as $$
  select t.id from public.jag_agents a join ops.team t on t.fub_user_id = a.fub_user_id and t.active where a.active and p_role = any(a.roles);
$$;

create or replace function public.jag_set_roles(p_code text, p_roles text[])
returns json language plpgsql security definer set search_path = '' as $function$
declare v text[]; v_tc text;
begin
  if not coalesce(public.jag_is_owner(), false) then return json_build_object('ok', false, 'reason', 'owner_only'); end if;
  select coalesce(array_agg(distinct r order by r), '{}') into v from unnest(coalesce(p_roles, '{}')) r
   where r in ('lead', 'showing', 'screener', 'tc', 'offer_ok');
  update public.jag_agents set roles = v, updated_at = now() where code = p_code;
  if not found then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  -- the TC who gets offers = the person with the TC job (first by name if several)
  select code into v_tc from public.jag_agents where active and 'tc' = any(roles) order by name limit 1;
  if v_tc is not null then
    insert into ops.settings (key, value) values ('tc_agent_code', to_jsonb(v_tc)) on conflict (key) do update set value = excluded.value;
  end if;
  return json_build_object('ok', true, 'roles', v);
end $function$;
revoke all on function public.jag_set_roles(text, text[]) from public, anon;
grant execute on function public.jag_set_roles(text, text[]) to authenticated;

create or replace function public.jag_team_access()
returns json language plpgsql stable security definer set search_path = '' as $function$
begin
  if not public.jag_is_staff() then return json_build_object('ok', false, 'reason', 'not_staff'); end if;
  return json_build_object('ok', true, 'owner', public.jag_is_owner(), 'people', coalesce((
    select json_agg(x order by x.role = 'owner' desc, x.access desc, x.name) from (
      select coalesce(a.name, s.email, i.email) as name, lower(coalesce(a.email, s.email, i.email)) as email, a.code, a.fub_user_id,
             (a.user_id is not null or s.user_id is not null) as has_login,
             (coalesce(s.active, false) or coalesce(i.active, false)) as access,
             coalesce(s.role, 'staff') as role,
             (a.code is not null) as agent, coalesce(a.roles, '{}'::text[]) as roles
        from public.jag_agents a
        full join public.jag_staff s on lower(s.email) = lower(a.email)
        full join public.jag_staff_invites i on i.email = lower(coalesce(a.email, s.email))
       where coalesce(a.active, true)
    ) x), '[]'::json));
end $function$;

create or replace function public.jag_agent_me()
returns json language plpgsql security definer set search_path = '' as $function$
declare v_email text := lower(auth.jwt()->>'email'); v public.jag_agents;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  select * into v from public.jag_agents where user_id = auth.uid();
  if not found then
    update public.jag_agents set user_id = auth.uid(), updated_at = now()
     where active and user_id is null and lower(email) = v_email returning * into v;
  end if;
  if v.code is null then return json_build_object('ok', false, 'reason', 'not_agent', 'email', v_email); end if;
  return json_build_object('ok', true, 'agent', json_build_object('code', v.code, 'name', v.name, 'first_name', v.first_name,
    'phone', v.phone, 'email', v.email, 'photo_url', v.photo_url, 'roles', v.roles), 'staff', public.jag_is_staff());
end $function$;

-- ---------- client texts (JAG line, A2P) ----------
alter table ops.team_texts add column if not exists audience text not null default 'team';
alter table ops.team_texts add column if not exists user_id uuid;

-- now in Texas texting hours (Mon–Sat 9 AM–9 PM, Sun noon–9 PM Central), otherwise the next start
create or replace function ops.client_text_time()
returns timestamptz language plpgsql stable set search_path = '' as $function$
declare t timestamp := now() at time zone 'America/Chicago'; d timestamp;
begin
  if public.jag_texting_hours() then return now(); end if;
  d := date_trunc('day', t) + case when extract(hour from t) >= 21 then interval '1 day' else interval '0' end;
  return (d + case when extract(dow from d) = 0 then interval '12 hours' else interval '9 hours' end) at time zone 'America/Chicago';
end $function$;

-- queue a text to a client: only if they opted in (jag_clients.sms_ok_at) and never opted out
create or replace function ops.client_text(p_user uuid, p_body text, p_kind text default null, p_ref bigint default null)
returns bigint language plpgsql security definer set search_path = '' as $function$
declare c public.jag_clients; v_ph text; v_id bigint;
begin
  select * into c from public.jag_clients where user_id = p_user;
  v_ph := public.jag_digits10(c.phone);
  if c.user_id is null or length(coalesce(v_ph, '')) <> 10 or c.sms_ok_at is null or coalesce(btrim(p_body), '') = '' then return null; end if;
  if exists (select 1 from public.jag_sms_optouts o where o.phone = v_ph and o.active) then return null; end if;
  insert into ops.team_texts (member_id, to_e164, body, kind, ref, send_after, audience, user_id)
  values (null, '+1' || v_ph, left(p_body, 1300) || case when coalesce(c.lang, 'es') = 'en' then E'\nReply STOP to opt out.' else E'\nResponda STOP para salir.' end,
          p_kind, p_ref, ops.client_text_time(), 'client', p_user)
  returning id into v_id;
  return v_id;
end $function$;

-- edge function jag-tour (Follow Up Boss notes/tags/tasks, schedule emails)
create or replace function ops.kick_tour(p jsonb)
returns void language plpgsql security definer set search_path = '' as $function$
declare v_tok text;
begin
  select decrypted_secret into v_tok from vault.decrypted_secrets where name = 'jag_alerts_token';
  perform net.http_post(url := 'https://nyaxywghbpphjhwcmspd.supabase.co/functions/v1/jag-tour', body := p,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jag-token', v_tok), timeout_milliseconds := 20000);
end $function$;

create or replace function ops.short_name(p_name text)
returns text language sql immutable set search_path = '' as $$
  select case when array_length(regexp_split_to_array(btrim(coalesce(p_name, '')), '\s+'), 1) > 1
    then split_part(btrim(p_name), ' ', 1) || ' ' || left((regexp_split_to_array(btrim(p_name), '\s+'))[array_length(regexp_split_to_array(btrim(p_name), '\s+'), 1)], 1) || '.'
    else coalesce(nullif(btrim(p_name), ''), 'A client') end;
$$;

-- ---------- hand-off to a showing agent ----------
alter table public.jag_clients add column if not exists showing_agent_code text;
alter table public.jag_clients add column if not exists showing_set_at timestamptz;
alter table public.jag_clients add column if not exists showing_set_by text;

create or replace function public.jag_showing_agents()
returns json language sql stable security definer set search_path = '' as $$
  select case when not coalesce(public.jag_is_team(), false) then json_build_object('ok', false) else json_build_object('ok', true, 'agents', coalesce((
    select json_agg(json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'phone', a.phone, 'photo_url', a.photo_url,
      'clients', (select count(*) from public.jag_clients c where c.showing_agent_code = a.code)) order by a.name)
      from public.jag_agents a where a.active and 'showing' = any(a.roles)), '[]'::json)) end;
$$;

create or replace function public.jag_client_set_showing(p_user uuid, p_code text)
returns json language plpgsql security definer set search_path = '' as $function$
declare c public.jag_clients; a public.jag_agents; v_by text := public.jag_agent_code_me(); v_byn text; v_proof text; v_m int;
begin
  if not public.jag_has_role('lead') then return json_build_object('ok', false, 'reason', 'not_allowed'); end if;
  select * into c from public.jag_clients where user_id = p_user;
  if c.user_id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if nullif(p_code, '') is not null then
    select * into a from public.jag_agents where active and code = p_code and 'showing' = any(roles);
    if a.code is null then return json_build_object('ok', false, 'reason', 'not_showing_agent'); end if;
  end if;
  update public.jag_clients set showing_agent_code = a.code, showing_set_at = now(), showing_set_by = v_by where user_id = p_user;
  if a.code is not null and a.code is distinct from c.showing_agent_code then
    select coalesce(first_name, name) into v_byn from public.jag_agents where code = v_by;
    select kind into v_proof from public.jag_client_proof where user_id in (select public.jag_household(p_user)) and status = 'verified' order by reviewed_at desc limit 1;
    v_m := ops.member_by_code(a.code);
    perform ops.lola_text(v_m, '👟 ' || coalesce(v_byn, 'The team') || ' sent you ' || coalesce(nullif(c.name, ''), c.email) || ' for showings'
      || case when v_proof is not null then ' (' || case v_proof when 'pof' then 'proof of funds' else 'pre-approval' end || ' verified ✓)' else ' (pre-approval not verified yet)' end
      || '. They can ask for a tour in their app; I''ll text you when they do.'
      || coalesce(E'\n' || nullif(public.jag_digits10(c.phone), ''), '') || E'\nhttps://jasonaguirregroup.company/agent.html#showings\n- Lola', 'showing_handoff', null);
    perform ops.kick_team_texts();
    perform ops.kick_tour(jsonb_build_object('action', 'fub', 'email', c.email, 'phone', c.phone,
      'tags', jsonb_build_array('Showing: ' || coalesce(a.first_name, a.name)),
      'note', jsonb_build_object('subject', 'Sent to a showing agent', 'body', coalesce(v_byn, 'The team') || ' sent this client to ' || a.name || ' for showings (JAG app). The client can now request a tour of their saved homes.'),
      'task', jsonb_build_object('name', 'Showings: ' || coalesce(nullif(c.name, ''), c.email) || ' (from ' || coalesce(v_byn, 'JAG') || ')', 'fub_user_id', a.fub_user_id)));
  end if;
  return json_build_object('ok', true, 'showing_agent_code', a.code);
end $function$;
revoke all on function public.jag_client_set_showing(uuid, text), public.jag_showing_agents() from public, anon;
grant execute on function public.jag_client_set_showing(uuid, text), public.jag_showing_agents() to authenticated;

-- ---------- tours ----------
create table if not exists public.jag_tours (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null,
  lead_agent text,
  showing_agent text,
  tour_date date not null,
  time_window text not null default 'any',
  note text,
  status text not null default 'requested',      -- requested | scheduling | scheduled | done | cancelled
  token text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  sent_at timestamptz,
  sent_count int not null default 0,
  nudged_at timestamptz,
  reminded_at timestamptz
);
create table if not exists public.jag_tour_homes (
  id bigint generated always as identity primary key,
  tour_id bigint not null references public.jag_tours(id),
  mls text,
  snap jsonb not null default '{}'::jsonb,       -- addr, city, zip, price, photo, beds, baths
  position int not null default 0,
  status text not null default 'requested',      -- requested | asked | confirmed | declined | removed
  start_at timestamptz,
  agent_note text,
  fb jsonb,
  fb_at timestamptz,
  fb_asked_at timestamptz,
  hot_at timestamptz,
  added_by text
);
create index if not exists jag_tour_homes_tour on public.jag_tour_homes (tour_id);
create index if not exists jag_tours_user on public.jag_tours (user_id);
alter table public.jag_tours enable row level security;
alter table public.jag_tour_homes enable row level security;

create or replace function public.jag_tour_date_label(p_date date, p_lang text)
returns text language sql stable set search_path = '' as $$
  select case when coalesce(p_lang, 'es') = 'en' then to_char(p_date, 'Dy Mon FMDD')
    else (array['dom','lun','mar','mié','jue','vie','sáb'])[extract(dow from p_date)::int + 1] || ' ' || extract(day from p_date)::int || ' de '
      || (array['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'])[extract(month from p_date)::int] end;
$$;
create or replace function public.jag_tour_window_label(p_w text, p_lang text)
returns text language sql immutable set search_path = '' as $$
  select case when coalesce(p_lang, 'es') = 'en' then case p_w when 'morning' then 'morning' when 'afternoon' then 'afternoon' when 'evening' then 'evening' else 'any time' end
    else case p_w when 'morning' then 'en la mañana' when 'afternoon' then 'en la tarde' when 'evening' then 'en la noche' else 'a cualquier hora' end end;
$$;
create or replace function ops.tour_time(p timestamptz)
returns text language sql stable set search_path = '' as $$ select to_char(p at time zone 'America/Chicago', 'FMHH12:MI AM'); $$;

-- the client's tours + saved homes (account page)
create or replace function public.jag_my_tours()
returns json language plpgsql stable security definer set search_path = '' as $function$
declare c public.jag_clients; a public.jag_agents;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  select * into c from public.jag_clients where user_id = auth.uid();
  if c.user_id is null then return json_build_object('ok', false, 'reason', 'no_account'); end if;
  select * into a from public.jag_agents where active and code = c.showing_agent_code;
  return json_build_object('ok', true, 'phone', c.phone, 'sms_ok', c.sms_ok_at is not null, 'lang', c.lang,
    'showing', case when a.code is null then null else json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'phone', a.phone, 'photo_url', a.photo_url) end,
    'tours', coalesce((select json_agg(json_build_object('id', t.id, 'token', t.token, 'date', t.tour_date, 'window', t.time_window, 'status', t.status, 'sent_at', t.sent_at,
        'homes', (select json_agg(json_build_object('mls', h.mls, 'addr', h.snap->>'addr', 'status', h.status, 'start', ops.tour_time(h.start_at)) order by h.position, h.id)
                    from public.jag_tour_homes h where h.tour_id = t.id and h.status <> 'removed')) order by t.tour_date desc, t.id desc)
      from public.jag_tours t where t.user_id = c.user_id and t.created_at > now() - interval '60 days'), '[]'::json),
    'favorites', coalesce((select json_agg(json_build_object('mls', f.mls, 'snap', f.snap, 'price', coalesce(f.last_price, (f.snap->>'price')::numeric), 'status', f.last_status) order by f.saved_at desc)
      from public.jag_client_favorites f where f.user_id = c.user_id), '[]'::json));
end $function$;

-- p: { homes: [{mls, addr, city, zip, price, photo, beds, baths}], date: 'YYYY-MM-DD', window, note, phone, sms_ok }
create or replace function public.jag_tour_request(p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare c public.jag_clients; v_date date; v_win text; v_id bigint; v_tok text; h jsonb; n int := 0; v_ph text; v_m int; v_lines text := '';
  v_today date := (now() at time zone 'America/Chicago')::date;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  select * into c from public.jag_clients where user_id = auth.uid();
  if c.user_id is null then return json_build_object('ok', false, 'reason', 'no_account'); end if;
  if c.showing_agent_code is null then return json_build_object('ok', false, 'reason', 'no_showing_agent'); end if;
  begin v_date := (p->>'date')::date; exception when others then v_date := null; end;
  if v_date is null or v_date < v_today or v_date > v_today + 45 then return json_build_object('ok', false, 'reason', 'date'); end if;
  v_win := case when p->>'window' in ('morning', 'afternoon', 'evening') then p->>'window' else 'any' end;
  if jsonb_array_length(coalesce(p->'homes', '[]'::jsonb)) = 0 then return json_build_object('ok', false, 'reason', 'homes'); end if;
  if (select count(*) from public.jag_tours where user_id = c.user_id and status in ('requested', 'scheduling') ) >= 3 then
    return json_build_object('ok', false, 'reason', 'too_many'); end if;
  v_ph := public.jag_digits10(p->>'phone');
  update public.jag_clients set phone = case when length(coalesce(v_ph, '')) = 10 then v_ph else phone end,
         sms_ok_at = case when coalesce((p->>'sms_ok')::boolean, false) then coalesce(sms_ok_at, now()) else sms_ok_at end
   where user_id = c.user_id returning * into c;
  insert into public.jag_tours (user_id, lead_agent, showing_agent, tour_date, time_window, note)
  values (c.user_id, c.agent_code, c.showing_agent_code, v_date, v_win, left(nullif(btrim(p->>'note'), ''), 600))
  returning id, token into v_id, v_tok;
  for h in select * from jsonb_array_elements(p->'homes') limit 10 loop
    n := n + 1;
    insert into public.jag_tour_homes (tour_id, mls, snap, position)
    values (v_id, left(nullif(h->>'mls', ''), 30), jsonb_strip_nulls(jsonb_build_object('addr', left(h->>'addr', 120), 'city', left(h->>'city', 60), 'zip', left(h->>'zip', 10),
      'price', nullif(regexp_replace(coalesce(h->>'price', ''), '[^0-9.]', '', 'g'), '')::numeric, 'photo', left(h->>'photo', 300),
      'beds', h->'beds', 'baths', h->'baths')), n);
    if n <= 6 then v_lines := v_lines || E'\n• ' || coalesce(h->>'addr', 'MLS ' || (h->>'mls')); end if;
  end loop;
  v_m := ops.member_by_code(c.showing_agent_code);
  perform ops.lola_text(v_m, '🗓️ ' || ops.short_name(coalesce(nullif(c.name, ''), c.email)) || ' wants to see ' || n || ' home' || case when n = 1 then '' else 's' end || ' on '
    || public.jag_tour_date_label(v_date, 'en') || ' (' || public.jag_tour_window_label(v_win, 'en') || '):' || v_lines || case when n > 6 then E'\n+' || (n - 6) || ' more' end
    || E'\nBook them: https://jasonaguirregroup.company/agent.html#showings\n- Lola', 'tour_new', v_id);
  perform ops.kick_team_texts();
  perform ops.kick_tour(jsonb_build_object('action', 'fub', 'email', c.email, 'phone', c.phone,
    'note', jsonb_build_object('subject', 'Tour requested in the JAG app', 'body', 'Wants to see ' || n || ' home(s) on ' || public.jag_tour_date_label(v_date, 'en') || ', ' || public.jag_tour_window_label(v_win, 'en') || '.' || v_lines || coalesce(E'\nNote: ' || nullif(btrim(p->>'note'), ''), ''))));
  return json_build_object('ok', true, 'id', v_id, 'token', v_tok);
end $function$;
revoke all on function public.jag_my_tours(), public.jag_tour_request(jsonb) from public, anon;
grant execute on function public.jag_my_tours(), public.jag_tour_request(jsonb) to authenticated;

-- ---------- the showing agent's board ----------
create or replace function public.jag_tour_can(p_tour bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.jag_tours t where t.id = p_tour
    and (t.showing_agent = public.jag_agent_code_me() or public.jag_has_role('lead')));
$$;

create or replace function public.jag_tours_list(p_all boolean default false)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare v_me text := public.jag_agent_code_me(); v_lead boolean := public.jag_has_role('lead');
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false); end if;
  return json_build_object('ok', true, 'me', v_me, 'can_all', v_lead, 'tours', coalesce((
    select json_agg(x order by (x->>'sort')) from (
      select json_build_object('id', t.id, 'sort', case when t.status in ('done', 'cancelled') then '2' else '1' end || to_char(t.tour_date, 'YYYYMMDD') || lpad(t.id::text, 9, '0'),
        'created_at', t.created_at, 'date', t.tour_date, 'window', t.time_window, 'note', t.note, 'status', t.status, 'sent_at', t.sent_at, 'sent_count', t.sent_count,
        'token', t.token, 'showing_agent', t.showing_agent, 'lead_agent', t.lead_agent,
        'client', json_build_object('user_id', c.user_id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'lang', c.lang, 'sms_ok', c.sms_ok_at is not null,
          'proof', (select kind from public.jag_client_proof p where p.user_id in (select public.jag_household(c.user_id)) and p.status = 'verified' limit 1)),
        'homes', (select coalesce(json_agg(json_build_object('id', h.id, 'mls', h.mls, 'snap', h.snap, 'position', h.position, 'status', h.status,
            'start_at', h.start_at, 'start_local', to_char(h.start_at at time zone 'America/Chicago', 'YYYY-MM-DD"T"HH24:MI'), 'agent_note', h.agent_note,
            'fb', h.fb, 'fb_at', h.fb_at, 'hot', h.hot_at is not null,
            'offer', (select json_build_object('price', o.offer_price, 'status', o.status, 'at', o.created_at) from public.jag_offers o
                       where o.user_id = t.user_id and o.mls = h.mls order by o.created_at desc limit 1)) order by h.position, h.id), '[]'::json)
          from public.jag_tour_homes h where h.tour_id = t.id and h.status <> 'removed')) as x
      from public.jag_tours t join public.jag_clients c on c.user_id = t.user_id
     where (t.showing_agent = v_me or (p_all and v_lead))
       and (t.status not in ('done', 'cancelled') or t.tour_date > (now() at time zone 'America/Chicago')::date - 14)
     limit 60) s), '[]'::json));
end $function$;

-- p: { status, start ('YYYY-MM-DDTHH:MM' Central, '' = clear), note }
create or replace function public.jag_tour_home_set(p_id bigint, p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare h public.jag_tour_homes;
begin
  select * into h from public.jag_tour_homes where id = p_id;
  if h.id is null or not public.jag_tour_can(h.tour_id) then return json_build_object('ok', false, 'reason', 'not_allowed'); end if;
  update public.jag_tour_homes set
    status = case when p->>'status' in ('requested', 'asked', 'confirmed', 'declined', 'removed') then p->>'status' else status end,
    start_at = case when p ? 'start' then case when nullif(p->>'start', '') is null then null else (p->>'start')::timestamp at time zone 'America/Chicago' end else start_at end,
    agent_note = case when p ? 'note' then left(nullif(btrim(p->>'note'), ''), 300) else agent_note end
   where id = p_id;
  update public.jag_tours set updated_at = now(), status = case when status = 'requested' then 'scheduling' else status end where id = h.tour_id;
  return json_build_object('ok', true);
end $function$;

create or replace function public.jag_tour_order(p_tour bigint, p_ids bigint[])
returns json language plpgsql security definer set search_path = '' as $function$
declare i int;
begin
  if not public.jag_tour_can(p_tour) then return json_build_object('ok', false); end if;
  for i in 1 .. coalesce(array_length(p_ids, 1), 0) loop
    update public.jag_tour_homes set position = i where id = p_ids[i] and tour_id = p_tour;
  end loop;
  return json_build_object('ok', true);
end $function$;

-- add a home (e.g. a replacement for one that was declined)
create or replace function public.jag_tour_home_add(p_tour bigint, p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_id bigint;
begin
  if not public.jag_tour_can(p_tour) then return json_build_object('ok', false); end if;
  insert into public.jag_tour_homes (tour_id, mls, snap, position, added_by)
  values (p_tour, left(nullif(p->>'mls', ''), 30), jsonb_strip_nulls(jsonb_build_object('addr', left(p->>'addr', 120), 'city', left(p->>'city', 60), 'zip', left(p->>'zip', 10),
    'price', nullif(regexp_replace(coalesce(p->>'price', ''), '[^0-9.]', '', 'g'), '')::numeric, 'photo', left(p->>'photo', 300))),
    coalesce((select max(position) + 1 from public.jag_tour_homes where tour_id = p_tour), 1), public.jag_agent_code_me())
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end $function$;

-- the schedule text for the client
create or replace function ops.tour_schedule_text(p_tour bigint, p_update boolean)
returns text language plpgsql stable security definer set search_path = '' as $function$
declare t public.jag_tours; c public.jag_clients; a public.jag_agents; v text := ''; r record; es boolean; v_decl int;
begin
  select * into t from public.jag_tours where id = p_tour;
  select * into c from public.jag_clients where user_id = t.user_id;
  select * into a from public.jag_agents where code = t.showing_agent;
  es := coalesce(c.lang, 'es') <> 'en';
  for r in select h.start_at, coalesce(h.snap->>'addr', 'MLS ' || h.mls) as addr from public.jag_tour_homes h
            where h.tour_id = p_tour and h.status = 'confirmed' order by h.start_at nulls last, h.position loop
    v := v || E'\n' || coalesce(ops.tour_time(r.start_at) || ' ', '') || r.addr;
  end loop;
  select count(*) into v_decl from public.jag_tour_homes where tour_id = p_tour and status = 'declined';
  return case when es then
      case when p_update then '🔄 Cambio en su recorrido' else 'Hola ' || coalesce(initcap(split_part(nullif(btrim(c.name), ''), ' ', 1)), '') || ' 👋 Su recorrido' end
      || ' con ' || coalesce(a.first_name, a.name, 'su agente') || ' del ' || public.jag_tour_date_label(t.tour_date, 'es') || ' está listo:' || v
      || case when v_decl > 0 then E'\n(' || v_decl || case when v_decl = 1 then ' casa no está disponible' else ' casas no están disponibles' end || '; ' || coalesce(a.first_name, 'su agente') || ' le busca otra opción.)' else '' end
      || E'\nDetalles y mapa: https://jasonaguirregroup.company/tour#' || t.token || E'\n- ' || coalesce(a.first_name, 'JAG') || ', JAG Real Estate'
    else
      case when p_update then '🔄 Change to your tour' else 'Hi ' || coalesce(initcap(split_part(nullif(btrim(c.name), ''), ' ', 1)), '') || ' 👋 Your tour' end
      || ' with ' || coalesce(a.first_name, a.name, 'your agent') || ' on ' || public.jag_tour_date_label(t.tour_date, 'en') || ' is set:' || v
      || case when v_decl > 0 then E'\n(' || v_decl || ' home' || case when v_decl = 1 then ' isn''t' else 's aren''t' end || ' available; ' || coalesce(a.first_name, 'your agent') || ' will find another option.)' else '' end
      || E'\nDetails and map: https://jasonaguirregroup.company/tour#' || t.token || E'\n- ' || coalesce(a.first_name, 'JAG') || ', JAG Real Estate' end;
end $function$;

create or replace function public.jag_tour_send(p_tour bigint)
returns json language plpgsql security definer set search_path = '' as $function$
declare t public.jag_tours; v_txt text; v_q bigint; v_n int;
begin
  if not public.jag_tour_can(p_tour) then return json_build_object('ok', false, 'reason', 'not_allowed'); end if;
  select * into t from public.jag_tours where id = p_tour;
  select count(*) into v_n from public.jag_tour_homes where tour_id = p_tour and status = 'confirmed';
  if v_n = 0 then return json_build_object('ok', false, 'reason', 'none_confirmed'); end if;
  v_txt := ops.tour_schedule_text(p_tour, t.sent_at is not null);
  v_q := ops.client_text(t.user_id, v_txt, 'tour_schedule', p_tour);
  update public.jag_tours set status = 'scheduled', sent_at = now(), sent_count = sent_count + 1, updated_at = now() where id = p_tour;
  perform ops.kick_team_texts();
  perform ops.kick_tour(jsonb_build_object('action', 'schedule', 'tour_id', p_tour, 'update', t.sent_at is not null));
  return json_build_object('ok', true, 'texted', v_q is not null, 'text', v_txt);
end $function$;

create or replace function public.jag_tour_cancel(p_tour bigint)
returns json language plpgsql security definer set search_path = '' as $function$
declare t public.jag_tours; c public.jag_clients; a public.jag_agents;
begin
  if not public.jag_tour_can(p_tour) then return json_build_object('ok', false); end if;
  update public.jag_tours set status = 'cancelled', updated_at = now() where id = p_tour returning * into t;
  if t.sent_at is not null then
    select * into c from public.jag_clients where user_id = t.user_id;
    select * into a from public.jag_agents where code = t.showing_agent;
    perform ops.client_text(t.user_id, case when coalesce(c.lang, 'es') = 'en'
      then 'Your tour on ' || public.jag_tour_date_label(t.tour_date, 'en') || ' was canceled. ' || coalesce(a.first_name, 'Your agent') || ' will reach out to set a new one.'
      else 'Su recorrido del ' || public.jag_tour_date_label(t.tour_date, 'es') || ' se canceló. ' || coalesce(a.first_name, 'Su agente') || ' le contactará para programar otro.' end, 'tour_cancel', p_tour);
    perform ops.kick_team_texts();
  end if;
  return json_build_object('ok', true);
end $function$;
revoke all on function public.jag_tours_list(boolean), public.jag_tour_home_set(bigint, jsonb), public.jag_tour_order(bigint, bigint[]),
  public.jag_tour_home_add(bigint, jsonb), public.jag_tour_send(bigint), public.jag_tour_cancel(bigint), public.jag_tour_can(bigint) from public, anon;
grant execute on function public.jag_tours_list(boolean), public.jag_tour_home_set(bigint, jsonb), public.jag_tour_order(bigint, bigint[]),
  public.jag_tour_home_add(bigint, jsonb), public.jag_tour_send(bigint), public.jag_tour_cancel(bigint) to authenticated;

-- ---------- the client's tour page (secret link) ----------
create or replace function public.jag_tour_view(p_token text)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare t public.jag_tours; c public.jag_clients; a public.jag_agents; o public.jag_offers;
begin
  select * into t from public.jag_tours where token = btrim(coalesce(p_token, '')) and created_at > now() - interval '120 days';
  if t.id is null then return json_build_object('ok', false); end if;
  select * into c from public.jag_clients where user_id = t.user_id;
  select * into a from public.jag_agents where code = t.showing_agent;
  select * into o from public.jag_offers where user_id = t.user_id order by created_at desc limit 1;
  return json_build_object('ok', true, 'id', t.id, 'date', t.tour_date, 'window', t.time_window, 'status', t.status, 'sent', t.sent_at is not null,
    'client', json_build_object('first', split_part(coalesce(nullif(c.name, ''), ''), ' ', 1), 'name', c.name, 'lang', coalesce(c.lang, 'es')),
    'agent', case when a.code is null then null else json_build_object('name', a.name, 'first_name', a.first_name, 'phone', a.phone, 'photo_url', a.photo_url) end,
    'loan', json_build_object('financing', o.financing, 'loan_type', o.loan_type, 'down_payment', o.down_payment, 'lender', o.lender,
      'proof', (select kind from public.jag_client_proof p where p.user_id in (select public.jag_household(t.user_id)) and p.status = 'verified' limit 1)),
    'homes', coalesce((select json_agg(json_build_object('id', h.id, 'mls', h.mls, 'snap', h.snap, 'status', h.status, 'start', ops.tour_time(h.start_at), 'start_at', h.start_at,
        'fb', h.fb, 'offer', (select json_build_object('price', x.offer_price, 'status', x.status) from public.jag_offers x where x.user_id = t.user_id and x.mls = h.mls order by x.created_at desc limit 1))
        order by h.start_at nulls last, h.position, h.id)
      from public.jag_tour_homes h where h.tour_id = t.id and h.status not in ('removed')), '[]'::json));
end $function$;

-- p: { stars 1-5, live yes|maybe|no, likes[], dislikes[], note }
create or replace function public.jag_tour_feedback(p_token text, p_home bigint, p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare t public.jag_tours; h public.jag_tour_homes; c public.jag_clients; v jsonb; v_hot boolean; v_txt text; v_m int; v_lm int;
begin
  select * into t from public.jag_tours where token = btrim(coalesce(p_token, ''));
  select * into h from public.jag_tour_homes where id = p_home and tour_id = t.id;
  if t.id is null or h.id is null then return json_build_object('ok', false); end if;
  select * into c from public.jag_clients where user_id = t.user_id;
  v := jsonb_strip_nulls(jsonb_build_object(
    'stars', case when (p->>'stars') ~ '^[1-5]$' then (p->>'stars')::int end,
    'live', case when p->>'live' in ('yes', 'maybe', 'no') then p->>'live' end,
    'likes', (select jsonb_agg(left(x, 30)) from jsonb_array_elements_text(coalesce(p->'likes', '[]'::jsonb)) x),
    'dislikes', (select jsonb_agg(left(x, 30)) from jsonb_array_elements_text(coalesce(p->'dislikes', '[]'::jsonb)) x),
    'note', left(nullif(btrim(p->>'note'), ''), 500)));
  update public.jag_tour_homes set fb = v, fb_at = now() where id = h.id;
  v_hot := (v->>'live') = 'yes' or coalesce((v->>'stars')::int, 0) >= 5;
  v_txt := ops.short_name(coalesce(nullif(c.name, ''), c.email)) || ' on ' || coalesce(h.snap->>'addr', 'MLS ' || h.mls) || ': '
    || coalesce(repeat('★', (v->>'stars')::int) || ' ', '') || coalesce(case v->>'live' when 'yes' then 'could live there' when 'maybe' then 'maybe' when 'no' then 'not for them' end, '')
    || coalesce('. Liked: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(v->'likes') x), '')
    || coalesce('. Didn''t like: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(v->'dislikes') x), '')
    || coalesce('. "' || (v->>'note') || '"', '');
  if v_hot and h.hot_at is null then
    update public.jag_tour_homes set hot_at = now() where id = h.id;
    v_m := ops.member_by_code(t.showing_agent); v_lm := ops.member_by_code(t.lead_agent);
    perform ops.lola_text(x, '🔥 ' || v_txt || E'\nThe Offer button is on their tour page. Strike while it''s hot!\n- Lola', 'tour_hot', h.id, true)
      from (select distinct x from unnest(array[v_m, v_lm]) x where x is not null) s;
    perform ops.kick_team_texts();
  end if;
  perform ops.kick_tour(jsonb_build_object('action', 'fub', 'email', c.email, 'phone', c.phone,
    'tags', case when v_hot then jsonb_build_array('Loved a home') else '[]'::jsonb end,
    'note', jsonb_build_object('subject', 'Showing feedback', 'body', v_txt)));
  return json_build_object('ok', true, 'hot', v_hot);
end $function$;
revoke all on function public.jag_tour_view(text), public.jag_tour_feedback(text, bigint, jsonb) from public;
grant execute on function public.jag_tour_view(text), public.jag_tour_feedback(text, bigint, jsonb) to anon, authenticated;

-- ---------- the client's offer from the tour page → René, waiting for an OK ----------
alter table ops.tc_requests add column if not exists needs_ok boolean not null default false;
alter table ops.tc_requests add column if not exists ok_at timestamptz;
alter table ops.tc_requests add column if not exists ok_by text;

create or replace function ops.tc_requests_before_insert()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if new.via = 'client' then new.needs_ok := true; end if;
  return new;
end $function$;
create or replace trigger tc_requests_needs_ok before insert on ops.tc_requests
  for each row execute function ops.tc_requests_before_insert();

-- René's first text says when to wait for the OK
create or replace function ops.tc_text_rene(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $function$
declare r ops.tc_requests; o ops.offer_requests; v_by text; v_tc int := ops.tc_member(); v_body text;
begin
  select * into r from ops.tc_requests where id = p_id;
  if r.id is null or r.offer_request_id is null or v_tc is null then return; end if;
  select * into o from ops.offer_requests where id = r.offer_request_id;
  select split_part(name, ' ', 1) into v_by from ops.team where id = r.member_id;
  v_body := '📝 New offer to prepare' || case when r.needs_ok then ' (the client sent it from the app)' else coalesce(' (from ' || v_by || ')', '') end || E'\n'
    || o.property || coalesce(' · ' || nullif(coalesce(r.client_label, o.client_label), ''), '') || E'\n'
    || coalesce(nullif(ops.tc_offer_line(o), '') || E'\n', '')
    || case when r.needs_ok then E'⏸ Prepare it, but don''t send it for signatures until Katherine or Jason OKs it. I''ll text you.\n' else '' end
    || 'Your step-by-step: ' || ops.s_text('tc_page_url') || r.token || E'\n- Lola';
  perform ops.lola_text(v_tc, v_body, 'tc_new', r.id);
  perform ops.kick_team_texts();
end $function$;

-- someone with the "offer_ok" job OKs a client offer (text "OK 37" to Lola, or the button in the Agent Hub)
create or replace function ops.tc_ok(p_member int, p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r ops.tc_requests; o ops.offer_requests; v_name text; v_tc int := ops.tc_member();
begin
  if not ops.member_has_role(p_member, 'offer_ok') then
    return jsonb_build_object('ok', false, 'reply', 'Only Katherine or Jason can OK client offers. - Lola'); end if;
  select * into r from ops.tc_requests where id = p_id;
  if r.id is null or not r.needs_ok then return jsonb_build_object('ok', false, 'reply', 'I can''t find client offer #' || p_id || ' waiting for an OK. - Lola'); end if;
  select * into o from ops.offer_requests where id = r.offer_request_id;
  select split_part(name, ' ', 1) into v_name from ops.team where id = p_member;
  if r.ok_at is not null then return jsonb_build_object('ok', true, 'reply', 'Already OK''d by ' || coalesce(r.ok_by, 'the team') || '. René can send it for signatures. - Lola'); end if;
  update ops.tc_requests set ok_at = now(), ok_by = v_name where id = r.id;
  perform ops.lola_text(v_tc, '✅ ' || coalesce(v_name, 'The team') || ' OK''d the client''s offer on ' || o.property || '. Send it for signatures: ' || ops.s_text('tc_page_url') || r.token || E'\n- Lola', 'tc_ok', r.id, true);
  perform ops.kick_team_texts();
  return jsonb_build_object('ok', true, 'reply', '✅ OK''d. René can send the offer on ' || o.property || ' for signatures now. - Lola');
end $function$;

create or replace function public.jag_tc_ok(p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_m int := ops.team_member_me();
begin
  if v_m is null then return jsonb_build_object('ok', false); end if;
  return ops.tc_ok(v_m, p_id);
end $function$;

-- client offers waiting for an OK (Agent Hub → Offers, for people with the offer_ok job)
create or replace function public.jag_tc_waiting()
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
begin
  if not public.jag_has_role('offer_ok') then return jsonb_build_object('ok', true, 'rows', '[]'::jsonb, 'can', false); end if;
  return jsonb_build_object('ok', true, 'can', true, 'rows', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'created_at', r.created_at, 'property', o.property,
      'client', coalesce(r.client_label, o.client_label), 'line', ops.tc_offer_line(o), 'checklist', ops.s_text('tc_page_url') || r.token, 'link', ops.offer_link(o)) order by r.id desc)
    from ops.tc_requests r join ops.offer_requests o on o.id = r.offer_request_id
   where r.needs_ok and r.ok_at is null and r.created_at > now() - interval '14 days'), '[]'::jsonb));
end $function$;
revoke all on function public.jag_tc_ok(bigint), public.jag_tc_waiting() from public, anon;
grant execute on function public.jag_tc_ok(bigint), public.jag_tc_waiting() to authenticated;
revoke all on function ops.tc_ok(int, bigint) from public, anon, authenticated;

-- René's checklist: "Sent for signatures" waits for the OK
create or replace function public.jag_tc_check(p_token text, p_step text, p_done boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r ops.tc_requests; o ops.offer_requests; v_was boolean; v_tc text; v_all boolean; v_who text;
begin
  if p_step not in ('la_email', 'skyslope', 'filled', 'signatures', 'sent', 'fub') then return jsonb_build_object('ok', false); end if;
  select * into r from ops.tc_requests where token = btrim(coalesce(p_token, '')) and created_at > now() - interval '60 days' for update;
  if r.id is null then return jsonb_build_object('ok', false); end if;
  if p_done and p_step in ('signatures', 'sent') and r.needs_ok and r.ok_at is null then
    return jsonb_build_object('ok', false, 'reason', 'needs_ok', 'progress', r.progress); end if;
  select * into o from ops.offer_requests where id = r.offer_request_id;
  v_was := r.progress ? p_step;
  update ops.tc_requests set progress = case when p_done then progress || jsonb_build_object(p_step, now()) else progress - p_step end,
         opened_at = coalesce(opened_at, now())
   where id = r.id returning * into r;
  v_all := (select bool_and(r.progress ? s) from unnest(array['la_email', 'skyslope', 'filled', 'signatures', 'sent', 'fub']) s);
  update ops.tc_requests set done_at = case when v_all then coalesce(done_at, now()) else null end where id = r.id returning * into r;
  if p_done and not v_was then
    select coalesce(a.first_name, a.name, 'The TC') into v_tc from public.jag_agents a where a.code = coalesce(ops.s_text('tc_agent_code'), 'rene');
    v_who := coalesce(' (' || nullif(coalesce(r.client_label, o.client_label), '') || ')', '');
    if p_step = 'signatures' then
      perform ops.tc_tell(r, '✍️ ' || v_tc || ' sent the offer on ' || o.property || v_who || ' to the client for signatures. - Lola', 'tc_sign', false);
    elsif p_step = 'sent' then
      update ops.offer_requests set status = 'sent', sent_at = coalesce(sent_at, now()), updated_at = now()
       where id = o.id and coalesce(status, '') in ('', 'new', 'drafting');
      perform ops.tc_tell(r, '🎉 The offer on ' || o.property || v_who || ' is out to the listing agent. Sent by ' || v_tc || '. - Lola', 'tc_sent', true);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'progress', r.progress, 'done_at', r.done_at);
end $function$;

create or replace function public.jag_tc_view(p_token text, p_open boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r ops.tc_requests; o ops.offer_requests;
begin
  select * into r from ops.tc_requests where token = btrim(coalesce(p_token, '')) and created_at > now() - interval '60 days';
  if r.id is null or r.offer_request_id is null then return jsonb_build_object('ok', false); end if;
  select * into o from ops.offer_requests where id = r.offer_request_id;
  if p_open and r.opened_at is null then update ops.tc_requests set opened_at = now() where id = r.id; end if;
  return jsonb_build_object('ok', true, 'id', r.id, 'created_at', r.created_at, 'progress', r.progress, 'done_at', r.done_at, 'note', r.steps,
    'needs_ok', r.needs_ok, 'ok_at', r.ok_at, 'ok_by', r.ok_by, 'via', r.via,
    'by', (select jsonb_build_object('name', t.name, 'first', split_part(t.name, ' ', 1), 'email', a.email)
             from ops.team t left join public.jag_agents a on a.fub_user_id = t.fub_user_id where t.id = r.member_id),
    'tc', (select coalesce(a.first_name, a.name) from public.jag_agents a where a.code = coalesce(ops.s_text('tc_agent_code'), 'rene')),
    'offer', jsonb_build_object('property', o.property, 'mls', o.mls, 'client', coalesce(r.client_label, o.client_label), 'status', o.status,
      'link', ops.offer_link(o), 'missing', ops.offer_missing(o.terms),
      'terms', (select value from ops.settings where key = 'offer_defaults') || o.terms),
    'fub_person_id', coalesce(r.fub_person_id, o.fub_person_id));
end $function$;

-- p: { price, cc (dollars the seller pays toward closing costs), loan_type, close_date, note, facts: { HAR facts } }
create or replace function public.jag_tour_offer(p_token text, p_home bigint, p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare t public.jag_tours; h public.jag_tour_homes; c public.jag_clients; po public.jag_offers; v_price numeric; v_cc numeric; v_loan text; v_down text;
  v_close date; v_names text; v_member int; v_terms jsonb; f jsonb := coalesce(p->'facts', '{}'::jsonb); v_r jsonb; v_q jsonb; v_lead uuid; v_oid uuid;
  v_addr text; v_line text; k text; v_ids int[]; x int; v_ok int[];
begin
  select * into t from public.jag_tours where token = btrim(coalesce(p_token, ''));
  select * into h from public.jag_tour_homes where id = p_home and tour_id = t.id;
  if t.id is null or h.id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into c from public.jag_clients where user_id = t.user_id;
  v_price := nullif(regexp_replace(coalesce(p->>'price', ''), '[^0-9.]', '', 'g'), '')::numeric;
  if coalesce(v_price, 0) < 10000 then return json_build_object('ok', false, 'reason', 'price'); end if;
  if exists (select 1 from public.jag_offers where user_id = t.user_id and mls = h.mls and created_at > now() - interval '10 minutes') then
    return json_build_object('ok', false, 'reason', 'just_sent'); end if;
  select * into po from public.jag_offers where user_id = t.user_id order by created_at desc limit 1;
  v_cc := coalesce(nullif(regexp_replace(coalesce(p->>'cc', ''), '[^0-9.]', '', 'g'), '')::numeric, 0);
  v_loan := case when lower(p->>'loan_type') in ('fha', 'conventional', 'va', 'usda', 'cash') then lower(p->>'loan_type')
                 when lower(coalesce(po.loan_type, '')) in ('fha', 'conventional', 'va', 'usda') then lower(po.loan_type)
                 when po.financing = 'cash' then 'cash' end;
  v_down := case v_loan when 'fha' then '3.5%' when 'conventional' then coalesce(nullif(substring(coalesce(po.down_payment, '') from '([0-9.]+%)'), ''), '5%') when 'va' then '0%' when 'usda' then '0%' end;
  begin v_close := (p->>'close_date')::date; exception when others then v_close := null; end;
  v_close := coalesce(v_close, ((now() at time zone 'America/Chicago')::date + 30));
  select string_agg(coalesce(nullif(m.name, ''), m.email), ' and ' order by (m.user_id <> c.user_id), m.created_at) into v_names
    from public.jag_clients m where m.user_id in (select public.jag_household(c.user_id));
  v_addr := coalesce(nullif(f->>'address', ''), h.snap->>'addr', 'MLS ' || h.mls);

  -- the client's offer, like the website offer form
  insert into public.jag_leads (type, name, email, phone, lang, source, status, payload, est_amount)
  values ('Buyer Offer', coalesce(nullif(c.name, ''), c.email), c.email, public.jag_digits10(c.phone), c.lang, '/tour (JAG app)', 'New',
    jsonb_build_object('Property', v_addr, 'MLS #', h.mls, 'Offer price', v_price, 'Seller pays closing costs', v_cc, 'Loan type', v_loan, 'Closing', v_close, 'Notes', p->>'note'), v_price)
  returning id into v_lead;
  insert into public.jag_offers (user_id, lead_id, name, email, phone, co_buyer, lang, mls, address, list_price, offer_price, earnest, financing, loan_type,
    down_payment, lender, proof, contingencies, option_days, close_date, notes, agent_code)
  values (c.user_id, v_lead, coalesce(nullif(c.name, ''), c.email), c.email, public.jag_digits10(c.phone), null, c.lang, h.mls,
    v_addr || coalesce(', ' || nullif(h.snap->>'city', ''), ''), (h.snap->>'price')::numeric, v_price, greatest(500, round(v_price * 0.01 / 100) * 100),
    case when v_loan = 'cash' then 'cash' when v_loan is not null then 'financed' end, upper(nullif(v_loan, 'cash')), v_down, po.lender,
    case when exists (select 1 from public.jag_client_proof x where x.user_id in (select public.jag_household(c.user_id)) and x.status = 'verified') then 'yes' else po.proof end,
    '{}', 7, v_close, left(concat_ws(E'\n', nullif(btrim(p->>'note'), ''), case when v_cc > 0 then 'Seller pays closing costs: $' || to_char(v_cc, 'FM999,999') end), 2000),
    coalesce(c.agent_code, t.lead_agent))
  returning id into v_oid;

  -- the offer draft for René (HAR facts the tour page looked up + the team's usual terms)
  v_terms := jsonb_strip_nulls(jsonb_build_object('buyer_names', coalesce(v_names, c.name), 'buyer_email', c.email, 'buyer_phone', public.jag_digits10(c.phone),
    'sales_price', v_price::text, 'loan_type', v_loan, 'down_payment', v_down,
    'seller_concession', case when v_cc > 0 then v_cc::text end, 'earnest_money', greatest(500, round(v_price * 0.01 / 100) * 100)::text,
    'option_fee', '200', 'option_days', '7', 'closing_date', v_close::text, 'service_contract', '700',
    'list_price', h.snap->>'price', 'special_provisions', nullif(btrim(p->>'note'), '')));
  foreach k in array array['city', 'zip', 'county', 'year_built', 'lot', 'block', 'addition', 'hoa', 'hoa_name', 'hoa_phone', 'district_notices',
                            'listing_agent', 'listing_firm', 'listing_agent_phone', 'listing_agent_email', 'listing_agent_address'] loop
    if nullif(btrim(coalesce(f->>k, '')), '') is not null then v_terms := v_terms || jsonb_build_object(k, left(f->>k, 200)); end if;
  end loop;
  v_terms := v_terms || jsonb_build_object('title_company', '');
  v_member := coalesce(ops.member_by_code(t.showing_agent), ops.member_by_code(t.lead_agent), (select id from ops.team where role = 'lead' and active order by id limit 1));
  v_r := public.ops_offer_request(v_member, split_part(v_addr, ',', 1), null, coalesce(v_names, c.name), v_terms);
  update ops.offer_requests set mls = h.mls where id = (v_r->>'offer_request_id')::bigint;
  v_q := ops.tc_queue(v_member, (v_r->>'offer_request_id')::bigint, null, coalesce(v_names, c.name), 'Client offer from the JAG app',
    'The client sent this offer from their tour page in the JAG app. Prepare it now, but wait for an OK from Katherine or Jason (Lola will text you) before sending it for signatures.', 'client');

  -- Lola: the people who OK it, the showing agent and the lead agent
  v_line := ops.short_name(coalesce(nullif(c.name, ''), c.email)) || ' wants to offer $' || to_char(v_price, 'FM999,999,999') || ' on ' || split_part(v_addr, ',', 1)
    || ' (' || coalesce(case v_loan when 'fha' then 'FHA' when 'va' then 'VA' when 'usda' then 'USDA' when 'conventional' then 'Conventional' when 'cash' then 'Cash' end, 'loan type ?')
    || case when v_cc > 0 then ', $' || to_char(v_cc, 'FM999,999') || ' closing costs' else '' end || ') from the app. René is preparing it.';
  select coalesce(array_agg(okm), '{}') into v_ok from ops.members_with_role('offer_ok') okm where okm is distinct from ops.tc_member();
  foreach x in array v_ok loop
    perform ops.lola_text(x, '🏠 ' || v_line || E'\nReply OK ' || (v_q->>'id') || E' to let him send it for signatures.\n- Lola', 'client_offer', (v_q->>'id')::bigint);
  end loop;
  v_ids := array[ops.member_by_code(t.showing_agent), ops.member_by_code(t.lead_agent)];
  foreach x in array v_ids loop
    if x is not null and not (x = any(v_ok)) and x is distinct from ops.tc_member() then
      perform ops.lola_text(x, '🏠 ' || v_line || E'\n- Lola', 'client_offer', (v_q->>'id')::bigint); end if;
  end loop;
  -- tell the client we have it
  perform ops.client_text(c.user_id, case when coalesce(c.lang, 'es') = 'en'
    then 'We got your offer of $' || to_char(v_price, 'FM999,999,999') || ' on ' || split_part(v_addr, ',', 1) || '. Your JAG team is preparing it; we''ll let you know when it''s ready to sign.'
    else 'Recibimos su oferta de $' || to_char(v_price, 'FM999,999,999') || ' para ' || split_part(v_addr, ',', 1) || '. Su equipo JAG la está preparando; le avisamos cuando esté lista para firmar.' end,
    'client_offer_ack', (v_q->>'id')::bigint);
  perform ops.kick_team_texts();
  return json_build_object('ok', true, 'offer_id', v_oid);
end $function$;
revoke all on function public.jag_tour_offer(text, bigint, jsonb) from public;
grant execute on function public.jag_tour_offer(text, bigint, jsonb) to anon, authenticated;

-- ---------- timed texts: feedback asks, day-before reminders, nudges (runs with ops.kick_team_texts every 2 min) ----------
create or replace function ops.tour_tick()
returns void language plpgsql security definer set search_path = '' as $function$
declare r record; c public.jag_clients; v_now timestamp := now() at time zone 'America/Chicago'; v_first text; v_txt text; es boolean;
begin
  -- 1. feedback: 35 minutes after each confirmed showing (several due at once → one text)
  for r in
    select t.id as tour_id, t.user_id, t.token, array_agg(h.id order by h.start_at) as ids, array_agg(coalesce(h.snap->>'addr', 'MLS ' || h.mls) order by h.start_at) as addrs
      from public.jag_tours t join public.jag_tour_homes h on h.tour_id = t.id
     where t.status = 'scheduled' and h.status = 'confirmed' and h.fb_at is null and h.fb_asked_at is null
       and h.start_at + interval '35 minutes' <= now() and h.start_at > now() - interval '8 hours'
     group by t.id, t.user_id, t.token
  loop
    update public.jag_tour_homes set fb_asked_at = now() where id = any(r.ids);
    select * into c from public.jag_clients where user_id = r.user_id; es := coalesce(c.lang, 'es') <> 'en';
    v_txt := case when es then '¿Qué le pareció ' || array_to_string(r.addrs, ' y ') || '? Díganos en 10 segundos 👉 '
                          else 'How did you like ' || array_to_string(r.addrs, ' and ') || '? Tell us in 10 seconds 👉 ' end
      || 'https://jasonaguirregroup.company/tour#' || r.token || '&h=' || r.ids[1];
    perform ops.client_text(r.user_id, v_txt, 'tour_fb', r.tour_id);
  end loop;
  -- 2. the evening before (after 6 PM): reminder with the first time
  if extract(hour from v_now) >= 18 then
    for r in select t.* from public.jag_tours t where t.status = 'scheduled' and t.reminded_at is null and t.tour_date = v_now::date + 1 loop
      update public.jag_tours set reminded_at = now() where id = r.id;
      select * into c from public.jag_clients where user_id = r.user_id; es := coalesce(c.lang, 'es') <> 'en';
      select ops.tour_time(min(start_at)) into v_first from public.jag_tour_homes where tour_id = r.id and status = 'confirmed';
      perform ops.client_text(r.user_id, case when es
        then 'Recordatorio 🏡 Mañana es su recorrido' || coalesce('; la primera casa es a las ' || v_first, '') || '. Detalles: https://jasonaguirregroup.company/tour#' || r.token
        else 'Reminder 🏡 Your tour is tomorrow' || coalesce('; the first home is at ' || v_first, '') || '. Details: https://jasonaguirregroup.company/tour#' || r.token end,
        'tour_remind', r.id);
    end loop;
  end if;
  -- 3. tour requested 2+ hours ago and nothing booked yet → nudge the showing agent once (team hours)
  if extract(hour from v_now) between 8 and 20 then
    for r in select t.*, c2.name as cname from public.jag_tours t join public.jag_clients c2 on c2.user_id = t.user_id
              where t.status = 'requested' and t.nudged_at is null and t.created_at < now() - interval '2 hours' loop
      update public.jag_tours set nudged_at = now() where id = r.id;
      perform ops.lola_text(ops.member_by_code(r.showing_agent), '⏰ ' || ops.short_name(r.cname) || '''s tour on ' || public.jag_tour_date_label(r.tour_date, 'en')
        || E' isn''t booked yet. Clients wait, sales walk. 💅\nhttps://jasonaguirregroup.company/agent.html#showings\n- Lola', 'tour_nudge', r.id);
    end loop;
  end if;
  -- 4. past tours are done
  update public.jag_tours set status = 'done', updated_at = now() where status in ('scheduled', 'scheduling', 'requested') and tour_date < v_now::date - 1;
end $function$;

create or replace function ops.kick_team_texts()
returns text language plpgsql security definer set search_path = '' as $function$
declare v_secret text; v_rows jsonb; v_url text := ops.s_text('team_texts_url');
begin
  begin perform ops.tc_nudge(); exception when others then null; end;
  begin perform ops.tour_tick(); exception when others then null; end;
  with due as (
    select id from ops.team_texts
     where sent_at is null and tries < 3 and send_after <= now()
       and (claimed_at is null or claimed_at < now() - interval '10 minutes')
     order by id limit 20 for update skip locked
  ), claimed as (
    update ops.team_texts t set claimed_at = now() from due where t.id = due.id returning t.id, t.to_e164, t.body
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'to', to_e164, 'body', body) order by id), '[]'::jsonb) into v_rows from claimed;
  if jsonb_array_length(v_rows) = 0 or coalesce(v_url, '') = '' then return 'idle'; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'jag_ops_watchdog_secret';
  perform net.http_post(url := v_url, body := jsonb_build_object('texts', v_rows),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-JAG-Ops-Secret', v_secret), timeout_milliseconds := 15000);
  return 'kicked ' || jsonb_array_length(v_rows);
end $function$;

revoke all on function ops.tour_tick(), ops.client_text(uuid, text, text, bigint), ops.kick_tour(jsonb), ops.member_has_role(int, text),
  ops.members_with_role(text) from public, anon, authenticated;

-- ---------- a client texts the JAG line (Text line workflow, non-team branch) ----------
-- New name so the older ops_client_text_inbound (website-chat SMS workflow, kept OFF) stays as it was.
-- STOP → opt out (Twilio also blocks the number). Account holders → their Mensajes thread (their agent gets Lola's text),
-- and the showing agent too when a tour is coming up. Anyone else → Lola tells the lead agents.
create or replace function public.ops_jag_line_inbound(p_from text, p_body text, p_sid text default null)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_ph text := public.jag_digits10(p_from); v_body text := btrim(coalesce(p_body, '')); c public.jag_clients; l public.jag_leads; t public.jag_tours;
  v_who text; x int;
begin
  if coalesce(auth.role(), '') <> 'service_role' then return json_build_object('ok', false); end if;
  if length(v_ph) <> 10 then return json_build_object('ok', false, 'reason', 'phone'); end if;
  select * into c from public.jag_clients where public.jag_digits10(phone) = v_ph order by last_seen_at desc nulls last limit 1;
  select * into l from public.jag_leads where public.jag_digits10(phone) = v_ph and coalesce(status, '') <> 'Merged' order by created_at desc limit 1;
  v_who := ops.short_name(coalesce(nullif(c.name, ''), l.name, '')) ;
  if upper(v_body) ~ '^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|ALTO|PARAR|BASTA)\W*$' then
    insert into public.jag_sms_optouts (phone, body) values (v_ph, left(v_body, 200)) on conflict (phone) do update set created_at = now(), body = excluded.body, active = true;
    update public.jag_chat_sessions set sms_opt_out = true where public.jag_digits10(phone) = v_ph;
    update public.jag_clients set sms_ok_at = null where public.jag_digits10(phone) = v_ph;
    if c.user_id is not null then
      perform ops.lola_text(s.x, '🔕 ' || coalesce(nullif(v_who, ''), v_ph) || ' replied STOP to the JAG line. No more texts to them; call or email instead. - Lola', 'client_stop', null)
        from (select distinct u as x from unnest(array[ops.member_by_code(c.agent_code), ops.member_by_code(c.showing_agent_code)]) u where u is not null) s;
      perform ops.kick_team_texts();
    end if;
    return json_build_object('ok', true, 'route', 'stop');
  end if;
  if upper(v_body) ~ '^(START|UNSTOP)\W*$' then
    update public.jag_sms_optouts set active = false where phone = v_ph;
    update public.jag_chat_sessions set sms_opt_out = false where public.jag_digits10(phone) = v_ph;
    update public.jag_clients set sms_ok_at = coalesce(sms_ok_at, now()) where public.jag_digits10(phone) = v_ph;
    return json_build_object('ok', true, 'route', 'start');
  end if;
  if c.user_id is not null then
    insert into public.jag_messages (user_id, agent_code, sender, sender_name, body, via)
    values (public.jag_household_of(c.user_id), c.agent_code, 'client', coalesce(nullif(c.name, ''), c.email), left(v_body, 2000), 'sms');
    begin perform ops.kick_messages(); exception when others then null; end;
    -- a tour coming up (or today/yesterday): the showing agent hears it too
    select * into t from public.jag_tours where user_id = c.user_id and status in ('requested', 'scheduling', 'scheduled')
       and tour_date between (now() at time zone 'America/Chicago')::date - 1 and (now() at time zone 'America/Chicago')::date + 14 order by tour_date limit 1;
    if t.id is not null and t.showing_agent is distinct from c.agent_code then
      perform ops.lola_text(ops.member_by_code(t.showing_agent), '💬 ' || coalesce(nullif(v_who, ''), v_ph) || ' (tour ' || public.jag_tour_date_label(t.tour_date, 'en') || ') texted: "' || left(v_body, 300) || '"'
        || E'\nAnswer in the Agent Hub > Messages or call ' || v_ph || E'.\n- Lola', 'client_text', t.id, true);
      perform ops.kick_team_texts();
    end if;
    return json_build_object('ok', true, 'route', 'mensajes');
  end if;
  for x in select * from ops.members_with_role('lead') loop
    perform ops.lola_text(x, '💬 Text to the JAG line from ' || coalesce(nullif(l.name, ''), v_ph) || ' (' || v_ph || '): "' || left(v_body, 300) || '"'
      || coalesce(E'\n' || (l.payload->>'Follow Up Boss'), '') || E'\nPlease answer from FUB or your phone.\n- Lola', 'unknown_text', null, true);
  end loop;
  perform ops.kick_team_texts();
  return json_build_object('ok', true, 'route', 'team');
end $function$;
revoke all on function public.ops_jag_line_inbound(text, text, text) from public, anon, authenticated;
grant execute on function public.ops_jag_line_inbound(text, text, text) to service_role;

-- ---------- "OK 37" texted to Lola (before the R# reply logic) + showing agent on the Agent Hub client list ----------
-- (applied as jag_showings_5_ok_text_clients; jag_msg_agent_text and jag_agent_clients are recreated with these additions)

create or replace function ops.short_name(p_name text)
returns text language sql immutable set search_path = '' as $function$
  with n as (select btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')) as s)
  select case when s = '' then 'A client'
    when position(' ' in s) > 0 then
      (case when s = lower(s) then initcap(split_part(s, ' ', 1)) else split_part(s, ' ', 1) end) || ' ' || upper(left(regexp_replace(s, '^.* ', ''), 1)) || '.'
    else case when s = lower(s) then initcap(s) else s end end from n;
$function$;
