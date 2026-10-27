-- ============================================================
-- Settings for clients (Mi perfil → Ajustes) and the team (Agent Hub / Admin → Settings).
-- Clients: separate alert switches, quiet hours, preferred contact method/time, co-buyer (shared favorites + Mensajes).
-- Team: which Lola texts they get (ops.team flags), working hours for client-message alerts, default note for sent homes.
-- ============================================================

/* ---------- client settings columns (clients may update only these + the earlier ones) ---------- */
alter table public.jag_clients add column if not exists notify jsonb;              -- {"new","price","status": instant|daily|off, "msgs": on|off}
alter table public.jag_clients add column if not exists quiet_from smallint;       -- Houston hour 0-23 (null = no quiet hours)
alter table public.jag_clients add column if not exists quiet_to smallint;
alter table public.jag_clients add column if not exists contact_pref text;         -- call | text | whatsapp | email
alter table public.jag_clients add column if not exists contact_time text;         -- morning | afternoon | evening | any
alter table public.jag_clients add column if not exists alerts_daily_on date;      -- last daily alert email (server only)
do $$ begin
  alter table public.jag_clients add constraint jag_clients_notify_ok check (notify is null or (jsonb_typeof(notify) = 'object'
    and coalesce(notify->>'new', 'instant') in ('instant','daily','off') and coalesce(notify->>'price', 'instant') in ('instant','daily','off')
    and coalesce(notify->>'status', 'instant') in ('instant','daily','off') and coalesce(notify->>'msgs', 'on') in ('on','off')));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.jag_clients add constraint jag_clients_quiet_ok check ((quiet_from is null or quiet_from between 0 and 23) and (quiet_to is null or quiet_to between 0 and 23));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.jag_clients add constraint jag_clients_contact_ok check ((contact_pref is null or contact_pref in ('call','text','whatsapp','email'))
    and (contact_time is null or contact_time in ('morning','afternoon','evening','any')));
exception when duplicate_object then null; end $$;
grant update (notify, quiet_from, quiet_to, contact_pref, contact_time) on public.jag_clients to authenticated;

/* ---------- quiet hours (Houston time) ---------- */
create or replace function public.jag_quiet_now(p_from smallint, p_to smallint)
returns boolean language sql stable set search_path = '' as $$
  select case when p_from is null or p_to is null or p_from = p_to then false
              when p_from < p_to then h >= p_from and h < p_to
              else h >= p_from or h < p_to end
    from (select extract(hour from now() at time zone 'America/Chicago')::int as h) x;
$$;

/* ---------- co-buyers: one main account + up to 3 people who share its favorites and Mensajes ---------- */
create table if not exists public.jag_client_cobuyers (
  id bigint generated always as identity primary key,
  owner uuid not null,                 -- the main account (jag_clients.user_id)
  email text not null, name text,
  member uuid,                         -- their account once they accept
  created_at timestamptz not null default now(),
  accepted_at timestamptz, declined_at timestamptz,   -- declined_at also marks "removed" / "left"
  email_sent_at timestamptz, email_error text
);
create unique index if not exists jag_client_cobuyers_owner_email on public.jag_client_cobuyers (owner, lower(email));
create index if not exists jag_client_cobuyers_email on public.jag_client_cobuyers (lower(email));
create index if not exists jag_client_cobuyers_member on public.jag_client_cobuyers (member);
alter table public.jag_client_cobuyers enable row level security;
do $$ begin create policy "staff reads cobuyers" on public.jag_client_cobuyers for select using (public.jag_is_staff()); exception when duplicate_object then null; end $$;

