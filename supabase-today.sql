-- ============================================================
-- JAG CRM: the "Today" list + saved lists (Follow Up Boss smart lists, in the workspace).
--
--   last_call_at       when the contact was last called (FUB's lastCall, or a call logged in the workspace)
--   jag_saved_lists    named filters ("Applied, no call in 3 days"): team lists (Leads/admins make them) + personal ones
--   jag_contact_match  does a contact pass a list's filter
--   jag_contacts_list  now takes { list: <id> } or { filter: {...} } on top of search / view / stage / owner
--   jag_today          one agent's day: tasks due, new leads not called yet, contacts handed to them, app clients back
--                      online, and every saved list with its count
--   jag_notifs         also returns overdue / due-today task counts (the bell)
--   jag_today_morning  weekday text from Lola at ~7:40 AM with the day's numbers and who to start with
--
-- Filter keys: stages [..], no_call_days n, no_contact_days n, never_called true, created_days n, active_days n,
--              app true, no_tour true, tasks_due true
-- ============================================================

alter table public.jag_contacts add column if not exists last_call_at timestamptz;

-- FUB's lastCall, sent by fub-sync next to each page of people it upserts
create or replace function public.jag_fub_calls(p jsonb) returns int language sql security definer set search_path = '' as $$
  with x as (select (e->>'id')::bigint as id, nullif(e->>'at', '')::timestamptz as at from jsonb_array_elements(coalesce(p, '[]'::jsonb)) e),
  u as (update public.jag_contacts c set last_call_at = greatest(c.last_call_at, x.at) from x
         where c.fub_id = x.id and x.at is not null and c.last_call_at is distinct from greatest(c.last_call_at, x.at) returning 1)
  select count(*)::int from u;
$$;
revoke all on function public.jag_fub_calls(jsonb) from public, anon, authenticated;
grant execute on function public.jag_fub_calls(jsonb) to service_role;

-- a call / text / email logged in the workspace counts right away (FUB catches up on the next sync)
create or replace function public.jag_contact_notes_touch_trg() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.contact_id is not null and new.kind in ('call', 'text', 'email') then
    update public.jag_contacts set last_comm_at = greatest(last_comm_at, new.created_at),
           last_call_at = case when new.kind = 'call' then greatest(last_call_at, new.created_at) else last_call_at end
     where id = new.contact_id;
  end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists jag_contact_notes_touch on public.jag_contact_notes;
create trigger jag_contact_notes_touch after insert on public.jag_contact_notes for each row execute function public.jag_contact_notes_touch_trg();
revoke all on function public.jag_contact_notes_touch_trg() from public, anon, authenticated;

/* ---------- saved lists ---------- */
create table if not exists public.jag_saved_lists (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 80),
  owner_code text,                 -- null = the whole team sees it
  filter jsonb not null default '{}'::jsonb,
  pos int not null default 100,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.jag_saved_lists enable row level security;
insert into public.jag_saved_lists (name, filter, pos, created_by)
select * from (values
  ('New leads, not called yet', '{"created_days": 3, "never_called": true}'::jsonb, 10, 'jason'),
  ('Hot Prospect, no call in 7 days', '{"stages": ["Hot Prospect"], "no_call_days": 7}'::jsonb, 20, 'jason'),
  ('Appointment set', '{"stages": ["Appointment set"]}'::jsonb, 30, 'jason'),
  ('Applied, no call in 3 days', '{"stages": ["Applied"], "no_call_days": 3}'::jsonb, 40, 'jason'),
  ('Showing homes, no tour booked', '{"stages": ["Showing homes"], "no_tour": true}'::jsonb, 50, 'jason'),
  ('Under contract & pending', '{"stages": ["Under contract", "Pending"]}'::jsonb, 60, 'jason'),
  ('Back on the app (last 24 h)', '{"app": true, "active_days": 1}'::jsonb, 70, 'jason'),
  ('Overdue tasks', '{"tasks_due": true}'::jsonb, 80, 'jason')
) v(name, filter, pos, created_by)
where not exists (select 1 from public.jag_saved_lists);

create or replace function public.jag_contact_match(c public.jag_contacts, p_active timestamptz, f jsonb)
returns boolean language sql stable as $$   -- no SET clause: lets Postgres inline it (names are schema-qualified)
  select (jsonb_typeof(f->'stages') is distinct from 'array' or jsonb_array_length(f->'stages') = 0 or coalesce(f->'stages' ? c.stage, false))
     and (f->>'no_call_days' is null or coalesce(c.last_call_at, '-infinity') < now() - make_interval(days => (f->>'no_call_days')::int))
     and (f->>'no_contact_days' is null or coalesce(c.last_comm_at, '-infinity') < now() - make_interval(days => (f->>'no_contact_days')::int))
     and (coalesce(f->>'never_called', '') <> 'true' or c.last_call_at is null)
     and (f->>'created_days' is null or coalesce(c.fub_created, c.created_at) > now() - make_interval(days => (f->>'created_days')::int))
     and (f->>'active_days' is null or coalesce(p_active > now() - make_interval(days => (f->>'active_days')::int), false))
     and (coalesce(f->>'app', '') <> 'true' or c.user_id is not null)
     and (coalesce(f->>'no_tour', '') <> 'true' or not exists (select 1 from public.jag_tours t
            where t.user_id = c.user_id and t.status <> 'cancelled' and t.tour_date >= current_date))
     and (coalesce(f->>'tasks_due', '') <> 'true' or exists (select 1 from public.jag_contact_tasks t
            where t.contact_id = c.id and t.done_at is null and t.due_at < now()));
$$;
revoke all on function public.jag_contact_match(public.jag_contacts, timestamptz, jsonb) from public, anon, authenticated;

-- only the filter keys we know, with sane numbers
create or replace function public.jag_list_filter_clean(f jsonb) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'stages', case when jsonb_typeof(f->'stages') = 'array' and jsonb_array_length(f->'stages') > 0
                   then (select jsonb_agg(distinct left(x, 60)) from jsonb_array_elements_text(f->'stages') x) end,
    'no_call_days', case when (f->>'no_call_days') ~ '^\d{1,3}$' then (f->>'no_call_days')::int end,
    'no_contact_days', case when (f->>'no_contact_days') ~ '^\d{1,3}$' then (f->>'no_contact_days')::int end,
    'created_days', case when (f->>'created_days') ~ '^\d{1,3}$' then (f->>'created_days')::int end,
    'active_days', case when (f->>'active_days') ~ '^\d{1,3}$' then (f->>'active_days')::int end,
    'never_called', case when f->>'never_called' = 'true' then true end,
    'app', case when f->>'app' = 'true' then true end,
    'no_tour', case when f->>'no_tour' = 'true' then true end,
    'tasks_due', case when f->>'tasks_due' = 'true' then true end));
