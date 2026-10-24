-- ============================================================
-- Mensajes: a chat thread between each website client and their dedicated agent.
--   Client (account page)  → jag_msg_thread, jag_msg_send, jag_msg_unread, jag_msg_status, jag_msg_sms
--   Agent (Agent Hub)      → jag_msg_inbox, jag_msg_team_thread, jag_msg_reply
--   Agent by text          → jag_msg_agent_text (called by n8n "JAG Ops · Text line" when a teammate texts Lola "R: …")
--   Notifications (n8n "JAG Site · Messages", kicked by ops.kick_messages):
--     client wrote → Lola texts the agent (8 AM–9 PM Houston) + FUB note
--     agent wrote  → client gets an email (+ a text only if they agreed and ops.settings msg_client_sms is on) + FUB note
-- ============================================================

alter table public.jag_clients add column if not exists sms_ok_at timestamptz;   -- client agreed to texts about new messages

create table if not exists public.jag_messages (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null references public.jag_clients(user_id) on delete cascade,
  agent_code text,
  sender text not null check (sender in ('client', 'agent')),
  sender_name text,
  body text not null check (char_length(body) between 1 and 2000),
  via text not null default 'app',          -- app | hub | sms
  read_at timestamptz,                      -- read by the other side
  notify_at timestamptz,                    -- other side notified (or skipped on purpose)
  fub_at timestamptz,
  tries int not null default 0,
  error text
);
create index if not exists jag_messages_thread_idx on public.jag_messages (user_id, id);
create index if not exists jag_messages_pending_idx on public.jag_messages (id) where notify_at is null;
alter table public.jag_messages enable row level security;
do $p$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'jag_messages' and policyname = 'clients read their own messages') then
    create policy "clients read their own messages" on public.jag_messages for select to authenticated using (user_id = auth.uid());
  end if;
end $p$;

insert into ops.settings (key, value, note)
values ('msg_client_sms', 'false'::jsonb, 'Text clients (from 346-644-8697) when their agent answers in Mensajes. Only for clients who opted in. Turn on once the Twilio A2P campaign covers client notifications.')
on conflict (key) do nothing;

-- the client's agent (assigned, or the default agent)
create or replace function public.jag_msg_agent_of(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select c.agent_code from public.jag_clients c where c.user_id = p_user),
                  (select a.code from public.jag_agents a where a.active and a.code = coalesce(ops.s_text('default_agent'), 'jason')));
$$;

-- wake n8n when something needs a text / email / FUB note
create or replace function ops.kick_messages()
returns text language plpgsql security definer set search_path = '' as $function$
declare v_secret text; v_req bigint;
begin
  if not exists (select 1 from public.jag_messages m where m.notify_at is null and m.tries < 5) then return 'idle'; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'jag_ops_watchdog_secret';
  select net.http_post(url := 'https://toomuchtaco.app.n8n.cloud/webhook/jag-site-messages',
    body := jsonb_build_object('source', 'jag-site-kick', 'which', 'messages', 'at', now()),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-JAG-Ops-Secret', v_secret), timeout_milliseconds := 5000) into v_req;
  insert into ops.site_kicks (which, request_id) values ('messages', v_req);
  return 'kicked';
end $function$;

-- ---------- client ----------
create or replace function public.jag_msg_thread()
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_code text; a public.jag_agents;
begin
  if v_uid is null or not exists (select 1 from public.jag_clients where user_id = v_uid) then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  update public.jag_messages set read_at = now() where user_id = v_uid and sender = 'agent' and read_at is null;
  v_code := public.jag_msg_agent_of(v_uid);
  select * into a from public.jag_agents where code = v_code;
  return json_build_object('ok', true,
    'agent', case when a.code is null then null else json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'photo_url', a.photo_url, 'phone', a.phone) end,
    'sms_ok', (select sms_ok_at is not null from public.jag_clients where user_id = v_uid),
    'messages', coalesce((select json_agg(json_build_object('id', m.id, 'at', m.created_at, 'from', m.sender, 'name', m.sender_name, 'body', m.body, 'read', m.read_at is not null) order by m.id)
      from (select * from public.jag_messages where user_id = v_uid order by id desc limit 200) m), '[]'::json));
end $$;

create or replace function public.jag_msg_send(p_body text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); c public.jag_clients; v_id bigint; v_body text := btrim(coalesce(p_body, ''));
begin
  select * into c from public.jag_clients where user_id = v_uid;
  if v_uid is null or c.user_id is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  if v_body = '' then return json_build_object('ok', false, 'reason', 'empty'); end if;
  if (select count(*) from public.jag_messages where user_id = v_uid and sender = 'client' and created_at > now() - interval '10 minutes') >= 20 then
    return json_build_object('ok', false, 'reason', 'limit');
  end if;
  insert into public.jag_messages (user_id, agent_code, sender, sender_name, body, via)
  values (v_uid, public.jag_msg_agent_of(v_uid), 'client', nullif(c.name, ''), left(v_body, 2000), 'app') returning id into v_id;
  begin perform ops.kick_messages(); exception when others then null; end;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.jag_msg_unread()
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.jag_messages where user_id = auth.uid() and sender = 'agent' and read_at is null;
$$;

