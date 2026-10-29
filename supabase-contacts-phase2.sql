-- ============================================================
-- JAG CRM phase 2: every lead lands in Contacts.
--
--   jag_contacts       ONE record per person, with or without a JAG account: Follow Up Boss people (active ones:
--                      every working stage + leads created in the last 180 days, then every new or reworked lead),
--                      plus every website account. Linked to the account (user_id) and to FUB (fub_id).
--   jag_fub_stages     FUB's own stage list (the workspace uses the same stages, 1:1)
--   jag_fub_ponds      FUB ponds and their members (pond leads are visible to pond members, like in FUB)
--   jag_stage_owners   hand-offs: moving a contact to this stage assigns it to this agent and notifies them
--   jag_fub_out        write-back queue: stage, assignment, notes, call logs, text logs → Follow Up Boss
--
-- Who sees what: admins and Lead-job agents see everyone; agents see contacts assigned to them, shared with them
-- (collaborators) or sitting in a FUB pond they belong to.
-- Sync: the fub-sync edge function (every 5 minutes) pushes the queue, then pulls FUB changes.
-- ============================================================

create table if not exists public.jag_fub_stages (id int primary key, name text not null unique, pos int not null default 0);
alter table public.jag_fub_stages enable row level security;
-- seeded with the FUB account's stages (the sync keeps names and order current)
insert into public.jag_fub_stages (id, name, pos) values
  (2,'Lead',1),(24,'Attempted contact',2),(25,'Spoke with customer',3),(26,'Appointment set',4),(27,'Met with customer',5),(3,'Hot Prospect',6),
  (22,'Applied',7),(23,'Loan Approved',8),(28,'Showing homes',9),(31,'Submitting offers',10),(32,'Under contract',11),(7,'Pending',12),(8,'Closed',13),
  (9,'Past Client',14),(12,'Active Client',15),(29,'Listing agreement',16),(30,'Active listing',17),(4,'Nurture',18),(37,'2027 Follow-up',19),
  (10,'Sphere',20),(35,'Credit Lead',21),(34,'Credit Repair',22),(36,'Investor',23),(38,'Out Of Town',24),(13,'Unresponsive',25),(11,'Trash',26)
on conflict (id) do nothing;
create table if not exists public.jag_fub_ponds (id int primary key, name text not null, user_ids int[] not null default '{}');
alter table public.jag_fub_ponds enable row level security;