$$;

create or replace function public.jag_saved_list_save(p jsonb) returns json language plpgsql security definer set search_path = '' as $function$
declare v_me text := public.jag_agent_code_me(); v_team boolean := coalesce((p->>'team')::boolean, false); l public.jag_saved_lists; v_f jsonb;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if btrim(coalesce(p->>'name', '')) = '' then return json_build_object('ok', false, 'reason', 'name'); end if;
  if v_team and not public.jag_sees_all() then return json_build_object('ok', false, 'reason', 'team_lists'); end if;
  v_f := public.jag_list_filter_clean(coalesce(p->'filter', '{}'::jsonb));
  if v_f = '{}'::jsonb then return json_build_object('ok', false, 'reason', 'filter'); end if;
  if p ? 'id' then
    select * into l from public.jag_saved_lists where id = (p->>'id')::bigint;
    if l.id is null or not (l.owner_code = v_me or (l.owner_code is null and public.jag_sees_all())) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
    update public.jag_saved_lists set name = left(btrim(p->>'name'), 80), filter = v_f, owner_code = case when v_team then null else v_me end
     where id = l.id returning * into l;
  else
    insert into public.jag_saved_lists (name, owner_code, filter, created_by, pos)
    values (left(btrim(p->>'name'), 80), case when v_team then null else v_me end, v_f, v_me, case when v_team then 90 else 200 end) returning * into l;
  end if;
  return json_build_object('ok', true, 'id', l.id);
