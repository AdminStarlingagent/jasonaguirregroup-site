-- ============================================================
-- Premium accounts: a dedicated agent for every website account, and showing requests.
--
-- Dedicated agent (jag_clients.agent_code), first match wins:
--   1. the agent who screened them (jag_screenings by phone or email, last 180 days)
--   2. the agent whose home-email campaign they were on (jag_lead_drips)
--   3. the agent whose link they came from (jag_client_set_agent, existing)
--   4. after 30 minutes with none: the default agent (ops.settings 'default_agent', change it any time)
-- Showing requests: the client picks a home and 2-3 times; their agent gets a FUB task + note and a text from Lola
-- (n8n "JAG Site · Showing requests", kicked by ops.kick_showing()). Agents with no mobile on file → team text.
-- ============================================================

insert into ops.settings (key, value, note)
values ('default_agent', '"jason"'::jsonb, 'Agent code given to website accounts that have no screening, home-email campaign, or agent link (assigned 30 minutes after sign-up).')
on conflict (key) do nothing;

-- The agent who screened this person, or whose campaign they were on.
create or replace function public.jag_agent_for_contact(p_phone text, p_email text)
returns text language sql stable security definer set search_path = '' as $$
  with k as (select right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10) as ph, lower(trim(coalesce(p_email, ''))) as em)
  select coalesce(
    (select a.code from public.jag_screenings s join public.jag_agents a on a.user_id = s.created_by and a.active, k
      where s.created_at > now() - interval '180 days'
        and ((length(k.ph) = 10 and right(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g'), 10) = k.ph)
          or (position('@' in k.em) > 0 and lower(s.email) = k.em))
      order by s.created_at desc limit 1),
    (select d.agent_code from public.jag_lead_drips d join public.jag_agents a on a.code = d.agent_code and a.active, k
      where position('@' in k.em) > 0 and lower(d.email) = k.em order by d.created_at desc limit 1));
$$;

create or replace function public.jag_clients_assign_agent()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.agent_code is null then
    new.agent_code := public.jag_agent_for_contact(new.phone, new.email);
    if new.agent_code is not null then new.agent_set_at := now(); end if;
  end if;
  return new;
end $$;
create or replace trigger jag_clients_assign_agent before insert or update of phone, email on public.jag_clients
  for each row execute function public.jag_clients_assign_agent();

-- Accounts still without an agent after 30 minutes: one more screening/campaign check, then the default agent.
create or replace function public.jag_assign_default_agents()
returns int language plpgsql security definer set search_path = '' as $$
declare v_def text; v_n int;
begin
  select a.code into v_def from public.jag_agents a where a.active and a.code = coalesce(ops.s_text('default_agent'), 'jason');
  update public.jag_clients c
     set agent_code = coalesce(public.jag_agent_for_contact(c.phone, c.email), v_def), agent_set_at = now()
   where c.agent_code is null and c.created_at < now() - interval '30 minutes'
     and coalesce(public.jag_agent_for_contact(c.phone, c.email), v_def) is not null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- The signed-in client's dedicated agent (or the default agent until one is assigned).
create or replace function public.jag_my_agent()
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_code text; v_found boolean; a public.jag_agents;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  select c.agent_code, true into v_code, v_found from public.jag_clients c where c.user_id = auth.uid();
  if v_found is null then return json_build_object('ok', false, 'reason', 'no_account'); end if;
  select * into a from public.jag_agents x where x.active and x.code = coalesce(v_code, ops.s_text('default_agent'), 'jason');
  if not found then return json_build_object('ok', true, 'agent', null); end if;
  return json_build_object('ok', true, 'assigned', v_code is not null,
    'agent', json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'phone', a.phone, 'email', a.email, 'photo_url', a.photo_url));
end $$;

-- ---------- showing requests ----------
create table if not exists public.jag_showing_requests (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_code text,
  mls text,
  home jsonb not null default '{}'::jsonb,
  times jsonb not null default '[]'::jsonb,
  note text,
  sent_at timestamptz,
  tries int not null default 0,
  fub_person_id bigint,
  error text
);
alter table public.jag_showing_requests add column if not exists handled_at timestamptz;
alter table public.jag_showing_requests add column if not exists handled_by text;
create index if not exists jag_showing_pending_idx on public.jag_showing_requests (id) where sent_at is null;
alter table public.jag_showing_requests enable row level security;
do $p$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'jag_showing_requests' and policyname = 'clients see their own showing requests') then
    create policy "clients see their own showing requests" on public.jag_showing_requests for select to authenticated using (user_id = auth.uid());
  end if;