create or replace function public.jag_msg_sms(p_on boolean)
returns json language sql security definer set search_path = '' as $$
  update public.jag_clients set sms_ok_at = case when p_on then now() end where user_id = auth.uid()
  returning json_build_object('ok', true, 'sms_ok', sms_ok_at is not null);
$$;

-- ---------- team (Agent Hub) ----------
create or replace function public.jag_msg_inbox()
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_me text := public.jag_agent_code_me();
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  return json_build_object('ok', true, 'me', v_me, 'threads', coalesce((select json_agg(x order by x.last_at desc) from (
    select c.user_id, c.name, c.email, c.phone, coalesce(c.agent_code, public.jag_msg_agent_of(c.user_id)) as agent_code, a.first_name as agent_first,
           l.body as last_body, l.created_at as last_at, l.sender as last_from,
           (select count(*) from public.jag_messages u where u.user_id = c.user_id and u.sender = 'client' and u.read_at is null) as unread,
           (coalesce(c.agent_code, public.jag_msg_agent_of(c.user_id)) = v_me) as mine
      from public.jag_clients c
      join lateral (select * from public.jag_messages m where m.user_id = c.user_id order by m.id desc limit 1) l on true
      left join public.jag_agents a on a.code = coalesce(c.agent_code, public.jag_msg_agent_of(c.user_id))
     order by l.created_at desc limit 300) x), '[]'::json));
end $$;

