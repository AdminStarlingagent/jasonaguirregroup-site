-- Agent Hub: agent profiles (synced from Follow Up Boss users), who shared what, and the agent each client came through.
-- Agents sign in to /agent with an emailed code; their FUB email links the login to their profile.
-- Being an agent does NOT make someone staff (no admin page, no tax IDs).

create table if not exists public.jag_agents (
  fub_user_id bigint primary key,
  code text unique not null check (code ~ '^[a-z0-9-]{2,30}$'),
  name text, first_name text, phone text, email text, photo_url text, role text,
  user_id uuid unique references auth.users(id) on delete set null,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.jag_agents enable row level security;

create table if not exists public.jag_agent_shares (
  id uuid primary key default gen_random_uuid(),
  agent_code text not null references public.jag_agents(code) on update cascade,
  kind text not null default 'listing' check (kind in ('listing','search','site')),
  mls text, label text, channel text,
  created_at timestamptz not null default now(),
  opens int not null default 0,
  last_open_at timestamptz
);
alter table public.jag_agent_shares enable row level security;

alter table public.jag_clients add column if not exists agent_code text references public.jag_agents(code) on update cascade on delete set null;
alter table public.jag_clients add column if not exists agent_set_at timestamptz;

-- who is signed in, as an agent
create or replace function public.jag_agent_code_me() returns text
language sql stable security definer set search_path = '' as $$
  select a.code from public.jag_agents a where a.active and a.user_id = auth.uid() limit 1;
$$;

-- first sign-in: link the login to the agent whose FUB email matches
create or replace function public.jag_agent_me() returns json
language plpgsql security definer set search_path = '' as $$
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
    'phone', v.phone, 'email', v.email, 'photo_url', v.photo_url), 'staff', public.jag_is_staff());
end $$;

-- what a client sees on a shared listing (no email, no ids)
create or replace function public.jag_agent_public(p_code text) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'phone', a.phone, 'photo_url', a.photo_url)
    from public.jag_agents a where a.active and a.code = lower(p_code);
$$;

-- an agent records a share; returns the share id for the link
create or replace function public.jag_agent_share(p_kind text, p_mls text default null, p_label text default null, p_channel text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare v_code text := public.jag_agent_code_me(); v_id uuid;
begin
  if v_code is null then return json_build_object('ok', false, 'reason', 'not_agent'); end if;
  insert into public.jag_agent_shares (agent_code, kind, mls, label, channel)
  values (v_code, case when p_kind in ('listing','search','site') then p_kind else 'listing' end,
          left(p_mls, 30), left(p_label, 160), left(p_channel, 20))
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'code', v_code);
end $$;