end $p$;

create or replace function public.jag_showing_request(p_mls text default null, p_home jsonb default '{}'::jsonb,
  p_times text[] default '{}', p_note text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); c public.jag_clients; v_times jsonb; v_home jsonb; v_id bigint; v_code text; v_first text;
begin
  if v_uid is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  select * into c from public.jag_clients where user_id = v_uid;
  if not found then return json_build_object('ok', false, 'reason', 'no_account'); end if;
  select coalesce(jsonb_agg(left(btrim(x), 80)), '[]'::jsonb) into v_times
    from (select x from unnest(coalesce(p_times, '{}')) x where btrim(coalesce(x, '')) <> '' limit 3) z;
  if jsonb_array_length(v_times) = 0 then return json_build_object('ok', false, 'reason', 'times'); end if;
  if nullif(btrim(coalesce(p_mls, '')), '') is null and coalesce(btrim(p_home->>'addr'), '') = '' then
    return json_build_object('ok', false, 'reason', 'home');
  end if;
  if (select count(*) from public.jag_showing_requests r where r.user_id = v_uid and r.created_at > now() - interval '1 day') >= 6 then
    return json_build_object('ok', false, 'reason', 'limit');
  end if;
  v_home := jsonb_strip_nulls(jsonb_build_object(
    'addr', left(p_home->>'addr', 160), 'city', left(p_home->>'city', 60), 'zip', left(p_home->>'zip', 10),
    'price', case when (p_home->>'price') ~ '^\d{1,10}(\.\d+)?$' then (p_home->>'price')::numeric end,
    'beds', case when (p_home->>'beds') ~ '^\d{1,2}$' then (p_home->>'beds')::int end,
    'photo', left(p_home->>'photo', 300)));
  v_code := coalesce(c.agent_code, (select a.code from public.jag_agents a where a.active and a.code = coalesce(ops.s_text('default_agent'), 'jason')));
  insert into public.jag_showing_requests (user_id, agent_code, mls, home, times, note)
  values (v_uid, v_code, left(nullif(btrim(coalesce(p_mls, '')), ''), 30), v_home, v_times, left(nullif(btrim(coalesce(p_note, '')), ''), 500))
  returning id into v_id;
  select first_name into v_first from public.jag_agents where code = v_code;
  begin perform ops.kick_showing(); exception when others then null; end;   -- the 5-minute timer is the fallback
  return json_build_object('ok', true, 'id', v_id, 'agent_first', v_first);
end $$;

-- n8n reads these (service role only). Texting hours 8 AM-8 PM Houston; later requests go out in the morning.
create or replace function public.jag_showing_pending(p_limit int default 10)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x order by x.id), '[]'::json) from (
    select r.id, r.created_at, r.mls, r.home, r.times, r.note, c.email, c.name, c.phone, c.lang,
           a.code as agent_code, a.name as agent_name, a.first_name as agent_first, a.fub_user_id as agent_fub_user_id,
           t.id as agent_member_id, t.mobile_e164 as agent_mobile
      from public.jag_showing_requests r
      join public.jag_clients c on c.user_id = r.user_id
      left join public.jag_agents a on a.code = r.agent_code
      left join ops.team t on t.fub_user_id = a.fub_user_id and t.active and t.mobile_e164 is not null
     where r.sent_at is null and r.tries < 5
       and extract(hour from now() at time zone 'America/Chicago') between 8 and 19
     order by r.id limit greatest(1, least(coalesce(p_limit, 10), 25))) x;
$$;