end $function$;

create or replace function public.jag_saved_list_delete(p_id bigint) returns json language plpgsql security definer set search_path = '' as $function$
declare v_me text := public.jag_agent_code_me();
begin
  delete from public.jag_saved_lists where id = p_id and (owner_code = v_me or (owner_code is null and public.jag_sees_all()));
  return json_build_object('ok', found);
end $function$;
revoke all on function public.jag_saved_list_save(jsonb), public.jag_saved_list_delete(bigint) from public, anon;
grant execute on function public.jag_saved_list_save(jsonb), public.jag_saved_list_delete(bigint) to authenticated;

/* ---------- the Contacts list, now with saved lists / filters ---------- */
create or replace function public.jag_contacts_list(p jsonb default '{}'::jsonb)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare v_me text := public.jag_agent_code_me(); v_all boolean := public.jag_sees_all(); v_q text := lower(btrim(coalesce(p->>'q', '')));
  v_view text := coalesce(p->>'view', 'all'); v_stage text := nullif(p->>'stage', ''); v_owner text := nullif(p->>'owner', '');
  v_lim int := least(greatest(coalesce((p->>'limit')::int, 40), 1), 100); v_off int := greatest(coalesce((p->>'offset')::int, 0), 0); v_qd text;
  v_fub int := public.jag_me_fub(); v_ponds int[]; v_collab uuid[]; v_f jsonb := '{}'::jsonb; v_list json;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select coalesce(array_agg(id), '{}') into v_ponds from public.jag_fub_ponds where v_fub is not null and v_fub = any(user_ids);
  select coalesce(array_agg(contact_id), '{}') into v_collab from public.jag_contact_collabs where agent_code = v_me and contact_id is not null;
  if nullif(p->>'list', '') is not null then
    select l.filter, json_build_object('id', l.id, 'name', l.name, 'team', l.owner_code is null) into v_f, v_list
      from public.jag_saved_lists l where l.id = (p->>'list')::bigint and (l.owner_code is null or l.owner_code = v_me);
    v_f := coalesce(v_f, '{}'::jsonb);
  end if;
  if jsonb_typeof(p->'filter') = 'object' then v_f := v_f || public.jag_list_filter_clean(p->'filter'); end if;
  v_qd := public.jag_digits10(v_q); if v_qd is null and length(regexp_replace(v_q, '\D', '', 'g')) >= 4 then v_qd := regexp_replace(v_q, '\D', '', 'g'); end if;
  return (
  with vis as (
    select c.*, cl.last_seen_at, cl.showing_agent_code, cl.contact_pref, cl.contact_time, cl.created_at as acct_at,
           s.score, s.tags as score_tags, s.top_zip, s.best_hour, s.homes,
           greatest(c.client_active_at, cl.last_seen_at) as active_at,
           (c.assigned_code = v_me or c.id = any(v_collab)) as mine,
           case when v_f = '{}'::jsonb then true else public.jag_contact_match(c, greatest(c.client_active_at, cl.last_seen_at), v_f) end as hit
      from public.jag_contacts c
      left join public.jag_clients cl on cl.user_id = c.user_id
      left join public.jag_client_scores s on s.user_id = c.user_id
     where not c.deleted and (v_all or c.assigned_code = v_me or c.id = any(v_collab) or c.pond_id = any(v_ponds) or cl.showing_agent_code = v_me)
  ), f as (
    select * from vis v where v.hit and
      (v_q = '' or lower(coalesce(v.name, '')) like '%' || v_q || '%' or lower(coalesce(v.email, '')) like '%' || v_q || '%'
        or (v_qd is not null and (v.phone like '%' || v_qd || '%' or exists (select 1 from unnest(v.phones) ph where ph like '%' || v_qd || '%')))
        or exists (select 1 from unnest(v.tags) t where lower(t) = v_q))
      and (v_stage is null or v.stage = v_stage)
      and (v_owner is null or v.assigned_code = v_owner or (v_owner = 'none' and v.assigned_code is null))
      and (v_view = 'all' or (v_view = 'mine' and v.mine) or (v_view = 'hot' and v.score >= 70)
           or (v_view = 'week' and v.active_at > now() - interval '7 days')
           or (v_view = 'new' and coalesce(v.fub_created, v.created_at) > now() - interval '7 days')
           or (v_view = 'prio' and v.stage in ('Hot Prospect','Applied','Loan Approved','Appointment set','Showing homes','Submitting offers','Under contract','Pending')))
  )
  select json_build_object('ok', true, 'me', v_me, 'sees_all', v_all, 'list', v_list,
    'counts', (select json_build_object('all', count(*), 'mine', count(*) filter (where mine), 'hot', count(*) filter (where score >= 70),
                 'week', count(*) filter (where active_at > now() - interval '7 days'),
                 'new', count(*) filter (where coalesce(fub_created, created_at) > now() - interval '7 days'),
                 'prio', count(*) filter (where stage in ('Hot Prospect','Applied','Loan Approved','Appointment set','Showing homes','Submitting offers','Under contract','Pending'))) from vis),
    'total', (select count(*) from f),
    'stages', coalesce((select json_agg(json_build_object('name', st.name, 'n', coalesce(x.n, 0)) order by st.pos)
                          from public.jag_fub_stages st left join (select stage, count(*) n from vis group by stage) x on x.stage = st.name where st.name <> 'Trash'), '[]'::json),
    'contacts', coalesce((select json_agg(r) from (
      select f.id, f.user_id, f.fub_id, f.name, f.email, f.phone, f.lang, f.stage, f.source, f.tags, f.assigned_code as agent_code, f.pond_id,
             coalesce(f.fub_created, f.created_at) as created_at, f.last_seen_at, f.active_at, f.client_active_at, f.last_comm_at, f.last_activity_at, f.last_call_at,
             f.showing_agent_code, f.contact_pref, f.contact_time, f.score, f.score_tags, f.top_zip, f.best_hour, f.homes, f.mine,
             case when f.user_id is not null then public.jag_client_priority(f.user_id) end as priority,
             public.jag_contact_journey(f.id) as journey,
             (select count(distinct (a.created_at at time zone 'America/Chicago')::date) from public.jag_client_activity a where a.user_id = f.user_id and a.created_at > now() - interval '7 days') as days_7,
             (select count(*) from public.jag_client_activity a where a.user_id = f.user_id and a.kind = 'view' and a.created_at > now() - interval '30 days') as views_30,
             (select count(*) from public.jag_client_favorites x where x.user_id = f.user_id) as favorites,
             (select count(*) from public.jag_contact_tasks t where t.contact_id = f.id and t.done_at is null) as open_tasks,
             (select min(t.due_at) from public.jag_contact_tasks t where t.contact_id = f.id and t.done_at is null) as next_due
        from f order by greatest(f.active_at, f.last_activity_at) desc nulls last, coalesce(f.fub_created, f.created_at) desc
        limit v_lim offset v_off) r), '[]'::json)));