-- a client opened a shared link (anyone can call; only bumps a counter)
create or replace function public.jag_share_opened(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.jag_agent_shares set opens = opens + 1, last_open_at = now() where id = p_id;
$$;

-- a signed-in client came through an agent's link: first agent wins
create or replace function public.jag_client_set_agent(p_code text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return json_build_object('ok', false); end if;
  update public.jag_clients c set agent_code = a.code, agent_set_at = now()
    from public.jag_agents a
   where c.user_id = auth.uid() and c.agent_code is null and a.active and a.code = lower(p_code);
  return json_build_object('ok', true);
end $$;

-- Agent Hub client list
create or replace function public.jag_agent_clients() returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_code text := public.jag_agent_code_me();
begin
  if v_code is null and not public.jag_is_staff() then return json_build_object('ok', false, 'reason', 'not_agent'); end if;
  return json_build_object('ok', true, 'me', v_code, 'clients', coalesce((
    select json_agg(x order by x.score desc nulls last, x.last_seen_at desc nulls last) from (
      select c.user_id, c.name, c.email, c.phone, c.lang, c.created_at, c.last_seen_at, c.agent_code, c.alert_freq,
             s.score, s.tags, s.top_zip, s.best_hour, s.homes, s.last_hot_at,
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
        left join public.jag_client_scores s on s.user_id = c.user_id) x), '[]'::json),
    'shares', coalesce((select json_agg(y order by y.created_at desc) from (
      select id, kind, mls, label, channel, created_at, opens, last_open_at from public.jag_agent_shares
       where agent_code = v_code order by created_at desc limit 40) y), '[]'::json));
end $$;

-- one client's recent activity, saved homes and searches
create or replace function public.jag_agent_client_detail(p_user uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.jag_agent_code_me() is null and not public.jag_is_staff() then return json_build_object('ok', false); end if;
  return json_build_object('ok', true,
    'favorites', coalesce((select json_agg(f order by f.saved_at desc) from public.jag_client_favorites f where f.user_id = p_user), '[]'::json),
    'searches', coalesce((select json_agg(s order by s.created_at desc) from public.jag_client_searches s where s.user_id = p_user), '[]'::json),
    'activity', coalesce((select json_agg(a order by a.created_at desc) from (select kind, mls, zip, city, price, beds, created_at
       from public.jag_client_activity where user_id = p_user order by created_at desc limit 40) a), '[]'::json));
end $$;

-- n8n sync from Follow Up Boss users: only people on the JAG team (ops.team), codes from first names
create or replace function public.jag_agents_sync(p_users jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare u jsonb; v_code text; v_first text; n int := 0; i int;
begin
  for u in select * from jsonb_array_elements(coalesce(p_users, '[]'::jsonb)) loop
    if not exists (select 1 from ops.team t where t.active and t.fub_user_id = (u->>'id')::bigint) then continue; end if;
    v_first := coalesce(nullif(u->>'firstName', ''), split_part(u->>'name', ' ', 1));
    select code into v_code from public.jag_agents where fub_user_id = (u->>'id')::bigint;
    if v_code is null then
      v_code := lower(regexp_replace(translate(v_first, 'áéíóúñÁÉÍÓÚÑ', 'aeiounAEIOUN'), '[^A-Za-z0-9]', '', 'g'));
      if length(v_code) < 2 then v_code := 'agent' || (u->>'id'); end if;
      i := 2;
      while exists (select 1 from public.jag_agents where code = v_code) loop v_code := v_code || i; i := i + 1; end loop;
    end if;
    insert into public.jag_agents (fub_user_id, code, name, first_name, phone, email, photo_url, role, active, updated_at)
    values ((u->>'id')::bigint, v_code, u->>'name', v_first, nullif(u->>'phone', ''), lower(nullif(u->>'email', '')),
            nullif(coalesce(u->'picture'->>'original', u->'picture'->>'60x60', u->>'picture'), ''), u->>'role',
            coalesce(u->>'status', 'Active') <> 'Inactive', now())
    on conflict (fub_user_id) do update set name = excluded.name, first_name = excluded.first_name, phone = excluded.phone,
      email = excluded.email, photo_url = excluded.photo_url, role = excluded.role, active = excluded.active, updated_at = now();
    n := n + 1;
  end loop;
  return json_build_object('ok', true, 'agents', n);
end $$;

revoke all on function public.jag_agents_sync(jsonb) from public, anon, authenticated;
grant execute on function public.jag_agents_sync(jsonb) to service_role;
revoke all on function public.jag_agent_me() from public, anon;
revoke all on function public.jag_agent_share(text, text, text, text) from public, anon;
revoke all on function public.jag_agent_clients() from public, anon;
revoke all on function public.jag_agent_client_detail(uuid) from public, anon;
revoke all on function public.jag_client_set_agent(text) from public, anon;
grant execute on function public.jag_agent_me(), public.jag_agent_share(text, text, text, text), public.jag_agent_clients(),
  public.jag_agent_client_detail(uuid), public.jag_client_set_agent(text) to authenticated;
grant execute on function public.jag_agent_public(text), public.jag_share_opened(uuid) to anon, authenticated;
revoke all on function public.jag_agent_code_me() from public, anon;
grant execute on function public.jag_agent_code_me() to authenticated;