create or replace function public.jag_msg_team_thread(p_user uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare c public.jag_clients;
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_clients where user_id = p_user;
  if c.user_id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  update public.jag_messages set read_at = now() where user_id = p_user and sender = 'client' and read_at is null;
  return json_build_object('ok', true, 'client', json_build_object('user_id', c.user_id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'lang', c.lang),
    'messages', coalesce((select json_agg(json_build_object('id', m.id, 'at', m.created_at, 'from', m.sender, 'name', m.sender_name, 'body', m.body, 'via', m.via, 'read', m.read_at is not null) order by m.id)
      from (select * from public.jag_messages where user_id = p_user order by id desc limit 300) m), '[]'::json));
end $$;

create or replace function public.jag_msg_reply(p_user uuid, p_body text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_code text := public.jag_agent_code_me(); a public.jag_agents; v_id bigint; v_body text := btrim(coalesce(p_body, ''));
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if v_body = '' then return json_build_object('ok', false, 'reason', 'empty'); end if;
  if not exists (select 1 from public.jag_clients where user_id = p_user) then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into a from public.jag_agents where code = v_code;
  insert into public.jag_messages (user_id, agent_code, sender, sender_name, body, via, read_at)
  values (p_user, coalesce(v_code, public.jag_msg_agent_of(p_user)), 'agent', coalesce(a.first_name, a.name, 'JAG'), left(v_body, 2000), 'hub', null)
  returning id into v_id;
  update public.jag_messages set read_at = coalesce(read_at, now()) where user_id = p_user and sender = 'client';
  begin perform ops.kick_messages(); exception when others then null; end;
  return json_build_object('ok', true, 'id', v_id);
end $$;

-- ---------- agent replies by text ("R: …" or "R#123: …" to Lola) ----------
create or replace function public.jag_msg_agent_text(p_member_id int, p_body text, p_sid text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare t ops.team; a public.jag_agents; m public.jag_messages; v_ref bigint; v_text text; v_id bigint; v_name text; v_parts text[];
begin
  v_parts := regexp_match(coalesce(p_body, ''), '^\s*[Rr]\s*(?:#\s*(\d+))?\s*[:.\-]\s*(.+)$', 's');
  if v_parts is null then v_parts := regexp_match(coalesce(p_body, ''), '^\s*[Rr]\s*#\s*(\d+)\s+(.+)$', 's'); end if;
  if v_parts is null then return json_build_object('routed', false); end if;
  v_ref := nullif(v_parts[1], '')::bigint; v_text := btrim(v_parts[2]);
  if v_text = '' then return json_build_object('routed', false); end if;
  select * into t from ops.team where id = p_member_id;
  select * into a from public.jag_agents where fub_user_id = t.fub_user_id and active limit 1;
  if v_ref is not null then
    select * into m from public.jag_messages where id = v_ref and sender = 'client';
  else
    select * into m from public.jag_messages
     where sender = 'client' and created_at > now() - interval '7 days'
       and (agent_code = a.code or a.code is null)
     order by id desc limit 1;
  end if;
  if m.id is null then
    return json_build_object('routed', true, 'ok', false, 'reply', 'I couldn''t find a client message to answer. Open the Agent Hub > Mensajes to reply. - Lola');
  end if;
  insert into public.jag_messages (user_id, agent_code, sender, sender_name, body, via)
  values (m.user_id, coalesce(a.code, m.agent_code), 'agent', coalesce(a.first_name, t.name, 'JAG'), left(v_text, 2000), 'sms') returning id into v_id;
  update public.jag_messages set read_at = coalesce(read_at, now()) where user_id = m.user_id and sender = 'client';
  select split_part(coalesce(nullif(name, ''), 'your client'), ' ', 1) into v_name from public.jag_clients where user_id = m.user_id;
  begin perform ops.kick_messages(); exception when others then null; end;
  return json_build_object('routed', true, 'ok', true, 'id', v_id, 'reply', '✅ Sent to ' || coalesce(v_name, 'your client') || ' in the JAG app. - Lola');
end $$;

-- ---------- n8n ----------
create or replace function public.jag_msg_pending(p_limit int default 20)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x order by x.id), '[]'::json) from (
    select m.id, m.created_at, m.sender, m.sender_name, m.body, m.via, m.user_id, m.fub_at,   -- fub_at set = FUB note already added on an earlier try
           c.name as client_name, c.email as client_email, c.phone as client_phone, coalesce(c.lang, 'es') as client_lang,
           (c.sms_ok_at is not null and coalesce(ops.s_text('msg_client_sms'), 'false') = 'true') as client_sms,
           a.code as agent_code, a.name as agent_name, a.first_name as agent_first, a.fub_user_id as agent_fub_user_id,
           t.id as agent_member_id, t.mobile_e164 as agent_mobile,
           -- don't email the client again for every quick follow-up line: one notice per 15 minutes while they haven't read it
           (m.sender = 'agent' and exists (select 1 from public.jag_messages p where p.user_id = m.user_id and p.sender = 'agent' and p.id < m.id
              and p.notify_at > now() - interval '15 minutes' and p.read_at is null and p.error is null)) as quiet
      from public.jag_messages m
      join public.jag_clients c on c.user_id = m.user_id
      left join public.jag_agents a on a.code = coalesce(m.agent_code, public.jag_msg_agent_of(m.user_id))
      left join ops.team t on t.fub_user_id = a.fub_user_id and t.active and t.mobile_e164 is not null
     where m.notify_at is null and m.tries < 5
       and (m.sender = 'agent' or extract(hour from now() at time zone 'America/Chicago') between 8 and 20)
     order by m.id limit greatest(1, least(coalesce(p_limit, 20), 50))) x;
$$;

create or replace function public.jag_msg_mark(p_id bigint, p_ok boolean, p_fub boolean default false, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.jag_messages
     set notify_at = case when p_ok then now() end, fub_at = case when p_fub then now() else fub_at end,
         tries = tries + case when p_ok then 0 else 1 end, error = case when p_ok then null else left(p_error, 400) end
   where id = p_id and notify_at is null;
$$;

revoke all on function public.jag_msg_agent_of(uuid) from public, anon, authenticated;
revoke all on function ops.kick_messages() from public, anon, authenticated;
revoke all on function public.jag_msg_thread(), public.jag_msg_send(text), public.jag_msg_unread(), public.jag_msg_sms(boolean) from public, anon;
grant execute on function public.jag_msg_thread(), public.jag_msg_send(text), public.jag_msg_unread(), public.jag_msg_sms(boolean) to authenticated;
revoke all on function public.jag_msg_inbox(), public.jag_msg_team_thread(uuid), public.jag_msg_reply(uuid, text) from public, anon;
grant execute on function public.jag_msg_inbox(), public.jag_msg_team_thread(uuid), public.jag_msg_reply(uuid, text) to authenticated;
revoke all on function public.jag_msg_agent_text(int, text, text), public.jag_msg_pending(int), public.jag_msg_mark(bigint, boolean, boolean, text) from public, anon, authenticated;
grant execute on function public.jag_msg_agent_text(int, text, text), public.jag_msg_pending(int), public.jag_msg_mark(bigint, boolean, boolean, text) to service_role;

select cron.schedule('jag-site-messages-kick', '*/2 * * * *', $c$select ops.kick_messages()$c$);

-- small status for the account page: unread badge + whether text notices are offered (client SMS turned on in ops.settings)
create or replace function public.jag_msg_status()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'unread', (select count(*)::int from public.jag_messages where user_id = auth.uid() and sender = 'agent' and read_at is null),
    'sms_ok', coalesce((select sms_ok_at is not null from public.jag_clients where user_id = auth.uid()), false),
    'sms_live', coalesce(ops.s_text('msg_client_sms'), 'false') = 'true');
$$;
revoke all on function public.jag_msg_status() from public, anon;
grant execute on function public.jag_msg_status() to authenticated;