end $function$;

/* ---------- Today ---------- */
-- internal: one agent's day (no sign-in check; jag_today and the morning text call it)
create or replace function public.jag_today_for(p_code text, p_team boolean default false)
returns json language sql stable security definer set search_path = '' as $function$
  with lim as (select ((now() at time zone 'America/Chicago')::date + 1)::timestamp at time zone 'America/Chicago' as day_end),
  tours as (select distinct user_id from public.jag_tours where status <> 'cancelled' and tour_date >= current_date),
  due as (select distinct contact_id from public.jag_contact_tasks where done_at is null and due_at < now()),
  base as (
    select c.*, greatest(c.client_active_at, cl.last_seen_at) as active_at, coalesce(c.fub_created, c.created_at) as made,
           (c.assigned_code = p_code or cl.showing_agent_code = p_code
             or exists (select 1 from public.jag_contact_collabs k where k.contact_id = c.id and k.agent_code = p_code)) as is_mine,
           exists (select 1 from tours t where t.user_id = c.user_id) as has_tour,
           exists (select 1 from due d where d.contact_id = c.id) as has_due
      from public.jag_contacts c left join public.jag_clients cl on cl.user_id = c.user_id
     where not c.deleted
  ),
  mine as (select * from base where is_mine),
  tk as (
    select t.id, t.title, t.due_at, t.contact_id, c.name, c.phone, c.stage, c.user_id, c.lang
      from public.jag_contact_tasks t join public.jag_contacts c on c.id = t.contact_id, lim
     where t.agent_code = p_code and t.done_at is null and t.due_at < lim.day_end
  ),
  fresh as (select m.* from mine m where m.made > now() - interval '3 days' and m.last_call_at is null and m.assigned_code = p_code),
  handed as (
    select distinct on (c.id) c.id, c.name, c.phone, c.stage, c.user_id, c.lang, n.kind, n.title as why, n.created_at as at
      from public.jag_agent_notifs n join public.jag_contacts c on c.id = public.jag_cid(n.user_id)
     where n.agent_code = p_code and n.kind in ('handoff', 'assigned', 'collab') and n.created_at > now() - interval '3 days' and not c.deleted
     order by c.id, n.created_at desc
  ),
  back as (
    select m.*, s.score from mine m left join public.jag_client_scores s on s.user_id = m.user_id
     where m.user_id is not null and m.active_at > now() - interval '24 hours'
  ),
  -- each saved list's filter, worked out once (same rules as jag_contact_match)
  lp as (
    select l.id, l.name, l.owner_code, l.filter, l.pos,
      (select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(l.filter->'stages') = 'array' then l.filter->'stages' else '[]'::jsonb end) x) as st,
      now() - make_interval(days => (l.filter->>'no_call_days')::int) as t_call,
      now() - make_interval(days => (l.filter->>'no_contact_days')::int) as t_comm,
      now() - make_interval(days => (l.filter->>'created_days')::int) as t_new,
      now() - make_interval(days => (l.filter->>'active_days')::int) as t_act,
      coalesce(l.filter->>'never_called' = 'true', false) as nc, coalesce(l.filter->>'app' = 'true', false) as app,
      coalesce(l.filter->>'no_tour' = 'true', false) as nt, coalesce(l.filter->>'tasks_due' = 'true', false) as td
      from public.jag_saved_lists l where l.owner_code is null or l.owner_code = p_code
  ),
  cnt as (
    select lp.id,
      count(*) filter (where x.is_mine) as n,
      count(*) as n_team
      from lp join base x on (p_team or x.is_mine)
       and (lp.st is null or x.stage = any(lp.st))
       and (lp.t_call is null or coalesce(x.last_call_at, '-infinity') < lp.t_call)
       and (lp.t_comm is null or coalesce(x.last_comm_at, '-infinity') < lp.t_comm)
       and (not lp.nc or x.last_call_at is null)
       and (lp.t_new is null or x.made > lp.t_new)
       and (lp.t_act is null or x.active_at > lp.t_act)
       and (not lp.app or x.user_id is not null)
       and (not lp.nt or not x.has_tour)
       and (not lp.td or x.has_due)
     group by lp.id
  )
  select json_build_object('ok', true, 'agent', p_code,
    'name', (select name from public.jag_agents where code = p_code),
    'today', to_char(now() at time zone 'America/Chicago', 'FMDay, FMMonth FMDD'),
    'counts', json_build_object(
       'overdue', (select count(*) from tk where due_at < now()),
       'due_today', (select count(*) from tk where due_at >= now()),
       'later', (select count(*) from public.jag_contact_tasks t, lim where t.agent_code = p_code and t.done_at is null and (t.due_at is null or t.due_at >= lim.day_end)),
       'fresh', (select count(*) from fresh), 'handed', (select count(*) from handed), 'back', (select count(*) from back),
       'mine', (select count(*) from mine)),
    'tasks', coalesce((select json_agg(json_build_object('id', id, 'title', title, 'due_at', due_at, 'overdue', due_at < now(),
                 'contact', json_build_object('id', contact_id, 'name', name, 'phone', phone, 'stage', stage, 'user_id', user_id, 'lang', lang)) order by due_at)
                 from (select * from tk order by due_at limit 30) x), '[]'::json),
    'fresh', coalesce((select json_agg(json_build_object('id', id, 'name', name, 'phone', phone, 'email', email, 'stage', stage, 'user_id', user_id, 'lang', lang,
                 'source', source, 'created_at', made, 'last_comm_at', last_comm_at) order by made desc)
                 from (select * from fresh order by made desc limit 15) x), '[]'::json),
    'handed', coalesce((select json_agg(json_build_object('id', id, 'name', name, 'phone', phone, 'stage', stage, 'user_id', user_id, 'lang', lang,
                 'kind', kind, 'why', why, 'at', at) order by at desc) from (select * from handed order by at desc limit 10) x), '[]'::json),
    'back', coalesce((select json_agg(json_build_object('id', id, 'name', name, 'phone', phone, 'stage', stage, 'user_id', user_id, 'lang', lang,
                 'score', score, 'active_at', active_at) order by score desc nulls last) from (select * from back order by score desc nulls last limit 10) x), '[]'::json),
    'lists', coalesce((select json_agg(json_build_object('id', lp.id, 'name', lp.name, 'team', lp.owner_code is null, 'filter', lp.filter, 'mine_list', lp.owner_code = p_code,
                 'n', coalesce(cnt.n, 0), 'n_team', case when p_team then coalesce(cnt.n_team, 0) end) order by lp.pos, lp.id)
                 from lp left join cnt on cnt.id = lp.id), '[]'::json));
