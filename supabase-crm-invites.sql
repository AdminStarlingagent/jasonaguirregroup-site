-- ============================================================
-- JAG CRM phase 1: invite a client to the app, know when they join, see where they are.
--
--   jag_invites        an agent makes the client's profile (name, phone, email, language) and sends a personal link
--                      (/join#<token>) by text from their own phone, by email (jag-client-hub 'invite'), WhatsApp or copy.
--                      Statuses: invited → opened → joined (or cancelled).
--   jag_agent_notifs   the Agent Hub bell: "María opened your invite", "María created her account" (+ a Lola text on join).
--   jag_client_journey where a client is: joined · screened · applied · loan · looking · homes sent · showings · offers.
--
-- Team RPCs: jag_invite_create(p), jag_invite_sent(id, channel), jag_invite_list(), jag_invite_cancel(id),
--            jag_notifs(limit), jag_notifs_read(ids)   ·   jag_agent_clients() now carries journey + invited_by.
-- Anon:      jag_invite_public(token, count)  → who invited them, prefill.
-- Client:    jag_invite_accept(token)         → ties the new account to the agent, notifies the agent.
-- Any new account whose email/phone matches an open invite is matched automatically (trigger on jag_clients).
-- ============================================================

create table if not exists public.jag_invites (
  id uuid primary key default gen_random_uuid(),
  token text not null unique default encode(extensions.gen_random_bytes(10), 'hex'),
  agent_code text not null,
  created_by uuid default auth.uid(),
  name text check (char_length(name) <= 120),
  email text check (char_length(email) <= 200),
  phone text check (char_length(phone) <= 40),
  lang text not null default 'es' check (lang in ('es','en')),
  note text check (char_length(note) <= 1000),
  status text not null default 'invited' check (status in ('invited','opened','joined','cancelled')),
  channel text,
  sent_count int not null default 0,
  sent_at timestamptz,
  opens int not null default 0,
  first_open_at timestamptz,
  last_open_at timestamptz,
  user_id uuid,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jag_invites_agent on public.jag_invites (agent_code, created_at desc);
create index if not exists jag_invites_user on public.jag_invites (user_id);
alter table public.jag_invites enable row level security;

create table if not exists public.jag_agent_notifs (
  id bigint generated always as identity primary key,
  agent_code text not null,
  kind text not null,
  title text not null,
  body text,
  user_id uuid,
  invite_id uuid,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists jag_agent_notifs_agent on public.jag_agent_notifs (agent_code, created_at desc);
alter table public.jag_agent_notifs enable row level security;

create or replace function public.jag_digits10(p text) returns text language sql immutable set search_path = '' as $$
  select case when length(d) = 10 then d end from (select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10) d) x;
$$;

-- Leads and admins see every invite; agents see their own.
create or replace function public.jag_invite_can_see_all() returns boolean language sql stable security definer set search_path = '' as $$
  select public.jag_is_staff() or public.jag_has_role('lead');
$$;

/* ---------- team: make the profile + link ---------- */
create or replace function public.jag_invite_create(p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_code text := public.jag_agent_code_me(); v_name text; v_email text; v_phone text; v_lang text; i public.jag_invites; v_cl public.jag_clients; v_reused boolean := false;
begin
  if v_code is null then
    if public.jag_is_staff() then v_code := 'jason'; else return json_build_object('ok', false, 'reason', 'not_agent'); end if;
  end if;
  v_name := nullif(btrim(left(p->>'name', 120)), '');
  v_email := lower(nullif(btrim(left(p->>'email', 200)), ''));
  v_phone := nullif(btrim(left(p->>'phone', 40)), '');
  v_lang := case when p->>'lang' = 'en' then 'en' else 'es' end;
  if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then return json_build_object('ok', false, 'reason', 'email'); end if;
  if v_name is null and v_email is null and v_phone is null then return json_build_object('ok', false, 'reason', 'empty'); end if;

  -- already has an account?
  select * into v_cl from public.jag_clients c
   where (v_email is not null and lower(c.email) = v_email)
      or (public.jag_digits10(v_phone) is not null and public.jag_digits10(c.phone) = public.jag_digits10(v_phone))
   limit 1;

  -- the sheet keeps editing the same invite (p.id) while the agent types
  if coalesce(p->>'id', '') ~ '^[0-9a-f-]{36}$' then
    select * into i from public.jag_invites x where x.id = (p->>'id')::uuid and x.agent_code = v_code and x.status in ('invited','opened');
  end if;
  -- otherwise reuse this agent's open invite for the same person (no duplicate links)
  if i.id is null then
    select * into i from public.jag_invites x
     where x.agent_code = v_code and x.status in ('invited','opened')
       and ((v_email is not null and lower(x.email) = v_email)
         or (public.jag_digits10(v_phone) is not null and public.jag_digits10(x.phone) = public.jag_digits10(v_phone)))
     order by x.created_at desc limit 1;
  end if;
  if i.id is not null then
    v_reused := true;
    update public.jag_invites set name = coalesce(v_name, name), email = case when p ? 'email' then v_email else email end,
      phone = case when p ? 'phone' then v_phone else phone end, lang = v_lang,
      note = case when p ? 'note' then nullif(btrim(left(p->>'note', 1000)), '') else note end, updated_at = now()
     where id = i.id returning * into i;
  else
    insert into public.jag_invites (agent_code, name, email, phone, lang, note)
    values (v_code, v_name, v_email, v_phone, v_lang, nullif(btrim(left(p->>'note', 1000)), ''))
    returning * into i;
  end if;
  return json_build_object('ok', true, 'id', i.id, 'token', i.token, 'url', 'https://jasonaguirregroup.company/join#' || i.token,
    'agent_code', v_code, 'reused', v_reused,
    'existing', case when v_cl.user_id is null then null else json_build_object('user_id', v_cl.user_id, 'name', v_cl.name, 'agent_code', v_cl.agent_code) end);
end $function$;

create or replace function public.jag_invite_sent(p_id uuid, p_channel text)
returns json language plpgsql security definer set search_path = '' as $function$
begin
  if public.jag_agent_code_me() is null and not public.jag_is_staff() then return json_build_object('ok', false); end if;
  update public.jag_invites set sent_count = sent_count + 1, sent_at = now(), updated_at = now(),
    channel = case when p_channel in ('sms','email','whatsapp','share','copy') then p_channel else channel end
   where id = p_id;
  return json_build_object('ok', true);
end $function$;

create or replace function public.jag_invite_cancel(p_id uuid)
returns json language plpgsql security definer set search_path = '' as $function$
begin
  update public.jag_invites set status = 'cancelled', updated_at = now()
   where id = p_id and status <> 'joined' and (agent_code = public.jag_agent_code_me() or public.jag_invite_can_see_all());
  return json_build_object('ok', found);
end $function$;

create or replace function public.jag_invite_list()
returns json language plpgsql stable security definer set search_path = '' as $function$
declare v_code text := public.jag_agent_code_me(); v_all boolean := public.jag_invite_can_see_all();
begin
  if v_code is null and not v_all then return json_build_object('ok', false); end if;
  return json_build_object('ok', true, 'invites', coalesce((select json_agg(x order by x.created_at desc) from (
    select i.id, i.token, i.agent_code, a.first_name as agent_first, i.name, i.email, i.phone, i.lang, i.note, i.status, i.channel,
           i.sent_count, i.sent_at, i.opens, i.first_open_at, i.last_open_at, i.user_id, i.joined_at, i.created_at
      from public.jag_invites i left join public.jag_agents a on a.code = i.agent_code
     where i.status <> 'cancelled' and (v_all or i.agent_code = v_code)
       and (i.status <> 'joined' or i.joined_at > now() - interval '30 days')
     order by i.created_at desc limit 200) x), '[]'::json));
end $function$;

/* ---------- notifications ---------- */
create or replace function public.jag_notify_agent(p_code text, p_kind text, p_title text, p_body text, p_user uuid, p_invite uuid, p_text text default null)
returns void language plpgsql security definer set search_path = '' as $function$
declare v_member int;
begin
  if p_code is null then return; end if;
  insert into public.jag_agent_notifs (agent_code, kind, title, body, user_id, invite_id) values (p_code, p_kind, p_title, p_body, p_user, p_invite);
  if p_text is not null then
    begin   -- the Lola text is a bonus: it must never undo the notification or a sign-up
      select t.id into v_member from public.jag_agents ag join ops.team t on t.fub_user_id = ag.fub_user_id and t.active where ag.code = p_code;
      if v_member is not null then
        perform ops.lola_text(v_member, p_text, 'invite_' || p_kind, null);
        perform ops.kick_team_texts();
      end if;
    exception when others then null;
    end;
  end if;
end $function$;

create or replace function public.jag_notifs(p_limit int default 30)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare v_code text := public.jag_agent_code_me();
begin
  if v_code is null then return json_build_object('ok', true, 'unread', 0, 'items', '[]'::json); end if;
  return json_build_object('ok', true,
    'unread', (select count(*) from public.jag_agent_notifs where agent_code = v_code and read_at is null),
    'items', coalesce((select json_agg(n order by n.created_at desc) from (
      select id, kind, title, body, user_id, invite_id, created_at, read_at from public.jag_agent_notifs
       where agent_code = v_code order by created_at desc limit greatest(1, least(coalesce(p_limit, 30), 100))) n), '[]'::json));
end $function$;

create or replace function public.jag_notifs_read(p_ids bigint[] default null)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_code text := public.jag_agent_code_me();
begin
  update public.jag_agent_notifs set read_at = now()
   where agent_code = v_code and read_at is null and (p_ids is null or id = any(p_ids));
  return json_build_object('ok', true);
end $function$;

/* ---------- client side ---------- */
create or replace function public.jag_invite_public(p_token text, p_count boolean default true)
returns json language plpgsql security definer set search_path = '' as $function$
declare i public.jag_invites; a public.jag_agents;
begin
  select * into i from public.jag_invites where token = p_token and status <> 'cancelled';
  if i.id is null then return json_build_object('ok', false); end if;
  select * into a from public.jag_agents where code = i.agent_code;
  if p_count and i.status <> 'joined' then
    update public.jag_invites set opens = opens + 1, last_open_at = now(), first_open_at = coalesce(first_open_at, now()),
      status = case when status = 'invited' then 'opened' else status end, updated_at = now()
     where id = i.id;
    if i.first_open_at is null then
      perform public.jag_notify_agent(i.agent_code, 'opened', coalesce(i.name, i.email, 'Your client') || ' opened your invite',
        'They are on the sign-up page now.', null, i.id, null);
    end if;
  end if;
  return json_build_object('ok', true, 'name', i.name, 'email', i.email, 'phone', i.phone, 'lang', i.lang, 'joined', i.status = 'joined',
    'agent', json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name,
      'phone', coalesce(a.phone_override, a.phone), 'photo_url', a.photo_url));
end $function$;

-- the shared part: mark the invite joined, give the client to the agent (if nobody has them yet), tell the agent
create or replace function public.jag_invite_join(p_invite uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare i public.jag_invites; c public.jag_clients; v_name text;
begin
  update public.jag_invites set status = 'joined', user_id = p_user, joined_at = now(), updated_at = now()
   where id = p_invite and status <> 'joined' returning * into i;
  if i.id is null then return; end if;
  update public.jag_clients set agent_code = i.agent_code, agent_set_at = now() where user_id = p_user and agent_code is null;
  update public.jag_clients set name = coalesce(name, i.name), phone = coalesce(phone, i.phone) where user_id = p_user;
  select * into c from public.jag_clients where user_id = p_user;
  v_name := coalesce(c.name, i.name, c.email, 'Your client');
  perform public.jag_notify_agent(i.agent_code, 'joined', v_name || ' created their account 🎉',
    'They are in your Contacts now. Next step: screen them or send homes.', p_user, i.id,
    '🎉 ' || v_name || ' just accepted your invite and created their JAG account. They''re in your Contacts. Strike while it''s hot, babe: https://jasonaguirregroup.company/workspace#hub');
end $function$;

create or replace function public.jag_invite_accept(p_token text)
returns json language plpgsql security definer set search_path = '' as $function$
declare i public.jag_invites;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  if not exists (select 1 from public.jag_clients where user_id = auth.uid()) then return json_build_object('ok', false, 'reason', 'no_account'); end if;
  select * into i from public.jag_invites where token = p_token and status <> 'cancelled';
  if i.id is null then return json_build_object('ok', false, 'reason', 'invite'); end if;
  if i.status <> 'joined' then perform public.jag_invite_join(i.id, auth.uid()); end if;
  return json_build_object('ok', true, 'agent_code', (select agent_code from public.jag_clients where user_id = auth.uid()));
end $function$;

-- someone signs up some other way: match an open invite by email or phone
create or replace function public.jag_clients_match_invite()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_id uuid;
begin
  select x.id into v_id from public.jag_invites x
   where x.status in ('invited','opened')
     and ((new.email is not null and lower(x.email) = lower(new.email))
       or (public.jag_digits10(new.phone) is not null and public.jag_digits10(x.phone) = public.jag_digits10(new.phone)))
   order by x.created_at desc limit 1;
  if v_id is not null then perform public.jag_invite_join(v_id, new.user_id); end if;
  return null;
exception when others then return null;
end $function$;
drop trigger if exists jag_clients_match_invite on public.jag_clients;
create trigger jag_clients_match_invite after insert on public.jag_clients for each row execute function public.jag_clients_match_invite();

/* ---------- where each client is ---------- */
create or replace function public.jag_client_journey(p_user uuid)
returns json language sql stable security definer set search_path = '' as $function$
  with c as (select * from public.jag_clients where user_id = p_user),
  k as (select lower(btrim(coalesce(c.email, ''))) as em, public.jag_digits10(c.phone) as ph from c)
  select json_build_object(
    'joined', (select created_at from c),
    'invite', (select json_build_object('at', i.created_at, 'by', i.agent_code) from public.jag_invites i where i.user_id = p_user order by i.created_at limit 1),
    'screen', (select json_build_object('id', s.id, 'at', s.created_at, 'lane', s.lane, 'score', s.score, 'hot', s.hot, 'by', s.screener)
                 from public.jag_screenings s, k
                where (k.em like '%@%' and lower(btrim(s.email)) = k.em) or (k.ph is not null and public.jag_digits10(s.phone) = k.ph)
                order by s.created_at desc limit 1),
    'app', (select json_build_object('at', a.created_at, 'status', a.status) from public.jag_client_app(p_user) a where a.id is not null),
    'loan', public.jag_loan_state(p_user),
    'proof', (select kind from public.jag_client_proof where user_id = p_user and status = 'verified' order by reviewed_at desc limit 1),
    'looking', json_build_object(
       'views', (select count(*) from public.jag_client_activity where user_id = p_user and kind = 'view'),
       'saved', (select count(*) from public.jag_client_favorites where user_id = p_user),
       'searches', (select count(*) from public.jag_client_searches where user_id = p_user),
       'last', (select max(created_at) from public.jag_client_activity where user_id = p_user)),
    'sent', (select json_build_object('n', count(*), 'last', max(h.created_at)) from public.jag_homes_sent h, k
              where h.user_id = p_user or (k.em like '%@%' and lower(h.email) = k.em) or (k.ph is not null and public.jag_digits10(h.phone) = k.ph)),
    'lists', (select json_build_object('n', count(*), 'last', max(coalesce(x.last_sent_at, x.created_at)), 'id', (array_agg(x.id order by x.updated_at desc))[1])
                from public.jag_carts x, k
               where not x.archived and (x.user_id = p_user or (k.em like '%@%' and lower(x.email) = k.em) or (k.ph is not null and public.jag_digits10(x.phone) = k.ph))),
    'show', json_build_object(
       'req', (select count(*) from public.jag_showing_requests where user_id = p_user),
       'tours', (select count(*) from public.jag_tours where user_id = p_user and status <> 'cancelled'),
       'done', (select count(*) from public.jag_tours where user_id = p_user and status = 'done'),
       'next', (select min(tour_date) from public.jag_tours where user_id = p_user and status in ('requested','scheduling','scheduled') and tour_date >= current_date)),
    'offer', (select json_build_object('n', count(*), 'last', (array_agg(status order by created_at desc))[1], 'at', max(created_at))
                from public.jag_offers where user_id = p_user having count(*) > 0));
$function$;

-- the Agent Hub list, now with the journey and who invited them
create or replace function public.jag_agent_clients()
returns json language plpgsql stable security definer set search_path = '' as $function$
declare v_code text := public.jag_agent_code_me();
begin
  if v_code is null and not public.jag_is_staff() then return json_build_object('ok', false, 'reason', 'not_agent'); end if;
  return json_build_object('ok', true, 'me', v_code, 'clients', coalesce((
    select json_agg(x order by x.tier, x.score desc nulls last, x.last_seen_at desc nulls last) from (
      select z.*, case when (z.priority->>'proof') is not null then 1 when (z.priority->>'in_contact')::boolean then 2 else 3 end as tier
      from (
      select c.user_id, c.name, c.email, c.phone, c.lang, c.created_at, c.last_seen_at, c.agent_code, c.alert_freq,
             c.contact_pref, c.contact_time, c.showing_agent_code, c.sms_ok_at is not null as sms_ok,
             (select string_agg(coalesce(nullif(x2.name, ''), x2.email), ', ') from public.jag_clients x2
               where x2.user_id in (select public.jag_household(c.user_id)) and x2.user_id <> c.user_id) as buys_with,
             s.score, s.tags, s.top_zip, s.best_hour, s.homes, s.last_hot_at,
             public.jag_client_priority(c.user_id) as priority,
             public.jag_client_journey(c.user_id) as journey,
             (select count(distinct (a.created_at at time zone 'America/Chicago')::date) from public.jag_client_activity a
               where a.user_id = c.user_id and a.created_at > now() - interval '7 days') as days_7,
             (select count(distinct (a.created_at at time zone 'America/Chicago')::date) from public.jag_client_activity a
               where a.user_id = c.user_id and a.created_at > now() - interval '30 days') as days_30,
             (select count(*) from public.jag_client_activity a where a.user_id = c.user_id and a.kind = 'view'
               and a.created_at > now() - interval '30 days') as views_30,
             (select count(*) from public.jag_client_favorites f where f.user_id = c.user_id) as favorites,
             (select count(*) from public.jag_client_searches q where q.user_id = c.user_id) as searches,
             (select max(q.fub_person_id) from public.jag_fub_queue q where q.user_id = c.user_id) as fub_person_id
        from public.jag_clients c
        left join public.jag_client_scores s on s.user_id = c.user_id) z) x), '[]'::json),
    'shares', coalesce((select json_agg(y order by y.created_at desc) from (
      select id, kind, mls, label, channel, created_at, opens, last_open_at from public.jag_agent_shares
       where agent_code = v_code order by created_at desc limit 40) y), '[]'::json));
end $function$;

revoke all on function public.jag_invite_create(jsonb), public.jag_invite_sent(uuid, text), public.jag_invite_cancel(uuid), public.jag_invite_list(),
  public.jag_notifs(int), public.jag_notifs_read(bigint[]), public.jag_invite_accept(text), public.jag_client_journey(uuid),
  public.jag_invite_can_see_all() from public, anon;
grant execute on function public.jag_invite_create(jsonb), public.jag_invite_sent(uuid, text), public.jag_invite_cancel(uuid), public.jag_invite_list(),
  public.jag_notifs(int), public.jag_notifs_read(bigint[]), public.jag_invite_accept(text), public.jag_invite_can_see_all() to authenticated;
revoke all on function public.jag_notify_agent(text, text, text, text, uuid, uuid, text), public.jag_invite_join(uuid, uuid),
  public.jag_clients_match_invite() from public, anon, authenticated;
grant execute on function public.jag_invite_public(text, boolean) to anon, authenticated;
