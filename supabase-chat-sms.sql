-- Website chat → text follow-up, and client texts back to the JAG line (346-644-8697).
-- (applied as migration jag_chat_sms, 2026-10-27)
--  * jag_chat_sms_due(): chats where the visitor went quiet 10+ min after the AI's answer get ONE follow-up text
--    (Texas texting hours: Mon–Sat 9 AM–9 PM, Sun noon–9 PM CT). Claims the rows so nothing is sent twice.
--  * ops_client_text_inbound(): a text from someone who isn't on the team. STOP → opt out. An open website chat →
--    the chat AI answers by text (route 'ai'), Lola tells the team. A home-search account → it lands in their
--    Mensajes thread (route 'mensajes'). Anyone else → Lola forwards it to the team (route 'team').

alter table public.jag_chat_sessions add column if not exists sms_followup_at timestamptz;
alter table public.jag_chat_sessions add column if not exists sms_opt_out boolean not null default false;
alter table public.jag_chat_sessions add column if not exists sms_ai_off boolean not null default false;
alter table public.jag_chat_sessions add column if not exists last_sms_in_at timestamptz;
alter table public.jag_chat_sessions add column if not exists last_sms_out_at timestamptz;
alter table public.jag_chat_messages add column if not exists channel text not null default 'web';

create table if not exists public.jag_sms_optouts (phone text primary key, created_at timestamptz not null default now(), body text, active boolean not null default true);
alter table public.jag_sms_optouts enable row level security;

-- chat history saved per turn; texts are marked as such
create or replace function public.jag_chat_save(p jsonb)
returns json language plpgsql security definer set search_path = '' as $$
declare v_id text := left(p->>'sessionId', 80); v_ch text := case when p->>'channel' = 'sms' then 'sms' else 'web' end;
begin
  insert into public.jag_chat_messages (session_id, role, text, channel) values (v_id, 'user', left(p->>'message', 2000), v_ch);
  if coalesce(p->>'reply', '') <> '' then
    insert into public.jag_chat_messages (session_id, role, text, channel) values (v_id, 'assistant', left(p->>'reply', 4000), v_ch);
  end if;
  update public.jag_chat_sessions set
    lead_type = coalesce(nullif(p->>'lead_type', ''), lead_type),
    call_requested = call_requested or coalesce((p->>'call_requested')::boolean, false),
    preferred_time = coalesce(nullif(p->>'preferred_time', ''), preferred_time),
    summary = coalesce(nullif(p->>'summary', ''), summary),
    fub_person_id = coalesce((nullif(p->>'fub_person_id', ''))::bigint, fub_person_id),
    team_alerted_at = case when coalesce((p->>'team_alerted')::boolean, false) then coalesce(team_alerted_at, now()) else team_alerted_at end,
    call_alerted_at = case when coalesce((p->>'call_alerted')::boolean, false) then coalesce(call_alerted_at, now()) else call_alerted_at end,
    last_sms_in_at = case when v_ch = 'sms' then now() else last_sms_in_at end,
    last_sms_out_at = case when v_ch = 'sms' and coalesce(p->>'reply', '') <> '' then now() else last_sms_out_at end,
    updated_at = now()
  where session_id = v_id;
  return json_build_object('ok', true);
end $$;

create or replace function public.jag_texting_hours()
returns boolean language sql stable set search_path = '' as $$
  select case when extract(dow from now() at time zone 'America/Chicago') = 0
              then extract(hour from now() at time zone 'America/Chicago') between 12 and 20
              else extract(hour from now() at time zone 'America/Chicago') between 9 and 20 end;
$$;

-- chats that need the one follow-up text now (service role only); claims them
create or replace function public.jag_chat_sms_due()
returns json language plpgsql security definer set search_path = '' as $$
declare v json;
begin
  if coalesce(auth.role(), '') <> 'service_role' then return '[]'::json; end if;
  if not public.jag_texting_hours() then return '[]'::json; end if;
  if coalesce((select value::text from ops.settings where key = 'chat_sms_followup'), 'true') = 'false' then return '[]'::json; end if;
  with due as (
    select s.session_id from public.jag_chat_sessions s
     where s.sms_followup_at is null and not s.sms_opt_out and not s.sms_ai_off
       and length(public.jag_digits10(s.phone)) = 10
       and s.created_at > now() - interval '24 hours'
       and not exists (select 1 from public.jag_sms_optouts o where o.phone = public.jag_digits10(s.phone) and o.active)
       and (select m.role from public.jag_chat_messages m where m.session_id = s.session_id order by m.id desc limit 1) = 'assistant'
       and (select max(m.created_at) from public.jag_chat_messages m where m.session_id = s.session_id) < now() - interval '10 minutes'
       -- one follow-up per person per week, even across chats
       and not exists (select 1 from public.jag_chat_sessions o where public.jag_digits10(o.phone) = public.jag_digits10(s.phone)
                         and o.sms_followup_at > now() - interval '7 days')
     order by s.created_at limit 5 for update skip locked
  ), claimed as (
    update public.jag_chat_sessions s set sms_followup_at = now() from due where s.session_id = due.session_id returning s.*
  )
  select coalesce(json_agg(json_build_object('session_id', c.session_id, 'name', c.name, 'phone', '+1' || public.jag_digits10(c.phone),
      'lang', coalesce(c.lang, 'es'), 'listing', c.listing, 'summary', c.summary, 'lead_type', c.lead_type, 'call_requested', c.call_requested,
      'fub_person_id', c.fub_person_id,
      'agent', (select json_build_object('name', a.name, 'first_name', a.first_name) from public.jag_agents a where a.code = c.agent_code),
      'loan_app', (select json_build_object('at', l.created_at, 'status', l.status) from public.jag_leads l where l.type = 'Mortgage Application'
                    and public.jag_digits10(l.phone) = public.jag_digits10(c.phone) and coalesce(l.status, '') <> 'Merged' order by l.created_at desc limit 1),
      'history', (select json_agg(json_build_object('role', m.role, 'text', m.text) order by m.id) from public.jag_chat_messages m where m.session_id = c.session_id))), '[]'::json)
    into v from claimed c;
  return v;