$function$;
revoke all on function public.jag_today_for(text, boolean) from public, anon, authenticated;

create or replace function public.jag_today(p jsonb default '{}'::jsonb) returns json language plpgsql stable security definer set search_path = '' as $function$
declare v_me text := public.jag_agent_code_me(); v_all boolean := public.jag_sees_all(); v_code text;
begin
  if not public.jag_is_team() or v_me is null then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  -- Leads and admins can look at a teammate's day
  v_code := case when v_all and exists (select 1 from public.jag_agents where code = p->>'agent' and active) then p->>'agent' else v_me end;
  return (public.jag_today_for(v_code, v_all)::jsonb || jsonb_build_object('me', v_me, 'sees_all', v_all,
    'team', case when v_all then (select coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name) order by a.name), '[]'::jsonb) from public.jag_agents a where a.active) end))::json;
end $function$;
revoke all on function public.jag_today(jsonb) from public, anon;
grant execute on function public.jag_today(jsonb) to authenticated;

/* ---------- the bell also counts overdue tasks ---------- */
create or replace function public.jag_notifs(p_limit integer default 30)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare v_code text := public.jag_agent_code_me();
  v_end timestamptz := ((now() at time zone 'America/Chicago')::date + 1)::timestamp at time zone 'America/Chicago';
