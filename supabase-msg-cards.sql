-- ============================================================
-- Homes (and searches) sent to a client's JAG account.
-- The agent taps "A su cuenta JAG" in the share sheet → a message with a home card lands in the client's
-- Mensajes (red badge in the app). The usual Mensajes notices go out (n8n "JAG Site · Messages"):
-- email always, a text from Lola when the client opted in AND ops.settings msg_client_sms is on, + FUB note.
-- ============================================================

alter table public.jag_messages add column if not exists card jsonb;   -- {kind, mls, url, title, price, beds, baths, sqft, photo, city}

-- keep only the fields the app shows, as short text/numbers
create or replace function public.jag_msg_clean_card(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when p is null or jsonb_typeof(p) <> 'object' then null else jsonb_strip_nulls(jsonb_build_object(
    'kind', case when p->>'kind' in ('listing','search','site') then p->>'kind' else 'listing' end,
    'mls', left(p->>'mls', 30),
    'url', case when p->>'url' ~ '^https://(www\.)?jasonaguirregroup\.(company|us)/' then left(p->>'url', 500) end,
    'title', left(p->>'title', 160), 'city', left(p->>'city', 60),
    'price', case when p->>'price' ~ '^\d{1,10}(\.\d+)?$' then (p->>'price')::numeric end,
    'beds', case when p->>'beds' ~ '^\d{1,2}(\.\d)?$' then (p->>'beds')::numeric end,
    'baths', case when p->>'baths' ~ '^\d{1,2}(\.\d)?$' then (p->>'baths')::numeric end,
    'sqft', case when p->>'sqft' ~ '^\d{1,6}$' then (p->>'sqft')::int end,
    'photo', case when p->>'photo' ~ '^[A-Za-z0-9/_.\-]{1,200}$' then p->>'photo' end)) end;
$$;

-- team: send a home / search to a client's account (lands in their Mensajes)
create or replace function public.jag_msg_share(p_user uuid, p_body text, p_card jsonb)
returns json language plpgsql security definer set search_path = '' as $$
declare v_code text := public.jag_agent_code_me(); a public.jag_agents; v_id bigint; v_body text := btrim(coalesce(p_body, ''));
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if not exists (select 1 from public.jag_clients where user_id = p_user) then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_body = '' and p_card is null then return json_build_object('ok', false, 'reason', 'empty'); end if;
  select * into a from public.jag_agents where code = v_code;
  insert into public.jag_messages (user_id, agent_code, sender, sender_name, body, via, card)
  values (p_user, coalesce(v_code, public.jag_msg_agent_of(p_user)), 'agent', coalesce(a.first_name, a.name, 'JAG'),
          left(coalesce(nullif(v_body, ''), coalesce(p_card->>'title', 'Casa')), 2000), 'hub', public.jag_msg_clean_card(p_card))
  returning id into v_id;
  begin perform ops.kick_messages(); exception when others then null; end;
  return json_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.jag_msg_share(uuid, text, jsonb) from public, anon;
grant execute on function public.jag_msg_share(uuid, text, jsonb) to authenticated;

-- threads now include the card
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
    'messages', coalesce((select json_agg(json_build_object('id', m.id, 'at', m.created_at, 'from', m.sender, 'name', m.sender_name, 'body', m.body, 'read', m.read_at is not null, 'card', m.card) order by m.id)
      from (select * from public.jag_messages where user_id = v_uid order by id desc limit 200) m), '[]'::json));
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
    'messages', coalesce((select json_agg(json_build_object('id', m.id, 'at', m.created_at, 'from', m.sender, 'name', m.sender_name, 'body', m.body, 'via', m.via, 'read', m.read_at is not null, 'card', m.card) order by m.id)
      from (select * from public.jag_messages where user_id = p_user order by id desc limit 300) m), '[]'::json));
end $$;

-- n8n gets the card too (text wording: "le envió una casa")
create or replace function public.jag_msg_pending(p_limit int default 20)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x order by x.id), '[]'::json) from (
    select m.id, m.created_at, m.sender, m.sender_name, m.body, m.via, m.user_id, m.fub_at, m.card,
           c.name as client_name, c.email as client_email, c.phone as client_phone, coalesce(c.lang, 'es') as client_lang,
           (c.sms_ok_at is not null and coalesce(ops.s_text('msg_client_sms'), 'false') = 'true') as client_sms,
           a.code as agent_code, a.name as agent_name, a.first_name as agent_first, a.fub_user_id as agent_fub_user_id,
           t.id as agent_member_id, t.mobile_e164 as agent_mobile,
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