create table if not exists public.jag_contacts (
  id uuid primary key default gen_random_uuid(),
  fub_id bigint unique,
  user_id uuid unique,
  name text, first_name text, last_name text,
  email text, emails text[] not null default '{}',
  phone text, phones text[] not null default '{}',
  lang text check (lang in ('es','en')),
  stage text, stage_id int,
  source text,
  tags text[] not null default '{}',
  background text,
  fub_background text,
  price numeric,
  assigned_code text,
  assigned_fub_user int,
  pond_id int,
  fub_created timestamptz,
  fub_updated timestamptz,
  last_activity_at timestamptz,
  last_comm_at timestamptz,
  client_active_at timestamptz,
  contacted boolean,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jag_contacts_assigned on public.jag_contacts (assigned_code);
create index if not exists jag_contacts_stage on public.jag_contacts (stage);
create index if not exists jag_contacts_email on public.jag_contacts (lower(email));
create index if not exists jag_contacts_phone on public.jag_contacts (phone);
create index if not exists jag_contacts_active on public.jag_contacts (client_active_at desc nulls last);
alter table public.jag_contacts enable row level security;

create table if not exists public.jag_stage_owners (stage text primary key, agent_code text not null, updated_at timestamptz not null default now(), updated_by text);
alter table public.jag_stage_owners enable row level security;
insert into public.jag_stage_owners (stage, agent_code) values
  ('Applied', 'katherine'), ('Loan Approved', 'monica'), ('Showing homes', 'monica'), ('Submitting offers', 'jason'), ('Under contract', 'rene')
on conflict (stage) do nothing;

create table if not exists public.jag_fub_out (
  id bigint generated always as identity primary key,
  contact_id uuid not null,
  fub_id bigint,
  kind text not null check (kind in ('stage','assign','note','call','text')),
  payload jsonb not null default '{}'::jsonb,
  by_code text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  tries int not null default 0,
  error text
);
create index if not exists jag_fub_out_open on public.jag_fub_out (sent_at, id);
alter table public.jag_fub_out enable row level security;

-- notes / tasks / collaborators now hang on the contact (user_id kept for account holders)
alter table public.jag_contact_notes add column if not exists contact_id uuid;
alter table public.jag_contact_tasks add column if not exists contact_id uuid;
alter table public.jag_contact_collabs add column if not exists contact_id uuid;
alter table public.jag_contact_notes alter column user_id drop not null;
alter table public.jag_contact_tasks alter column user_id drop not null;
alter table public.jag_contact_collabs drop constraint if exists jag_contact_collabs_pkey;
alter table public.jag_contact_collabs alter column user_id drop not null;
create index if not exists jag_contact_notes_contact on public.jag_contact_notes (contact_id, created_at desc);
create index if not exists jag_contact_tasks_contact on public.jag_contact_tasks (contact_id, done_at, due_at);

/* ---------- linking accounts ---------- */
-- the contact for a website account: existing link, or the FUB/other contact with the same email or phone, or a new one
create or replace function public.jag_contact_for_user(p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare c public.jag_clients; v uuid; v_em text; v_ph text;
begin
  select * into c from public.jag_clients where user_id = p_user;
  if c.user_id is null then return null; end if;
  select id into v from public.jag_contacts where user_id = p_user;
  if v is not null then return v; end if;
  v_em := lower(nullif(btrim(c.email), '')); v_ph := public.jag_digits10(c.phone);
  select id into v from public.jag_contacts x
   where x.user_id is null and ((v_em is not null and (lower(x.email) = v_em or v_em = any(x.emails))) or (v_ph is not null and (x.phone = v_ph or v_ph = any(x.phones))))
   order by x.fub_id nulls last limit 1;
  if v is not null then
    update public.jag_contacts set user_id = p_user, lang = coalesce(lang, c.lang), updated_at = now() where id = v;
  else
    insert into public.jag_contacts (user_id, name, email, emails, phone, phones, lang, stage, source, assigned_code, created_at)
    values (p_user, c.name, v_em, case when v_em is null then '{}' else array[v_em] end, v_ph, case when v_ph is null then '{}' else array[v_ph] end,
            c.lang, 'Lead', 'JAG Homes website', c.agent_code, c.created_at)
    returning id into v;
  end if;
  update public.jag_contact_notes set contact_id = v where user_id = p_user and contact_id is null;
  update public.jag_contact_tasks set contact_id = v where user_id = p_user and contact_id is null;
  update public.jag_contact_collabs set contact_id = v where user_id = p_user and contact_id is null;
  return v;
end $function$;

create or replace function public.jag_clients_contact_trg() returns trigger language plpgsql security definer set search_path = '' as $function$
begin perform public.jag_contact_for_user(new.user_id); return null;
exception when others then return null;
end $function$;
drop trigger if exists jag_clients_contact on public.jag_clients;
create trigger jag_clients_contact after insert on public.jag_clients for each row execute function public.jag_clients_contact_trg();
-- the default-agent job (and anything else) setting a website account's agent also sets it on the contact
create or replace function public.jag_clients_agent_trg() returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  update public.jag_contacts set assigned_code = new.agent_code, updated_at = now()
   where user_id = new.user_id and (assigned_code is null or assigned_code = old.agent_code) and assigned_code is distinct from new.agent_code;
  return null;
exception when others then return null;
end $function$;
drop trigger if exists jag_clients_agent on public.jag_clients;
create trigger jag_clients_agent after update of agent_code on public.jag_clients for each row when (new.agent_code is distinct from old.agent_code) execute function public.jag_clients_agent_trg();

select public.jag_contact_for_user(user_id) from public.jag_clients;
create unique index if not exists jag_contact_collabs_uq on public.jag_contact_collabs (contact_id, agent_code);

-- either id works everywhere: a contact id, or (older links) a website account id
create or replace function public.jag_cid(p uuid) returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce((select id from public.jag_contacts where id = p), (select id from public.jag_contacts where user_id = p));
$$;

/* ---------- who sees what ---------- */
create or replace function public.jag_me_fub() returns int language sql stable security definer set search_path = '' as $$
  select fub_user_id::int from public.jag_agents where user_id = auth.uid() and active limit 1;
$$;
create or replace function public.jag_sees_all() returns boolean language sql stable security definer set search_path = '' as $$
  select public.jag_is_staff() or public.jag_has_role('lead');
$$;
create or replace function public.jag_contact_visible(p_id uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select public.jag_sees_all() or exists (
    select 1 from public.jag_contacts c where c.id = p_id and (
      c.assigned_code = public.jag_agent_code_me()
      or exists (select 1 from public.jag_contact_collabs k where k.contact_id = c.id and k.agent_code = public.jag_agent_code_me())
      or exists (select 1 from public.jag_clients cl where cl.user_id = c.user_id and cl.showing_agent_code = public.jag_agent_code_me())
      or (c.pond_id is not null and exists (select 1 from public.jag_fub_ponds p where p.id = c.pond_id and public.jag_me_fub() = any(p.user_ids)))));
$$;

/* ---------- journey by contact (works with or without an account) ---------- */
create or replace function public.jag_contact_journey(p_id uuid)
returns json language sql stable security definer set search_path = '' as $function$
  with c as (select * from public.jag_contacts where id = p_id),
  k as (select c.user_id as uid, lower(nullif(btrim(coalesce(c.email, '')), '')) as em, c.phone as ph, c.emails, c.phones from c),
  cl as (select x.* from public.jag_clients x, k where x.user_id = k.uid)
  select json_build_object(
    'joined', (select created_at from cl),
    'fub_stage', (select stage from c),
    'invite', (select json_build_object('at', i.created_at, 'by', i.agent_code) from public.jag_invites i, k where i.user_id = k.uid order by i.created_at limit 1),
    'screen', (select json_build_object('id', s.id, 'at', s.created_at, 'lane', s.lane, 'score', s.score, 'hot', s.hot, 'by', s.screener)
                 from public.jag_screenings s, k
                where (lower(btrim(s.email)) = k.em or lower(btrim(s.email)) = any(k.emails)) or public.jag_digits10(s.phone) = k.ph or public.jag_digits10(s.phone) = any(k.phones)
                order by s.created_at desc limit 1),
    'app', (select json_build_object('at', l.created_at, 'status', l.status) from public.jag_leads l, k
             where l.type = 'Mortgage Application' and coalesce(l.status, '') <> 'Merged' and l.created_at > now() - interval '18 months'
               and ((lower(btrim(l.email)) = k.em or lower(btrim(l.email)) = any(k.emails)) or public.jag_digits10(l.phone) = k.ph or public.jag_digits10(l.phone) = any(k.phones))
             order by l.created_at desc limit 1),
    'loan', (select public.jag_loan_state(k.uid) from k where k.uid is not null),
    'proof', (select p.kind from public.jag_client_proof p, k where p.user_id = k.uid and p.status = 'verified' order by p.reviewed_at desc limit 1),
    'looking', json_build_object(
       'views', (select count(*) from public.jag_client_activity a, k where a.user_id = k.uid and a.kind = 'view'),
       'saved', (select count(*) from public.jag_client_favorites f, k where f.user_id = k.uid),
       'searches', (select count(*) from public.jag_client_searches s, k where s.user_id = k.uid),
       'last', (select max(a.created_at) from public.jag_client_activity a, k where a.user_id = k.uid)),
    'sent', (select json_build_object('n', count(*), 'last', max(h.created_at)) from public.jag_homes_sent h, k
              where h.user_id = k.uid or lower(h.email) = k.em or public.jag_digits10(h.phone) = k.ph),
    'lists', (select json_build_object('n', count(*), 'last', max(coalesce(x.last_sent_at, x.created_at)), 'id', (array_agg(x.id order by x.updated_at desc))[1])
                from public.jag_carts x, k where not x.archived and (x.user_id = k.uid or lower(x.email) = k.em or public.jag_digits10(x.phone) = k.ph)),
    'show', json_build_object(
       'req', (select count(*) from public.jag_showing_requests r, k where r.user_id = k.uid),
       'tours', (select count(*) from public.jag_tours t, k where t.user_id = k.uid and t.status <> 'cancelled'),
       'done', (select count(*) from public.jag_tours t, k where t.user_id = k.uid and t.status = 'done'),
       'next', (select min(t.tour_date) from public.jag_tours t, k where t.user_id = k.uid and t.status in ('requested','scheduling','scheduled') and t.tour_date >= current_date)),
    'offer', (select json_build_object('n', count(*), 'last', (array_agg(o.status order by o.created_at desc))[1], 'at', max(o.created_at))
                from public.jag_offers o, k where o.user_id = k.uid having count(*) > 0));
$function$;
-- the account-based journey (Agent Hub before phase 2) now reads the contact
create or replace function public.jag_client_journey(p_user uuid)
returns json language sql stable security definer set search_path = '' as $$
  select public.jag_contact_journey(public.jag_cid(p_user));
$$;

/* ---------- the Contacts list (paged, searchable) ---------- */
create or replace function public.jag_contacts_list(p jsonb default '{}'::jsonb)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare v_me text := public.jag_agent_code_me(); v_all boolean := public.jag_sees_all(); v_q text := lower(btrim(coalesce(p->>'q', '')));
  v_view text := coalesce(p->>'view', 'all'); v_stage text := nullif(p->>'stage', ''); v_owner text := nullif(p->>'owner', '');
  v_lim int := least(greatest(coalesce((p->>'limit')::int, 40), 1), 100); v_off int := greatest(coalesce((p->>'offset')::int, 0), 0); v_qd text;
  v_fub int := public.jag_me_fub(); v_ponds int[]; v_collab uuid[];
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  -- visibility worked out once (not per row): assigned to me, shared with me, in a pond I belong to, or I'm their showing agent
  select coalesce(array_agg(id), '{}') into v_ponds from public.jag_fub_ponds where v_fub is not null and v_fub = any(user_ids);
  select coalesce(array_agg(contact_id), '{}') into v_collab from public.jag_contact_collabs where agent_code = v_me and contact_id is not null;
  v_qd := public.jag_digits10(v_q); if v_qd is null and length(regexp_replace(v_q, '\D', '', 'g')) >= 4 then v_qd := regexp_replace(v_q, '\D', '', 'g'); end if;
  return (
  with vis as (
    select c.*, cl.last_seen_at, cl.showing_agent_code, cl.contact_pref, cl.contact_time, cl.created_at as acct_at,
           s.score, s.tags as score_tags, s.top_zip, s.best_hour, s.homes,
           greatest(c.client_active_at, cl.last_seen_at) as active_at,
           (c.assigned_code = v_me or c.id = any(v_collab)) as mine
      from public.jag_contacts c
      left join public.jag_clients cl on cl.user_id = c.user_id
      left join public.jag_client_scores s on s.user_id = c.user_id
     where not c.deleted and (v_all or c.assigned_code = v_me or c.id = any(v_collab) or c.pond_id = any(v_ponds) or cl.showing_agent_code = v_me)
  ), f as (
    select * from vis v where
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
  select json_build_object('ok', true, 'me', v_me, 'sees_all', v_all,
    'counts', (select json_build_object('all', count(*), 'mine', count(*) filter (where mine), 'hot', count(*) filter (where score >= 70),
                 'week', count(*) filter (where active_at > now() - interval '7 days'),
                 'new', count(*) filter (where coalesce(fub_created, created_at) > now() - interval '7 days'),
                 'prio', count(*) filter (where stage in ('Hot Prospect','Applied','Loan Approved','Appointment set','Showing homes','Submitting offers','Under contract','Pending'))) from vis),
    'total', (select count(*) from f),
    'stages', coalesce((select json_agg(json_build_object('name', st.name, 'n', coalesce(x.n, 0)) order by st.pos)
                          from public.jag_fub_stages st left join (select stage, count(*) n from vis group by stage) x on x.stage = st.name where st.name <> 'Trash'), '[]'::json),
    'contacts', coalesce((select json_agg(r) from (
      select f.id, f.user_id, f.fub_id, f.name, f.email, f.phone, f.lang, f.stage, f.source, f.tags, f.assigned_code as agent_code, f.pond_id,
             coalesce(f.fub_created, f.created_at) as created_at, f.last_seen_at, f.active_at, f.client_active_at, f.last_comm_at, f.last_activity_at,
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

/* ---------- write-back to Follow Up Boss ---------- */
create or replace function public.jag_fub_kick() returns void language plpgsql security definer set search_path = '' as $function$
begin
  perform net.http_post(url := 'https://nyaxywghbpphjhwcmspd.supabase.co/functions/v1/fub-sync?action=push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jag-token', (select decrypted_secret from vault.decrypted_secrets where name = 'jag_alerts_token')),
    body := '{}'::jsonb);
exception when others then null;
end $function$;
create or replace function public.jag_fub_enqueue(p_contact uuid, p_kind text, p_payload jsonb) returns void language plpgsql security definer set search_path = '' as $function$
declare v_fub bigint;
begin
  select fub_id into v_fub from public.jag_contacts where id = p_contact;
  if v_fub is null then return; end if;   -- not in Follow Up Boss (website-only contact): nothing to write back
  insert into public.jag_fub_out (contact_id, fub_id, kind, payload, by_code) values (p_contact, v_fub, p_kind, coalesce(p_payload, '{}'::jsonb), public.jag_agent_code_me());
end $function$;

/* ---------- the profile, by contact ---------- */
create or replace function public.jag_contact_profile(p_user uuid)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare v_id uuid := public.jag_cid(p_user); c public.jag_contacts; cl public.jag_clients; v_uid uuid; v_em text; v_ph text; v_me text := public.jag_agent_code_me();
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_contacts where id = v_id;
  if c.id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if not public.jag_contact_visible(c.id) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  v_uid := c.user_id;
  select * into cl from public.jag_clients where user_id = v_uid;
  v_em := lower(nullif(btrim(coalesce(c.email, cl.email, '')), ''));
  v_ph := coalesce(c.phone, public.jag_digits10(cl.phone));

  return json_build_object('ok', true, 'me', v_me,
    'contact', json_build_object('id', c.id, 'user_id', v_uid, 'fub_id', c.fub_id, 'name', coalesce(c.name, cl.name), 'email', coalesce(c.email, cl.email),
      'emails', c.emails, 'phone', coalesce(c.phone, cl.phone), 'phones', c.phones, 'lang', coalesce(cl.lang, c.lang),
      'created_at', coalesce(c.fub_created, c.created_at), 'joined_at', cl.created_at, 'last_seen_at', cl.last_seen_at, 'client_active_at', c.client_active_at,
      'agent_code', c.assigned_code, 'showing_agent_code', cl.showing_agent_code, 'pond_id', c.pond_id,
      'pond', (select name from public.jag_fub_ponds where id = c.pond_id),
      'stage', c.stage, 'tags', c.tags, 'background', coalesce(c.background, c.fub_background), 'source', c.source, 'price', c.price,
      'contact_pref', cl.contact_pref, 'contact_time', cl.contact_time, 'sms_ok', cl.sms_ok_at is not null, 'alert_freq', cl.alert_freq,
      'buys_with', (select string_agg(coalesce(nullif(x.name, ''), x.email), ', ') from public.jag_clients x
                     where v_uid is not null and x.user_id in (select public.jag_household(v_uid)) and x.user_id <> v_uid),
      'fub_person_id', c.fub_id),
    'score', (select json_build_object('score', s.score, 'tags', s.tags, 'top_zip', s.top_zip, 'best_hour', s.best_hour, 'homes', s.homes, 'last_active_at', s.last_active_at)
                from public.jag_client_scores s where s.user_id = v_uid),
    'priority', case when v_uid is not null then public.jag_client_priority(v_uid) end,
    'journey', public.jag_contact_journey(c.id),
    'last_contact', greatest(c.last_comm_at, (select max(n.created_at) from public.jag_contact_notes n where n.contact_id = c.id and n.kind in ('call','email','text'))),
    'stages', coalesce((select json_agg(s.name order by s.pos) from public.jag_fub_stages s where s.name <> 'Trash'), '[]'::json),
    'stage_owners', coalesce((select json_object_agg(o.stage, o.agent_code) from public.jag_stage_owners o), '{}'::json),
    'team', coalesce((select json_agg(json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'photo_url', a.photo_url, 'roles', a.roles) order by a.name)
                        from public.jag_agents a where a.active), '[]'::json),
    'collaborators', coalesce((select json_agg(json_build_object('code', k.agent_code, 'added_by', k.added_by, 'at', k.created_at,
                        'name', a.name, 'photo_url', a.photo_url) order by k.created_at)
                        from public.jag_contact_collabs k left join public.jag_agents a on a.code = k.agent_code where k.contact_id = c.id), '[]'::json),
    'tasks', coalesce((select json_agg(t order by t.done_at nulls first, t.due_at nulls last, t.id) from (
                        select id, agent_code, title, due_at, done_at, done_by, created_by, created_at from public.jag_contact_tasks
                         where contact_id = c.id and (done_at is null or done_at > now() - interval '14 days')) t), '[]'::json),
    'favorites', coalesce((select json_agg(f order by f.saved_at desc) from (select mls, snap, last_price, last_status, saved_at
                        from public.jag_client_favorites where user_id = v_uid order by saved_at desc limit 12) f), '[]'::json),
    'proof', coalesce((select json_agg(p order by p.uploaded_at desc) from (select id, kind, path, file_name, uploaded_at, status
                        from public.jag_client_proof where user_id = v_uid) p), '[]'::json),
    'offers', coalesce((select json_agg(o order by o.created_at desc) from (select id, created_at, mls, address, list_price, offer_price, status, status_at, agent_code, financing, loan_type
                        from public.jag_offers where user_id = v_uid) o), '[]'::json),
    'tours', coalesce((select json_agg(t order by t.tour_date desc) from (select r.id, r.tour_date, r.time_window, r.status, r.lead_agent, r.showing_agent, r.note,
                        (select count(*) from public.jag_tour_homes h where h.tour_id = r.id) as homes
                        from public.jag_tours r where r.user_id = v_uid) t), '[]'::json),
    'lists', coalesce((select json_agg(l order by l.updated_at desc) from (select x.id, x.name, x.token, x.opens, x.last_open_at, x.last_sent_at, x.updated_at,
                        (select count(*) from public.jag_cart_homes h where h.cart_id = x.id) as homes,
                        (select count(*) from public.jag_cart_homes h where h.cart_id = x.id and h.reaction in ('love','tour')) as loved
                        from public.jag_carts x where not x.archived and (x.user_id = v_uid or (v_em is not null and lower(x.email) = v_em)
                          or (v_ph is not null and public.jag_digits10(x.phone) = v_ph))) l), '[]'::json),
    'apps', coalesce((select json_agg(a order by a.created_at desc) from (select l.id, l.created_at, l.status, l.est_amount, l.source
                        from public.jag_leads l where l.type = 'Mortgage Application' and coalesce(l.status, '') <> 'Merged'
                          and ((v_em is not null and lower(btrim(l.email)) = v_em) or (v_ph is not null and public.jag_digits10(l.phone) = v_ph))) a), '[]'::json),
    'timeline', coalesce((select json_agg(e order by e.at desc) from (
        select n.created_at as at, n.kind, n.author_name as who, n.agent_code as code, n.subject as title, n.body, n.meta, ('n' || n.id) as id
          from public.jag_contact_notes n where n.contact_id = c.id
        union all
        select m.created_at, 'msg', coalesce(m.sender_name, case when m.sender = 'client' then coalesce(c.name, cl.name) else m.agent_code end), m.agent_code,
               case when m.sender = 'client' then 'Message from client' else 'Message to client' end, m.body,
               json_build_object('via', m.via, 'from', m.sender)::jsonb, ('m' || m.id)
          from public.jag_messages m where v_uid is not null and m.user_id = v_uid
        union all
        select min(cm.created_at), 'ai', 'Lola (AI)', null, case when max(cm.channel) = 'sms' then 'AI text conversation' else 'AI chat on the website' end,
               null, json_build_object('session', s.session_id, 'turns', count(*),
                 'msgs', (select json_agg(json_build_object('role', x.role, 'text', left(x.text, 600), 'at', x.created_at) order by x.id)
                            from (select * from public.jag_chat_messages y where y.session_id = s.session_id order by y.id desc limit 30) x),
                 'summary', s.summary, 'call_requested', s.call_requested)::jsonb, ('a' || s.session_id)
          from public.jag_chat_sessions s join public.jag_chat_messages cm on cm.session_id = s.session_id
         where v_ph is not null and public.jag_digits10(s.phone) = v_ph
         group by s.session_id, s.summary, s.call_requested
        union all
        select h.created_at, 'homes', h.sent_by, h.agent_code, coalesce(h.label, 'Homes sent'), h.note,
               json_build_object('channel', h.channel, 'mls', h.mls, 'link', h.link)::jsonb, ('h' || h.id)
          from public.jag_homes_sent h
         where (v_uid is not null and h.user_id = v_uid) or (v_em is not null and lower(h.email) = v_em) or (v_ph is not null and public.jag_digits10(h.phone) = v_ph)
        union all
        select coalesce(x.last_sent_at, x.created_at), 'list', x.agent_code, x.agent_code, 'Client list: ' || x.name, x.note,
               json_build_object('token', x.token, 'opens', x.opens, 'cart', x.id,
                 'homes', (select count(*) from public.jag_cart_homes ch where ch.cart_id = x.id),
                 'loved', (select count(*) from public.jag_cart_homes ch where ch.cart_id = x.id and ch.reaction in ('love','tour')))::jsonb, ('l' || x.id)
          from public.jag_carts x where not x.archived and ((v_uid is not null and x.user_id = v_uid) or (v_em is not null and lower(x.email) = v_em) or (v_ph is not null and public.jag_digits10(x.phone) = v_ph))
        union all
        select max(al.emailed_at), 'alert', 'JAG Homes', null, 'Alert email: ' || count(*) || ' home' || case when count(*) = 1 then '' else 's' end, null,
               json_build_object('mls', array_agg(al.mls))::jsonb, ('e' || min(al.id))
          from public.jag_client_alerts al where v_uid is not null and al.user_id = v_uid and al.emailed_at is not null
         group by date_trunc('day', al.emailed_at)
        union all
        select f.saved_at, 'saved', coalesce(c.name, cl.name), null, 'Saved a home', null, json_build_object('mls', f.mls, 'snap', f.snap)::jsonb, ('f' || f.mls)
          from public.jag_client_favorites f where v_uid is not null and f.user_id = v_uid
        union all
        select sc.created_at, 'screen', sc.screener, null, 'Screened' || coalesce(' · ' || sc.lane, '') || coalesce(' · ' || sc.score || '%', '') || case when sc.hot then ' · hot' else '' end,
               sc.note, json_build_object('id', sc.id, 'lane', sc.lane, 'score', sc.score, 'hot', sc.hot, 'est_max', sc.est_max)::jsonb, ('s' || sc.id)
          from public.jag_screenings sc
         where (v_em is not null and lower(btrim(sc.email)) = v_em) or (v_ph is not null and public.jag_digits10(sc.phone) = v_ph)
        union all
        select l.created_at, 'app', l.name, null, 'JAG Home Loan application', null,
               json_build_object('id', l.id, 'status', l.status, 'est', l.est_amount)::jsonb, ('p' || l.id)
          from public.jag_leads l where l.type = 'Mortgage Application' and coalesce(l.status, '') <> 'Merged'
           and ((v_em is not null and lower(btrim(l.email)) = v_em) or (v_ph is not null and public.jag_digits10(l.phone) = v_ph))
        union all
        select r.created_at, 'tour', coalesce(r.showing_agent, r.lead_agent), r.showing_agent, 'Home tour · ' || to_char(r.tour_date, 'Mon DD') || ' · ' || r.status, r.note,
               json_build_object('id', r.id, 'date', r.tour_date, 'status', r.status, 'homes', (select count(*) from public.jag_tour_homes th where th.tour_id = r.id))::jsonb, ('t' || r.id)
          from public.jag_tours r where v_uid is not null and r.user_id = v_uid
        union all
        select sr.created_at, 'tour', coalesce(c.name, cl.name), sr.agent_code, 'Showing request', sr.note, json_build_object('mls', sr.mls, 'home', sr.home, 'times', sr.times)::jsonb, ('r' || sr.id)
          from public.jag_showing_requests sr where v_uid is not null and sr.user_id = v_uid
        union all
        select o.created_at, 'offer', o.agent_code, o.agent_code, 'Offer · ' || coalesce(o.address, 'MLS ' || o.mls) || ' · ' || o.status, o.status_note,
               json_build_object('id', o.id, 'price', o.offer_price, 'list', o.list_price, 'status', o.status)::jsonb, ('o' || o.id)
          from public.jag_offers o where v_uid is not null and o.user_id = v_uid
        union all
        select i.created_at, 'account', i.agent_code, i.agent_code, 'Invited to the app', null, json_build_object('channel', i.channel, 'opens', i.opens)::jsonb, ('i' || i.id)
          from public.jag_invites i where v_uid is not null and i.user_id = v_uid
        union all
        select cl.created_at, 'account', cl.name, null, 'Created their JAG account', null, '{}'::jsonb, 'c0' where cl.user_id is not null
        union all
        select c.fub_created, 'account', c.source, null, 'New lead in Follow Up Boss' || coalesce(' · ' || c.source, ''), null, '{}'::jsonb, 'c1' where c.fub_created is not null
      ) e where e.at is not null), '[]'::json));
end $function$;

/* ---------- edits (+ hand-offs + write-back) ---------- */
create or replace function public.jag_contact_update(p_user uuid, p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_id uuid := public.jag_cid(p_user); c public.jag_contacts; v_me text := public.jag_agent_code_me(); v_who text := public.jag_me_name();
  v_old_stage text; v_old_agent text; v_new_agent text; v_owner text; v_handoff boolean := false;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_contacts where id = v_id;
  if c.id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if not public.jag_contact_visible(c.id) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  if p ? 'stage' and coalesce(p->>'stage', '') <> '' and not exists (select 1 from public.jag_fub_stages where name = p->>'stage') then
    return json_build_object('ok', false, 'reason', 'stage');
  end if;
  if p ? 'agent_code' and coalesce(p->>'agent_code', '') <> '' and not exists (select 1 from public.jag_agents where code = p->>'agent_code' and active) then
    return json_build_object('ok', false, 'reason', 'agent');
  end if;
  v_old_stage := c.stage; v_old_agent := c.assigned_code;
  v_new_agent := case when p ? 'agent_code' then nullif(p->>'agent_code', '') else c.assigned_code end;
  -- hand-off: a new stage with an owner moves the contact to that owner (unless the agent picked someone in the same save)
  if p ? 'stage' and nullif(p->>'stage', '') is distinct from v_old_stage and not (p ? 'agent_code') then
    select agent_code into v_owner from public.jag_stage_owners where stage = p->>'stage';
    if v_owner is not null and v_owner is distinct from c.assigned_code and exists (select 1 from public.jag_agents where code = v_owner and active) then
      v_new_agent := v_owner; v_handoff := true;
    end if;
  end if;
  update public.jag_contacts set
    stage = case when p ? 'stage' then nullif(p->>'stage', '') else stage end,
    stage_id = case when p ? 'stage' then (select id from public.jag_fub_stages where name = p->>'stage') else stage_id end,
    tags = case when p ? 'tags' then coalesce((select array_agg(distinct left(btrim(t), 40)) from jsonb_array_elements_text(p->'tags') t where btrim(t) <> ''), '{}') else tags end,
    background = case when p ? 'background' then nullif(left(btrim(p->>'background'), 4000), '') else background end,
    source = case when p ? 'source' then nullif(left(btrim(p->>'source'), 80), '') else source end,
    name = case when p ? 'name' and btrim(coalesce(p->>'name', '')) <> '' then left(btrim(p->>'name'), 120) else name end,
    lang = case when p->>'lang' in ('es','en') then p->>'lang' else lang end,
    assigned_code = v_new_agent,
    assigned_fub_user = case when v_new_agent is distinct from c.assigned_code then (select fub_user_id::int from public.jag_agents where code = v_new_agent) else assigned_fub_user end,
    updated_at = now()
  where id = c.id returning * into c;
  if c.user_id is not null then
    update public.jag_clients set lang = case when p->>'lang' in ('es','en') then p->>'lang' else lang end,
      agent_code = case when v_new_agent is distinct from v_old_agent then v_new_agent else agent_code end,
      agent_set_at = case when v_new_agent is distinct from v_old_agent then now() else agent_set_at end
     where user_id = c.user_id;
  end if;
  if p ? 'stage' and c.stage is distinct from v_old_stage then
    insert into public.jag_contact_notes (contact_id, user_id, agent_code, author_name, kind, subject, meta)
    values (c.id, c.user_id, v_me, v_who, 'system', 'Stage → ' || coalesce(c.stage, 'none'), jsonb_build_object('stage', c.stage, 'from', v_old_stage));
    perform public.jag_fub_enqueue(c.id, 'stage', jsonb_build_object('stage', c.stage));
  end if;
  if v_new_agent is distinct from v_old_agent then
    insert into public.jag_contact_notes (contact_id, user_id, agent_code, author_name, kind, subject, meta)
    values (c.id, c.user_id, v_me, v_who, 'system', case when v_handoff then 'Handed to ' else 'Assigned to ' end || coalesce((select name from public.jag_agents where code = v_new_agent), 'nobody'),
            jsonb_build_object('agent', v_new_agent, 'from', v_old_agent, 'handoff', v_handoff));
    if c.assigned_fub_user is not null then perform public.jag_fub_enqueue(c.id, 'assign', jsonb_build_object('user', c.assigned_fub_user)); end if;
    if v_new_agent is not null and v_new_agent is distinct from v_me then
      perform public.jag_notify_agent(v_new_agent, case when v_handoff then 'handoff' else 'assigned' end,
        coalesce(c.name, c.email, 'A contact') || case when v_handoff then ' is yours now (' || c.stage || ')' else ' was assigned to you' end,
        'From ' || v_who || '. Open their profile in Contacts.', c.id, null,
        case when v_handoff then '🤝 ' else '📌 ' end || v_who || case when v_handoff then ' moved ' || coalesce(c.name, 'a contact') || ' to ' || c.stage || ' and handed them to you. ' else ' assigned ' || coalesce(c.name, 'a contact') || ' to you. ' end ||
        'Profile: https://jasonaguirregroup.company/workspace#hub=%23c%2F' || c.id::text);
    end if;
  end if;
  perform public.jag_fub_kick();
  return json_build_object('ok', true, 'stage', c.stage, 'tags', c.tags, 'agent_code', c.assigned_code, 'handoff', case when v_handoff then v_new_agent end);
end $function$;

create or replace function public.jag_contact_note(p_user uuid, p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_id uuid := public.jag_cid(p_user); v_me text := public.jag_agent_code_me(); v_kind text := coalesce(p->>'kind', 'note'); n public.jag_contact_notes; c public.jag_contacts;
  v_to text; v_who text := public.jag_me_name(); v_body text := left(btrim(coalesce(p->>'body', '')), 10000);
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if v_kind not in ('note','call','text') then return json_build_object('ok', false, 'reason', 'kind'); end if;
  select * into c from public.jag_contacts where id = v_id;
  if c.id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if not public.jag_contact_visible(c.id) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  if v_body = '' and v_kind = 'note' then return json_build_object('ok', false, 'reason', 'empty'); end if;
  insert into public.jag_contact_notes (contact_id, user_id, agent_code, author_name, kind, subject, body, meta)
  values (c.id, c.user_id, v_me, v_who, v_kind, nullif(left(btrim(coalesce(p->>'subject', '')), 300), ''), v_body, coalesce(p->'meta', '{}'::jsonb) - 'notify')
  returning * into n;
  update public.jag_contacts set last_comm_at = case when v_kind in ('call','text') then now() else last_comm_at end, updated_at = now() where id = c.id;
  perform public.jag_fub_enqueue(c.id, v_kind, jsonb_build_object('body', v_body, 'who', v_who, 'meta', coalesce(p->'meta', '{}'::jsonb) - 'notify'));
  for v_to in select distinct jsonb_array_elements_text(coalesce(p->'notify', '[]'::jsonb)) loop
    if v_to is distinct from v_me and exists (select 1 from public.jag_agents where code = v_to and active) then
      perform public.jag_notify_agent(v_to, 'note', v_who || ' left a note on ' || coalesce(c.name, c.email, 'a contact'), left(v_body, 160), c.id, null,
        '📝 ' || v_who || ' on ' || coalesce(c.name, c.email, 'a contact') || ': ' || left(v_body, 220));
    end if;
  end loop;
  perform public.jag_fub_kick();
  return json_build_object('ok', true, 'id', n.id, 'at', n.created_at);
end $function$;

create or replace function public.jag_contact_task(p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_me text := public.jag_agent_code_me(); t public.jag_contact_tasks; c public.jag_contacts;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if p ? 'id' then
    if p->>'op' = 'delete' then delete from public.jag_contact_tasks where id = (p->>'id')::bigint; return json_build_object('ok', true); end if;
    update public.jag_contact_tasks set
      done_at = case when p->>'op' = 'done' then now() when p->>'op' = 'reopen' then null else done_at end,
      done_by = case when p->>'op' = 'done' then v_me when p->>'op' = 'reopen' then null else done_by end,
      title = coalesce(nullif(left(btrim(coalesce(p->>'title', '')), 300), ''), title),
      due_at = case when p ? 'due_at' then nullif(p->>'due_at', '')::timestamptz else due_at end,
      agent_code = case when p ? 'agent_code' then nullif(p->>'agent_code', '') else agent_code end
     where id = (p->>'id')::bigint returning * into t;
    return json_build_object('ok', t.id is not null);
  end if;
  select * into c from public.jag_contacts where id = public.jag_cid(coalesce(p->>'contact_id', p->>'user_id')::uuid);
  if c.id is null or btrim(coalesce(p->>'title', '')) = '' then return json_build_object('ok', false, 'reason', 'empty'); end if;
  if not public.jag_contact_visible(c.id) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  insert into public.jag_contact_tasks (contact_id, user_id, agent_code, title, due_at, created_by)
  values (c.id, c.user_id, coalesce(nullif(p->>'agent_code', ''), v_me), left(btrim(p->>'title'), 300), nullif(p->>'due_at', '')::timestamptz, v_me)
  returning * into t;
  if t.agent_code is distinct from v_me then
    perform public.jag_notify_agent(t.agent_code, 'task', 'New task: ' || t.title, 'For ' || coalesce(c.name, c.email, 'a contact') || ' · from ' || public.jag_me_name(), c.id, null, null);
  end if;
  return json_build_object('ok', true, 'id', t.id);
end $function$;

create or replace function public.jag_contact_collab(p_user uuid, p_code text, p_add boolean default true)
returns json language plpgsql security definer set search_path = '' as $function$
declare c public.jag_contacts; v_me text := public.jag_agent_code_me(); v_who text := public.jag_me_name();
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_contacts where id = public.jag_cid(p_user);
  if c.id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if not public.jag_contact_visible(c.id) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  if not p_add then
    delete from public.jag_contact_collabs where contact_id = c.id and agent_code = p_code;
    return json_build_object('ok', true);
  end if;
  if not exists (select 1 from public.jag_agents where code = p_code and active) then return json_build_object('ok', false, 'reason', 'agent'); end if;
  insert into public.jag_contact_collabs (contact_id, user_id, agent_code, added_by) values (c.id, c.user_id, p_code, v_me) on conflict do nothing;
  if found and p_code is distinct from v_me then
    insert into public.jag_contact_notes (contact_id, user_id, agent_code, author_name, kind, subject, meta)
    values (c.id, c.user_id, v_me, v_who, 'system', 'Added ' || coalesce((select name from public.jag_agents where code = p_code), p_code) || ' as a collaborator', jsonb_build_object('collab', p_code));
    perform public.jag_notify_agent(p_code, 'collab', v_who || ' added you to ' || coalesce(c.name, c.email, 'a contact'),
      'You''re a collaborator now: their history, tasks and notes are in Contacts.', c.id, null,
      '🤝 ' || v_who || ' added you as a collaborator on ' || coalesce(c.name, c.email, 'a contact') || '. Profile: https://jasonaguirregroup.company/workspace#hub=%23c%2F' || c.id::text);
  end if;
  return json_build_object('ok', true);
end $function$;

/* ---------- hand-off settings (admins) ---------- */
create or replace function public.jag_stage_owners_get() returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('ok', public.jag_is_team(),
    'stages', coalesce((select json_agg(json_build_object('stage', s.name, 'owner', o.agent_code) order by s.pos)
                          from public.jag_fub_stages s left join public.jag_stage_owners o on o.stage = s.name where s.name <> 'Trash'), '[]'::json),
    'team', coalesce((select json_agg(json_build_object('code', a.code, 'name', a.name) order by a.name) from public.jag_agents a where a.active), '[]'::json),
    'can_edit', public.jag_sees_all());
$$;
create or replace function public.jag_stage_owner_set(p_stage text, p_code text) returns json language plpgsql security definer set search_path = '' as $function$
begin
  if not public.jag_sees_all() then return json_build_object('ok', false, 'reason', 'admins'); end if;
  if not exists (select 1 from public.jag_fub_stages where name = p_stage) then return json_build_object('ok', false, 'reason', 'stage'); end if;
  if coalesce(p_code, '') = '' then delete from public.jag_stage_owners where stage = p_stage;
  else
    if not exists (select 1 from public.jag_agents where code = p_code and active) then return json_build_object('ok', false, 'reason', 'agent'); end if;
    insert into public.jag_stage_owners (stage, agent_code, updated_by) values (p_stage, p_code, public.jag_agent_code_me())
    on conflict (stage) do update set agent_code = excluded.agent_code, updated_at = now(), updated_by = excluded.updated_by;
  end if;
  return json_build_object('ok', true);
end $function$;

/* ---------- sync helpers for the fub-sync function (service role) ---------- */
create or replace function public.jag_fub_upsert(p_people jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare e jsonb; v_id uuid; v_fub bigint; v_emails text[]; v_phones text[]; v_code text; v_ins int := 0; v_upd int := 0; v_pending boolean; v_uid uuid; k jsonb;
begin
  for e in select * from jsonb_array_elements(coalesce(p_people, '[]'::jsonb)) loop
    v_fub := (e->>'id')::bigint; v_id := null; v_uid := null; v_code := null;
    select coalesce(array_agg(distinct lower(btrim(x->>'value'))) filter (where btrim(coalesce(x->>'value', '')) like '%@%'), '{}') into v_emails from jsonb_array_elements(coalesce(e->'emails', '[]'::jsonb)) x;
    select coalesce(array_agg(distinct public.jag_digits10(x->>'value')) filter (where public.jag_digits10(x->>'value') is not null), '{}') into v_phones from jsonb_array_elements(coalesce(e->'phones', '[]'::jsonb)) x;
    select code into v_code from public.jag_agents where fub_user_id = nullif(e->>'assignedUserId', '')::bigint limit 1;
    select id into v_id from public.jag_contacts where fub_id = v_fub;
    if v_id is null then
      -- same person already here as a website account (or a contact made before the sync)?
      select x.id into v_id from public.jag_contacts x
       where x.fub_id is null and ((x.email is not null and x.email = any(v_emails)) or (x.phone is not null and x.phone = any(v_phones)))
       limit 1;
    end if;
    v_pending := v_id is not null and exists (select 1 from public.jag_fub_out o where o.contact_id = v_id and o.sent_at is null and o.kind in ('stage','assign'));
    if v_id is null then
      insert into public.jag_contacts (fub_id, name, first_name, last_name, email, emails, phone, phones, stage, stage_id, source, tags, fub_background, price,
        assigned_code, assigned_fub_user, pond_id, fub_created, fub_updated, last_activity_at, last_comm_at, contacted, deleted)
      values (v_fub, nullif(e->>'name', ''), nullif(e->>'firstName', ''), nullif(e->>'lastName', ''), v_emails[1], v_emails, v_phones[1], v_phones,
        e->>'stage', nullif(e->>'stageId', '')::int, nullif(e->>'source', ''), coalesce((select array_agg(t) from jsonb_array_elements_text(coalesce(e->'tags', '[]'::jsonb)) t), '{}'),
        nullif(e->>'background', ''), nullif(e->>'price', '')::numeric, v_code, nullif(e->>'assignedUserId', '')::int, nullif(e->>'assignedPondId', '')::int,
        nullif(e->>'created', '')::timestamptz, nullif(e->>'updated', '')::timestamptz, nullif(e->>'lastActivity', '')::timestamptz, nullif(e->>'lastCommunication', '')::timestamptz,
        coalesce(e->>'contacted', '0') in ('1','true'), e->>'stage' = 'Trash')
      returning id into v_id;
      v_ins := v_ins + 1;
    else
      update public.jag_contacts set fub_id = v_fub,
        name = coalesce(nullif(e->>'name', ''), name), first_name = coalesce(nullif(e->>'firstName', ''), first_name), last_name = coalesce(nullif(e->>'lastName', ''), last_name),
        email = coalesce(v_emails[1], email), emails = case when cardinality(v_emails) > 0 then v_emails else emails end,
        phone = coalesce(v_phones[1], phone), phones = case when cardinality(v_phones) > 0 then v_phones else phones end,
        stage = case when v_pending then stage else coalesce(e->>'stage', stage) end,
        stage_id = case when v_pending then stage_id else coalesce(nullif(e->>'stageId', '')::int, stage_id) end,
        source = coalesce(nullif(e->>'source', ''), source),
        tags = (select coalesce(array_agg(distinct t), '{}') from (select unnest(tags) t union select jsonb_array_elements_text(coalesce(e->'tags', '[]'::jsonb))) z),
        fub_background = nullif(e->>'background', ''), price = coalesce(nullif(e->>'price', '')::numeric, price),
        assigned_code = case when v_pending or nullif(e->>'assignedUserId', '') is null then assigned_code else v_code end,
        assigned_fub_user = case when v_pending or nullif(e->>'assignedUserId', '') is null then assigned_fub_user else (e->>'assignedUserId')::int end,
        pond_id = nullif(e->>'assignedPondId', '')::int,
        fub_created = coalesce(nullif(e->>'created', '')::timestamptz, fub_created), fub_updated = nullif(e->>'updated', '')::timestamptz,
        last_activity_at = coalesce(nullif(e->>'lastActivity', '')::timestamptz, last_activity_at),
        last_comm_at = greatest(last_comm_at, nullif(e->>'lastCommunication', '')::timestamptz),
        contacted = coalesce(e->>'contacted', '0') in ('1','true'), deleted = e->>'stage' = 'Trash', updated_at = now()
      where id = v_id;
      v_upd := v_upd + 1;
    end if;
    -- a website account with the same email/phone: link it
    if not exists (select 1 from public.jag_contacts where id = v_id and user_id is not null) then
      select cl.user_id into v_uid from public.jag_clients cl
       where (lower(cl.email) = any(v_emails) or public.jag_digits10(cl.phone) = any(v_phones))
         and not exists (select 1 from public.jag_contacts x where x.user_id = cl.user_id) limit 1;
      if v_uid is not null then update public.jag_contacts set user_id = v_uid where id = v_id; end if;
    end if;
    -- FUB collaborators → workspace collaborators
    for k in select * from jsonb_array_elements(case when jsonb_typeof(e->'collaborators') = 'array' then e->'collaborators' else '[]'::jsonb end) loop
      insert into public.jag_contact_collabs (contact_id, agent_code, added_by)
      select v_id, a.code, 'fub' from public.jag_agents a where a.fub_user_id = nullif(k->>'id', '')::bigint and a.active
      on conflict do nothing;
    end loop;
  end loop;
  return json_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd);
end $function$;

create table if not exists public.jag_fub_sync_state (k text primary key, v jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
alter table public.jag_fub_sync_state enable row level security;

-- keep the workspace's pipeline order; FUB's names win, new FUB stages go to the end
create or replace function public.jag_fub_meta(p_stages jsonb, p_ponds jsonb) returns json language plpgsql security definer set search_path = '' as $function$
declare e jsonb;
begin
  for e in select * from jsonb_array_elements(coalesce(p_stages, '[]'::jsonb)) loop
    insert into public.jag_fub_stages (id, name, pos) values ((e->>'id')::int, e->>'name', 100 + coalesce(nullif(e->>'orderWeight', '')::int / 1000, 0))
    on conflict (id) do update set name = excluded.name;
  end loop;
  for e in select * from jsonb_array_elements(coalesce(p_ponds, '[]'::jsonb)) loop
    insert into public.jag_fub_ponds (id, name, user_ids) values ((e->>'id')::int, e->>'name', coalesce((select array_agg(x::int) from jsonb_array_elements_text(coalesce(e->'userIds', '[]'::jsonb)) x), '{}'))
    on conflict (id) do update set name = excluded.name, user_ids = excluded.user_ids;
  end loop;
  return json_build_object('ok', true);
end $function$;

revoke all on function public.jag_contact_for_user(uuid), public.jag_clients_contact_trg(), public.jag_clients_agent_trg(), public.jag_fub_kick(), public.jag_fub_enqueue(uuid, text, jsonb),
  public.jag_fub_upsert(jsonb), public.jag_fub_meta(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.jag_fub_upsert(jsonb), public.jag_fub_meta(jsonb, jsonb), public.jag_contact_for_user(uuid) to service_role;
revoke all on function public.jag_cid(uuid), public.jag_me_fub(), public.jag_contact_visible(uuid), public.jag_contact_journey(uuid), public.jag_client_journey(uuid)
  from public, anon, authenticated;
revoke all on function public.jag_sees_all(), public.jag_contacts_list(jsonb), public.jag_stage_owners_get(), public.jag_stage_owner_set(text, text) from public, anon;
grant execute on function public.jag_contacts_list(jsonb), public.jag_stage_owners_get(), public.jag_stage_owner_set(text, text), public.jag_sees_all() to authenticated;

/* ---------- write-back sender: rows claimed atomically (two quick kicks never send the same change twice) ---------- */
alter table public.jag_fub_out add column if not exists claimed_at timestamptz;
create or replace function public.jag_fub_out_claim(p_limit int default 60)
returns setof public.jag_fub_out language sql security definer set search_path = '' as $$
  update public.jag_fub_out o set claimed_at = now()
   where o.id in (select id from public.jag_fub_out
                   where sent_at is null and tries < 5 and (claimed_at is null or claimed_at < now() - interval '3 minutes')
                   order by id limit greatest(1, least(p_limit, 200)) for update skip locked)
  returning o.*;
$$;
revoke all on function public.jag_fub_out_claim(int) from public, anon, authenticated;
grant execute on function public.jag_fub_out_claim(int) to service_role;

/* ---------- the bare contact (only if this team member can see it): jag-client-hub uses it before emailing / FUB history ---------- */
create or replace function public.jag_contact_basic(p_id uuid) returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('id', c.id, 'user_id', c.user_id, 'fub_id', c.fub_id, 'name', coalesce(c.name, cl.name), 'email', coalesce(c.email, cl.email),
                           'phone', coalesce(c.phone, cl.phone), 'lang', coalesce(cl.lang, c.lang))
    from public.jag_contacts c left join public.jag_clients cl on cl.user_id = c.user_id
   where c.id = public.jag_cid(p_id) and public.jag_is_team() and public.jag_contact_visible(c.id);
$$;
revoke all on function public.jag_contact_basic(uuid) from public, anon;
grant execute on function public.jag_contact_basic(uuid) to authenticated;

/* ---------- FUB sends "<unspecified>" when a lead has no source: keep it empty ---------- */
create or replace function public.jag_contacts_clean_trg() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.source in ('<unspecified>', '') then new.source := null; end if;
  return new;
end $$;
drop trigger if exists jag_contacts_clean on public.jag_contacts;
create trigger jag_contacts_clean before insert or update of source on public.jag_contacts for each row execute function public.jag_contacts_clean_trg();

/* ---------- the sync job: every 5 minutes (push the queue, then pull FUB changes) ---------- */
-- select cron.schedule('jag-fub-sync', '*/5 * * * *', $c$
--   select net.http_post(url := 'https://nyaxywghbpphjhwcmspd.supabase.co/functions/v1/fub-sync?action=sync',
--     headers := jsonb_build_object('Content-Type','application/json', 'x-jag-token', (select decrypted_secret from vault.decrypted_secrets where name = 'jag_alerts_token')),
--     body := '{}'::jsonb, timeout_milliseconds := 120000);
-- $c$);
-- First import (one time, done 2026-10-29): fub-sync ?action=meta, then ?action=import&stage=<each working stage>, then ?action=import&stage=Lead.