begin
  if v_code is null then return json_build_object('ok', true, 'unread', 0, 'overdue', 0, 'due_today', 0, 'items', '[]'::json); end if;
  return json_build_object('ok', true,
    'unread', (select count(*) from public.jag_agent_notifs where agent_code = v_code and read_at is null),
    'overdue', (select count(*) from public.jag_contact_tasks where agent_code = v_code and done_at is null and due_at < now()),
    'due_today', (select count(*) from public.jag_contact_tasks where agent_code = v_code and done_at is null and due_at >= now() and due_at < v_end),
    'items', coalesce((select json_agg(n order by n.created_at desc) from (
      select id, kind, title, body, user_id, invite_id, created_at, read_at from public.jag_agent_notifs
       where agent_code = v_code order by created_at desc limit greatest(1, least(coalesce(p_limit, 30), 100))) n), '[]'::json));
end $function$;

/* ---------- the morning text (weekdays ~7:40 AM Houston time) ---------- */
create or replace function public.jag_today_morning(p_force boolean default false) returns int language plpgsql security definer set search_path = '' as $function$
declare a record; d jsonb; v_n int := 0; v_local timestamp := now() at time zone 'America/Chicago'; es boolean; v_txt text;
  n_due int; n_over int; n_fresh int; n_hand int; v_top text; v_bits text[];