-- the main account of p's household (p itself when they aren't someone's co-buyer)
create or replace function public.jag_household_of(p uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce((select k.owner from public.jag_client_cobuyers k join public.jag_clients o on o.user_id = k.owner
                    where k.member = p and k.accepted_at is not null and k.declined_at is null order by k.accepted_at limit 1), p);
$$;
-- everyone in p's household (main account + accepted co-buyers who still have an account)
create or replace function public.jag_household(p uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  with h as (select public.jag_household_of(p) as owner)
  select h.owner from h
  union
  select k.member from public.jag_client_cobuyers k join h on k.owner = h.owner
   where k.accepted_at is not null and k.declined_at is null and k.member is not null
     and exists (select 1 from public.jag_clients c where c.user_id = k.member);
$$;
create or replace function public.jag_household_quiet(p uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.jag_clients c where c.user_id in (select public.jag_household(p)) and public.jag_quiet_now(c.quiet_from, c.quiet_to));
$$;
revoke all on function public.jag_household_of(uuid) from public, anon;
revoke all on function public.jag_household(uuid) from public, anon;
grant execute on function public.jag_household_of(uuid) to authenticated, service_role;
grant execute on function public.jag_household(uuid) to authenticated, service_role;

-- co-buyers see (and can un-save) each other's favorites
do $$ begin create policy "household reads favorites" on public.jag_client_favorites for select using (user_id in (select public.jag_household(auth.uid()))); exception when duplicate_object then null; end $$;

-- email the invite (edge function jag-client-email, server token)
create or replace function ops.kick_client_email(p_kind text, p_id bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_tok text; v_req bigint;
begin
  select decrypted_secret into v_tok from vault.decrypted_secrets where name = 'jag_alerts_token';
  select net.http_post(url := 'https://nyaxywghbpphjhwcmspd.supabase.co/functions/v1/jag-client-email',
    body := jsonb_build_object('kind', p_kind, 'id', p_id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jag-token', v_tok), timeout_milliseconds := 8000) into v_req;
  return v_req;
end $$;

create or replace function public.jag_cobuyer_list()
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); c public.jag_clients; v_owner uuid; o public.jag_clients;
begin
  select * into c from public.jag_clients where user_id = v_me;
  if v_me is null or c.user_id is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  v_owner := public.jag_household_of(v_me);
  select * into o from public.jag_clients where user_id = v_owner;
  return json_build_object('ok', true, 'role', case when v_owner = v_me then 'owner' else 'member' end,
    'owner', json_build_object('name', o.name, 'email', o.email),
    'people', coalesce((select json_agg(json_build_object('id', k.id, 'name', coalesce(m.name, k.name), 'email', k.email,
                 'status', case when k.accepted_at is not null then 'accepted' else 'pending' end, 'me', k.member = v_me) order by k.created_at)
               from public.jag_client_cobuyers k left join public.jag_clients m on m.user_id = k.member
              where k.owner = v_owner and k.declined_at is null), '[]'::json),
    'invites', coalesce((select json_agg(json_build_object('id', k.id, 'from_name', oo.name, 'from_email', oo.email) order by k.created_at desc)
               from public.jag_client_cobuyers k join public.jag_clients oo on oo.user_id = k.owner
              where lower(k.email) = lower(c.email) and k.accepted_at is null and k.declined_at is null and k.owner <> v_me), '[]'::json));
end $$;

create or replace function public.jag_cobuyer_invite(p_email text, p_name text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); c public.jag_clients; v_email text := lower(btrim(coalesce(p_email, ''))); v_id bigint; v_sent timestamptz;
begin
  select * into c from public.jag_clients where user_id = v_me;
  if v_me is null or c.user_id is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  if public.jag_household_of(v_me) <> v_me then return json_build_object('ok', false, 'reason', 'member'); end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then return json_build_object('ok', false, 'reason', 'email'); end if;
  if v_email = lower(c.email) then return json_build_object('ok', false, 'reason', 'self'); end if;
  if (select count(*) from public.jag_client_cobuyers where owner = v_me and declined_at is null and lower(email) <> v_email) >= 3 then
    return json_build_object('ok', false, 'reason', 'limit'); end if;
  insert into public.jag_client_cobuyers (owner, email, name) values (v_me, v_email, nullif(left(btrim(coalesce(p_name, '')), 80), ''))
  on conflict (owner, lower(email)) do update set name = coalesce(excluded.name, public.jag_client_cobuyers.name),
     declined_at = null, member = case when public.jag_client_cobuyers.declined_at is null then public.jag_client_cobuyers.member end,
     accepted_at = case when public.jag_client_cobuyers.declined_at is null then public.jag_client_cobuyers.accepted_at end
  returning id, email_sent_at into v_id, v_sent;
  if (select accepted_at from public.jag_client_cobuyers where id = v_id) is null and (v_sent is null or v_sent < now() - interval '10 minutes') then
    update public.jag_client_cobuyers set email_sent_at = now(), email_error = null where id = v_id;
    begin perform ops.kick_client_email('cobuyer_invite', v_id); exception when others then null; end;
  end if;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.jag_cobuyer_accept(p_id bigint)
returns json language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); c public.jag_clients; k public.jag_client_cobuyers;
begin
  select * into c from public.jag_clients where user_id = v_me;
  if v_me is null or c.user_id is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  select * into k from public.jag_client_cobuyers where id = p_id and lower(email) = lower(c.email) and accepted_at is null and declined_at is null;
  if k.id is null or k.owner = v_me then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if exists (select 1 from public.jag_client_cobuyers where owner = v_me and accepted_at is not null and declined_at is null) then
    return json_build_object('ok', false, 'reason', 'has_household'); end if;
  if public.jag_household_of(v_me) <> v_me then return json_build_object('ok', false, 'reason', 'already_member'); end if;
  update public.jag_client_cobuyers set member = v_me, accepted_at = now() where id = k.id;
  update public.jag_clients set agent_code = (select o.agent_code from public.jag_clients o where o.user_id = k.owner), agent_set_at = now()
   where user_id = v_me and agent_code is null and (select o.agent_code from public.jag_clients o where o.user_id = k.owner) is not null;
  return json_build_object('ok', true);
end $$;

create or replace function public.jag_cobuyer_decline(p_id bigint)
returns json language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_email text;
begin
  select lower(email) into v_email from public.jag_clients where user_id = v_me;
  if v_email is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  update public.jag_client_cobuyers set declined_at = now() where id = p_id and lower(email) = v_email and accepted_at is null and declined_at is null;
  return json_build_object('ok', found);
end $$;

-- the main account takes someone off, or a co-buyer leaves
create or replace function public.jag_cobuyer_remove(p_id bigint)
returns json language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  update public.jag_client_cobuyers set declined_at = now(), member = null, accepted_at = null
   where id = p_id and declined_at is null and (owner = v_me or member = v_me);
  return json_build_object('ok', found);
end $$;

revoke all on function public.jag_cobuyer_list() from public, anon;
revoke all on function public.jag_cobuyer_invite(text, text) from public, anon;
revoke all on function public.jag_cobuyer_accept(bigint) from public, anon;
revoke all on function public.jag_cobuyer_decline(bigint) from public, anon;
revoke all on function public.jag_cobuyer_remove(bigint) from public, anon;
grant execute on function public.jag_cobuyer_list() to authenticated;
grant execute on function public.jag_cobuyer_invite(text, text) to authenticated;
grant execute on function public.jag_cobuyer_accept(bigint) to authenticated;
grant execute on function public.jag_cobuyer_decline(bigint) to authenticated;
grant execute on function public.jag_cobuyer_remove(bigint) to authenticated;

/* ---------- Mensajes: one thread per household; who wrote it is kept ---------- */
alter table public.jag_messages add column if not exists sender_uid uuid;

create or replace function public.jag_msg_thread()
returns json language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_uid uuid; v_code text; a public.jag_agents;
begin
  if v_me is null or not exists (select 1 from public.jag_clients where user_id = v_me) then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  v_uid := public.jag_household_of(v_me);
  update public.jag_messages set read_at = now() where user_id = v_uid and sender = 'agent' and read_at is null;
  v_code := public.jag_msg_agent_of(v_uid);
  select * into a from public.jag_agents where code = v_code;
  return json_build_object('ok', true,
    'agent', case when a.code is null then null else json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'photo_url', a.photo_url, 'phone', a.phone) end,
    'sms_ok', (select sms_ok_at is not null from public.jag_clients where user_id = v_me),
    'shared', v_uid <> v_me or exists (select 1 from public.jag_client_cobuyers where owner = v_uid and accepted_at is not null and declined_at is null),
    'messages', coalesce((select json_agg(json_build_object('id', m.id, 'at', m.created_at, 'from', m.sender, 'name', m.sender_name, 'body', m.body,
        'read', m.read_at is not null, 'card', m.card, 'mine', m.sender = 'client' and coalesce(m.sender_uid, m.user_id) = v_me) order by m.id)
      from (select * from public.jag_messages where user_id = v_uid order by id desc limit 200) m), '[]'::json));
end $$;

create or replace function public.jag_msg_send(p_body text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_uid uuid; c public.jag_clients; v_id bigint; v_body text := btrim(coalesce(p_body, ''));
begin
  select * into c from public.jag_clients where user_id = v_me;
  if v_me is null or c.user_id is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  if v_body = '' then return json_build_object('ok', false, 'reason', 'empty'); end if;
  if (select count(*) from public.jag_messages where coalesce(sender_uid, user_id) = v_me and sender = 'client' and created_at > now() - interval '10 minutes') >= 20 then
    return json_build_object('ok', false, 'reason', 'limit');
  end if;
  v_uid := public.jag_household_of(v_me);
  insert into public.jag_messages (user_id, agent_code, sender, sender_name, sender_uid, body, via)
  values (v_uid, public.jag_msg_agent_of(v_uid), 'client', nullif(c.name, ''), v_me, left(v_body, 2000), 'app') returning id into v_id;
  begin perform ops.kick_messages(); exception when others then null; end;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.jag_msg_unread()
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.jag_messages where user_id = public.jag_household_of(auth.uid()) and sender = 'agent' and read_at is null;
$$;

create or replace function public.jag_msg_status()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'unread', (select count(*)::int from public.jag_messages where user_id = public.jag_household_of(auth.uid()) and sender = 'agent' and read_at is null),
    'sms_ok', coalesce((select sms_ok_at is not null from public.jag_clients where user_id = auth.uid()), false),
    'sms_live', coalesce(ops.s_text('msg_client_sms'), 'false') = 'true');
$$;

create or replace function public.jag_msg_reply(p_user uuid, p_body text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_code text := public.jag_agent_code_me(); a public.jag_agents; v_id bigint; v_body text := btrim(coalesce(p_body, '')); v_uid uuid;
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if v_body = '' then return json_build_object('ok', false, 'reason', 'empty'); end if;
  if not exists (select 1 from public.jag_clients where user_id = p_user) then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  v_uid := public.jag_household_of(p_user);
  select * into a from public.jag_agents where code = v_code;
  insert into public.jag_messages (user_id, agent_code, sender, sender_name, body, via, read_at)
  values (v_uid, coalesce(v_code, public.jag_msg_agent_of(v_uid)), 'agent', coalesce(a.first_name, a.name, 'JAG'), left(v_body, 2000), 'hub', null)
  returning id into v_id;
  update public.jag_messages set read_at = coalesce(read_at, now()) where user_id = v_uid and sender = 'client';
  begin perform ops.kick_messages(); exception when others then null; end;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.jag_msg_share(p_user uuid, p_body text, p_card jsonb)
returns json language plpgsql security definer set search_path = '' as $$
declare v_code text := public.jag_agent_code_me(); a public.jag_agents; v_id bigint; v_body text := btrim(coalesce(p_body, '')); v_uid uuid;
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if not exists (select 1 from public.jag_clients where user_id = p_user) then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_body = '' and p_card is null then return json_build_object('ok', false, 'reason', 'empty'); end if;
  v_uid := public.jag_household_of(p_user);
  select * into a from public.jag_agents where code = v_code;
  insert into public.jag_messages (user_id, agent_code, sender, sender_name, body, via, card)
  values (v_uid, coalesce(v_code, public.jag_msg_agent_of(v_uid)), 'agent', coalesce(a.first_name, a.name, 'JAG'),
          left(coalesce(nullif(v_body, ''), coalesce(p_card->>'title', 'Casa')), 2000), 'hub', public.jag_msg_clean_card(p_card))
  returning id into v_id;
  begin perform ops.kick_messages(); exception when others then null; end;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.jag_msg_team_thread(p_user uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare c public.jag_clients; v_uid uuid;
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if not exists (select 1 from public.jag_clients where user_id = p_user) then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  v_uid := public.jag_household_of(p_user);
  select * into c from public.jag_clients where user_id = v_uid;
  update public.jag_messages set read_at = now() where user_id = v_uid and sender = 'client' and read_at is null;
  return json_build_object('ok', true, 'client', json_build_object('user_id', c.user_id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'lang', c.lang,
      'contact_pref', c.contact_pref, 'contact_time', c.contact_time,
      'buys_with', (select string_agg(coalesce(x.name, x.email), ', ') from public.jag_clients x where x.user_id in (select public.jag_household(v_uid)) and x.user_id <> v_uid)),
    'messages', coalesce((select json_agg(json_build_object('id', m.id, 'at', m.created_at, 'from', m.sender, 'name', m.sender_name, 'body', m.body, 'via', m.via, 'read', m.read_at is not null, 'card', m.card) order by m.id)
      from (select * from public.jag_messages where user_id = v_uid order by id desc limit 300) m), '[]'::json));
end $$;

/* ---------- team settings ---------- */
alter table ops.team add column if not exists work_from smallint;     -- Houston hour; client-message alerts wait until then
alter table ops.team add column if not exists work_to smallint;
alter table ops.team add column if not exists default_note text;      -- prefilled when sending a home to a client's app

create or replace function ops.team_in_hours(p_member int)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select case when t.work_from is null or t.work_to is null or t.work_from = t.work_to then x.h between 8 and 20
                               when t.work_from < t.work_to then x.h >= t.work_from and x.h < t.work_to
                               else x.h >= t.work_from or x.h < t.work_to end
                     from ops.team t where t.id = p_member), x.h between 8 and 20)
    from (select extract(hour from now() at time zone 'America/Chicago')::int as h) x;
$$;

create or replace function public.jag_team_prefs()
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_id int := ops.team_member_me(); t ops.team;
begin
  if v_id is null then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into t from ops.team where id = v_id;
  return json_build_object('ok', true, 'lang', coalesce(t.language, 'en'), 'has_mobile', t.mobile_e164 is not null,
    'lead_alerts', coalesce(t.lead_alerts, true), 'appt_alerts', coalesce(t.appt_alerts, true), 'morning_text', coalesce(t.morning_text, true),
    'meeting_recap', coalesce(t.meeting_recap, true), 'first_ping', coalesce(t.is_default_first_ping, false),
    'work_from', t.work_from, 'work_to', t.work_to, 'default_note', t.default_note);
end $$;

create or replace function public.jag_team_prefs_save(p jsonb)
returns json language plpgsql security definer set search_path = '' as $$
declare v_id int := ops.team_member_me(); t ops.team;
begin
  if v_id is null then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into t from ops.team where id = v_id;
  if p ? 'lang' and p->>'lang' in ('es', 'en') then update ops.team set language = p->>'lang' where id = v_id; end if;
  if p ? 'lead_alerts' then
    if not (p->>'lead_alerts')::boolean and coalesce(t.is_default_first_ping, false) then return json_build_object('ok', false, 'reason', 'first_ping'); end if;
    update ops.team set lead_alerts = (p->>'lead_alerts')::boolean where id = v_id; end if;
  if p ? 'appt_alerts' then update ops.team set appt_alerts = (p->>'appt_alerts')::boolean where id = v_id; end if;
  if p ? 'morning_text' then update ops.team set morning_text = (p->>'morning_text')::boolean where id = v_id; end if;
  if p ? 'meeting_recap' then update ops.team set meeting_recap = (p->>'meeting_recap')::boolean where id = v_id; end if;
  if p ? 'work_from' or p ? 'work_to' then
    update ops.team set work_from = case when (p->>'work_from') ~ '^\d{1,2}$' and (p->>'work_from')::int between 0 and 23 then (p->>'work_from')::smallint end,
                        work_to   = case when (p->>'work_to')   ~ '^\d{1,2}$' and (p->>'work_to')::int   between 0 and 23 then (p->>'work_to')::smallint end
     where id = v_id; end if;
  if p ? 'default_note' then update ops.team set default_note = nullif(left(btrim(coalesce(p->>'default_note', '')), 500), '') where id = v_id; end if;
  return public.jag_team_prefs();
end $$;
revoke all on function public.jag_team_prefs_save(jsonb) from public, anon;
grant execute on function public.jag_team_prefs_save(jsonb) to authenticated;

/* ---------- notices honor quiet hours (client side) and working hours (agent side) ---------- */
create or replace function public.jag_msg_pending(p_limit int default 20)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x order by x.id), '[]'::json) from (
    select m.id, m.created_at, m.sender, m.sender_name, m.body, m.via, m.user_id, m.fub_at, m.card,
           c.name as client_name, c.email as client_email, c.phone as client_phone, coalesce(c.lang, 'es') as client_lang,
           (c.sms_ok_at is not null and coalesce(ops.s_text('msg_client_sms'), 'false') = 'true' and coalesce(c.notify->>'msgs', 'on') <> 'off') as client_sms,
           a.code as agent_code, a.name as agent_name, a.first_name as agent_first, a.fub_user_id as agent_fub_user_id,
           t.id as agent_member_id, t.mobile_e164 as agent_mobile,
           (m.sender = 'agent' and exists (select 1 from public.jag_messages p where p.user_id = m.user_id and p.sender = 'agent' and p.id < m.id
              and p.notify_at > now() - interval '15 minutes' and p.read_at is null and p.error is null)) as quiet
      from public.jag_messages m
      join public.jag_clients c on c.user_id = m.user_id
      left join public.jag_agents a on a.code = coalesce(m.agent_code, public.jag_msg_agent_of(m.user_id))
      left join ops.team t on t.fub_user_id = a.fub_user_id and t.active and t.mobile_e164 is not null
     where m.notify_at is null and m.tries < 5
       and case when m.sender = 'agent' then not public.jag_household_quiet(m.user_id) else ops.team_in_hours(t.id) end
     order by m.id limit greatest(1, least(coalesce(p_limit, 20), 50))) x;
$$;

-- only call n8n when something is actually due (quiet/working hours hold the rest)
create or replace function ops.kick_messages()
returns text language plpgsql security definer set search_path = '' as $$
declare v_secret text; v_req bigint;
begin
  if json_array_length(public.jag_msg_pending(1)) = 0 then return 'idle'; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'jag_ops_watchdog_secret';
  select net.http_post(url := 'https://toomuchtaco.app.n8n.cloud/webhook/jag-site-messages',
    body := jsonb_build_object('source', 'jag-site-kick', 'which', 'messages', 'at', now()),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-JAG-Ops-Secret', v_secret), timeout_milliseconds := 5000) into v_req;
  insert into ops.site_kicks (which, request_id) values ('messages', v_req);
  return 'kicked';
end $$;

-- co-buyers can also un-save each other's homes (applied with execute_sql: the migration tool refuses that keyword)
-- create policy "household removes favorites" on public.jag_client_favorites for <remove> using (user_id in (select public.jag_household(auth.uid())));
-- jag_agent_clients() also returns contact_pref, contact_time and buys_with (migration jag_agent_clients_prefs);
-- jag_cobuyer_list() also returns user ids (migration jag_cobuyer_list_ids).