create or replace function public.jag_showing_mark(p_id bigint, p_ok boolean, p_person bigint default null, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.jag_showing_requests
     set sent_at = case when p_ok then now() end, fub_person_id = coalesce(p_person, fub_person_id),
         tries = tries + case when p_ok then 0 else 1 end, error = case when p_ok then null else left(p_error, 400) end
   where id = p_id and sent_at is null;
$$;

-- Wakes the n8n "JAG Site · Showing requests" workflow when a request is waiting.
-- Separate from ops.kick_site so the existing 'fub'/'hot' kicks stay untouched (their runs also trim ops.site_kicks).
create or replace function ops.kick_showing()
returns text language plpgsql security definer set search_path = '' as $function$
declare v_secret text; v_req bigint;
begin
  if json_array_length(public.jag_showing_pending(1)) = 0 then return 'idle'; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'jag_ops_watchdog_secret';
  select net.http_post(url := 'https://toomuchtaco.app.n8n.cloud/webhook/jag-site-showings',
    body := jsonb_build_object('source', 'jag-site-kick', 'which', 'showing', 'at', now()),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-JAG-Ops-Secret', v_secret), timeout_milliseconds := 5000) into v_req;
  insert into ops.site_kicks (which, request_id) values ('showing', v_req);
  return 'kicked';
end $function$;
revoke all on function ops.kick_showing() from public, anon, authenticated;

revoke all on function public.jag_agent_for_contact(text, text) from public, anon, authenticated;
revoke all on function public.jag_assign_default_agents() from public, anon, authenticated;
revoke all on function public.jag_showing_pending(int) from public, anon, authenticated;
revoke all on function public.jag_showing_mark(bigint, boolean, bigint, text) from public, anon, authenticated;
grant execute on function public.jag_showing_pending(int), public.jag_showing_mark(bigint, boolean, bigint, text) to service_role;
revoke all on function public.jag_my_agent() from public, anon;
revoke all on function public.jag_showing_request(text, jsonb, text[], text) from public, anon;
grant execute on function public.jag_my_agent(), public.jag_showing_request(text, jsonb, text[], text) to authenticated;

-- The signed-in client's showing requests (newest first), for the account page.
create or replace function public.jag_my_showings()
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select r.id, r.created_at, r.mls, r.home, r.times, r.note, (r.sent_at is not null) as sent, r.handled_at
      from public.jag_showing_requests r where r.user_id = auth.uid() order by r.created_at desc limit 10) x;
$$;
revoke all on function public.jag_my_showings() from public, anon;
grant execute on function public.jag_my_showings() to authenticated;

-- Team view (admin): recent showing requests with the client and agent; mark one handled.
create or replace function public.jag_showing_list(p_days int default 30)
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(public.jag_is_team(), false) then return '[]'::json; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select r.id, r.created_at, r.mls, r.home, r.times, r.note, r.sent_at, r.error, r.handled_at, r.handled_by, r.fub_person_id,
           c.name, c.email, c.phone, c.lang, r.agent_code, a.first_name as agent_first
      from public.jag_showing_requests r join public.jag_clients c on c.user_id = r.user_id
      left join public.jag_agents a on a.code = r.agent_code
     where r.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
     order by r.created_at desc limit 200) x);
end $$;
create or replace function public.jag_showing_handle(p_id bigint, p_done boolean default true)
returns json language plpgsql security definer set search_path = '' as $$
declare v_who text;
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select coalesce(a.first_name, a.name) into v_who from public.jag_agents a where a.user_id = auth.uid() limit 1;
  update public.jag_showing_requests set handled_at = case when p_done then now() end, handled_by = case when p_done then v_who end where id = p_id;
  return json_build_object('ok', found);
end $$;
revoke all on function public.jag_showing_list(int), public.jag_showing_handle(bigint, boolean) from public, anon;
grant execute on function public.jag_showing_list(int), public.jag_showing_handle(bigint, boolean) to authenticated;

-- Timers: showing requests every 5 minutes (fallback to the instant kick), default agents every 10 minutes.
select cron.schedule('jag-site-showing-kick', '*/5 * * * *', $c$select ops.kick_showing()$c$);
select cron.schedule('jag-default-agents', '*/10 * * * *', $c$select public.jag_assign_default_agents()$c$);