begin
  if not p_force and (extract(isodow from v_local) > 5 or v_local::time not between '07:15' and '08:15') then return 0; end if;
  for a in select ag.code, coalesce(ag.first_name, split_part(ag.name, ' ', 1)) as first, t.id as member, coalesce(t.language, 'en') as lang
             from public.jag_agents ag join ops.team t on t.fub_user_id = ag.fub_user_id and t.active and coalesce(t.morning_text, true) and t.mobile_e164 is not null
            where ag.active loop
    if not p_force and exists (select 1 from ops.team_texts x where x.member_id = a.member and x.kind = 'today' and x.created_at > now() - interval '12 hours') then continue; end if;
    d := public.jag_today_for(a.code, false)::jsonb;
    n_over := (d->'counts'->>'overdue')::int; n_due := n_over + (d->'counts'->>'due_today')::int;
    n_fresh := (d->'counts'->>'fresh')::int; n_hand := (d->'counts'->>'handed')::int;
    if n_due + n_fresh + n_hand = 0 then continue; end if;
    es := a.lang like 'es%';
    -- who to start with: tasks first, then contacts handed to them, then new leads
    select string_agg(nm, ', ') into v_top from (
      select nm from (
        select split_part(coalesce(x->'contact'->>'name', '?'), ' ', 1) || ' ' || coalesce(nullif(split_part(x->'contact'->>'name', ' ', 2), ''), '') as nm, 1 as o, ord
          from jsonb_array_elements(d->'tasks') with ordinality as t(x, ord)
        union all select split_part(coalesce(x->>'name', '?'), ' ', 1) || ' ' || coalesce(nullif(split_part(x->>'name', ' ', 2), ''), ''), 2, ord from jsonb_array_elements(d->'handed') with ordinality as h(x, ord)
        union all select split_part(coalesce(x->>'name', '?'), ' ', 1) || ' ' || coalesce(nullif(split_part(x->>'name', ' ', 2), ''), ''), 3, ord from jsonb_array_elements(d->'fresh') with ordinality as f(x, ord)
      ) z order by o, ord limit 3) y;
    v_bits := array_remove(array[
      case when n_due > 0 then n_due || case when es then ' tarea' || case when n_due = 1 then '' else 's' end else ' task' || case when n_due = 1 then '' else 's' end end
        || case when n_over > 0 then case when es then ' (' || n_over || ' vencida' || case when n_over = 1 then '' else 's' end || ')' else ' (' || n_over || ' overdue)' end else '' end end,
      case when n_fresh > 0 then n_fresh || case when es then ' lead' || case when n_fresh = 1 then ' nuevo' else 's nuevos' end || ' sin llamar' else ' new lead' || case when n_fresh = 1 then '' else 's' end || ' to call' end end,
      case when n_hand > 0 then n_hand || case when es then case when n_hand = 1 then ' cliente que te pasaron' else ' clientes que te pasaron' end else case when n_hand = 1 then ' contact handed to you' else ' contacts handed to you' end end end
    ], null);
    v_txt := case when es then '☀️ Buenos días ' || a.first || '. Hoy en JAG: ' || array_to_string(v_bits, ', ') || '.' || coalesce(' Empieza con: ' || btrim(v_top) || '.', '') || ' Tu lista: '
                  else '☀️ Good morning ' || a.first || '. Today at JAG: ' || array_to_string(v_bits, ', ') || '.' || coalesce(' Start with: ' || btrim(v_top) || '.', '') || ' Your list: ' end
             || 'https://jasonaguirregroup.company/workspace#hub=%23today';
    perform ops.lola_text(a.member, v_txt, 'today', null, true);
    v_n := v_n + 1;
  end loop;
  if v_n > 0 then perform ops.kick_team_texts(); end if;
  return v_n;
end $function$;
revoke all on function public.jag_today_morning(boolean) from public, anon, authenticated;

-- cron (UTC): 12:40 and 13:40 on weekdays; the function only sends between 7:15 and 8:15 AM Houston time, so exactly one
-- of the two fires whether or not it's daylight saving time.
-- select cron.schedule('jag-today-morning', '40 12,13 * * 1-5', 'select public.jag_today_morning()');