end $$;
revoke all on function public.jag_chat_sms_due() from public, anon, authenticated;

create or replace function public.jag_chat_sms_mark(p_session text, p_text text, p_sid text default null, p_error text default null)
returns json language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then return json_build_object('ok', false); end if;
  if p_error is null and coalesce(p_text, '') <> '' then
    insert into public.jag_chat_messages (session_id, role, text, channel) values (p_session, 'assistant', left(p_text, 2000), 'sms');
    update public.jag_chat_sessions set last_sms_out_at = now(), updated_at = now() where session_id = p_session;
  end if;
  return json_build_object('ok', true);
end $$;
revoke all on function public.jag_chat_sms_mark(text, text, text, text) from public, anon, authenticated;

-- a text to the JAG line from someone who isn't on the team (service role only)
create or replace function public.ops_client_text_inbound(p_from text, p_body text, p_sid text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare v_ph text := public.jag_digits10(p_from); v_body text := btrim(coalesce(p_body, '')); s public.jag_chat_sessions; c public.jag_clients;
  v_last_msg timestamptz; v_ai_count int; l public.jag_leads; v_route text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then return json_build_object('ok', false); end if;
  if length(v_ph) <> 10 then return json_build_object('ok', false, 'reason', 'phone'); end if;
  select * into s from public.jag_chat_sessions where public.jag_digits10(phone) = v_ph and updated_at > now() - interval '14 days' order by updated_at desc limit 1;
  select * into c from public.jag_clients where public.jag_digits10(phone) = v_ph order by last_seen_at desc nulls last limit 1;
  select * into l from public.jag_leads where public.jag_digits10(phone) = v_ph and coalesce(status, '') <> 'Merged' order by (type = 'Mortgage Application') desc, created_at desc limit 1;
  -- STOP / START keywords (Twilio also blocks the number on STOP)
  if upper(v_body) ~ '^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|ALTO|PARAR|BASTA)\W*$' then
    insert into public.jag_sms_optouts (phone, body) values (v_ph, left(v_body, 200)) on conflict (phone) do update set created_at = now(), body = excluded.body, active = true;
    update public.jag_chat_sessions set sms_opt_out = true where public.jag_digits10(phone) = v_ph;
    update public.jag_clients set sms_ok_at = null where public.jag_digits10(phone) = v_ph;
    return json_build_object('ok', true, 'route', 'stop', 'name', coalesce(s.name, c.name, l.name), 'fub_person_id', s.fub_person_id);
  end if;
  if upper(v_body) ~ '^(START|UNSTOP|YES)\W*$' then
    update public.jag_sms_optouts set active = false where phone = v_ph;
    update public.jag_chat_sessions set sms_opt_out = false where public.jag_digits10(phone) = v_ph;
  end if;
  -- their agent's last Mensajes reply to them, if they have an account
  if c.user_id is not null then
    select max(created_at) into v_last_msg from public.jag_messages where user_id = public.jag_household_of(c.user_id) and sender = 'agent';
  end if;
  if s.session_id is not null and (v_last_msg is null or s.updated_at >= v_last_msg) then
    select count(*) into v_ai_count from public.jag_chat_messages where session_id = s.session_id and role = 'assistant' and channel = 'sms';
    v_route := case when s.sms_ai_off or s.sms_opt_out or v_ai_count >= 8 or s.created_at < now() - interval '7 days' then 'team' else 'ai' end;
    if v_route = 'team' then
      insert into public.jag_chat_messages (session_id, role, text, channel) values (s.session_id, 'user', left(v_body, 2000), 'sms');
      update public.jag_chat_sessions set last_sms_in_at = now(), updated_at = now() where session_id = s.session_id;
    end if;
    return json_build_object('ok', true, 'route', v_route, 'session_id', s.session_id, 'name', s.name, 'phone', v_ph, 'lang', coalesce(s.lang, 'es'),
      'fub_person_id', s.fub_person_id, 'listing', s.listing, 'body', v_body);
  end if;
  if c.user_id is not null then
    insert into public.jag_messages (user_id, agent_code, sender, sender_name, body, via)
    values (public.jag_household_of(c.user_id), c.agent_code, 'client', coalesce(nullif(c.name, ''), c.email), left(v_body, 2000), 'sms');
    begin perform ops.kick_messages(); exception when others then null; end;
    return json_build_object('ok', true, 'route', 'mensajes', 'name', c.name, 'phone', v_ph);
  end if;
  return json_build_object('ok', true, 'route', 'team', 'name', coalesce(l.name, null), 'phone', v_ph, 'body', v_body, 'lead_type', l.type,
    'fub_link', l.payload->>'Follow Up Boss');
end $$;
revoke all on function public.ops_client_text_inbound(text, text, text) from public, anon, authenticated;
