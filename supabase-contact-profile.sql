-- ============================================================
-- JAG CRM: the client profile (Agent Hub → a contact's page, laid out like Follow Up Boss).
--
--   jag_clients            + stage, tags, background, source (the profile's Details)
--   jag_contact_notes      notes, logged calls, emails sent from the profile, texts sent from the agent's phone
--   jag_contact_tasks      follow-up tasks on a contact (assignee, due date, done)
--   jag_contact_collabs    agents added to a contact as collaborators (notified in the bell + a Lola text)
--
--   jag_contact_profile(user)   EVERYTHING about one contact as one JSON document: details, journey, collaborators,
--                               tasks and a single timeline (notes, calls, emails, texts, in-app messages, AI chats,
--                               homes and lists sent, alert emails, saved homes, screenings, loan apps, tours, offers).
--                               Built to be read by people and by AI agents alike (same shape, stable keys).
--   jag_contact_update(user, p) stage / tags / background / source / assigned agent / name / phone / language
--   jag_contact_note(user, p)   add a note, call log or text log (+ notify chosen teammates)
--   jag_contact_task(p)         add / finish / reopen / delete a task
--   jag_contact_collab(user, code, add)  add or remove a collaborator
-- Team logins only (jag_is_team). Emails are sent by jag-client-hub 'email', which logs them here.
-- ============================================================

alter table public.jag_clients add column if not exists stage text;
alter table public.jag_clients add column if not exists tags text[] not null default '{}';
alter table public.jag_clients add column if not exists background text;
alter table public.jag_clients add column if not exists source text;

create table if not exists public.jag_contact_notes (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  agent_code text,
  author_name text,
  kind text not null default 'note' check (kind in ('note','call','email','text','system')),
  subject text check (char_length(subject) <= 300),
  body text check (char_length(body) <= 10000),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists jag_contact_notes_user on public.jag_contact_notes (user_id, created_at desc);
alter table public.jag_contact_notes enable row level security;

create table if not exists public.jag_contact_tasks (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  agent_code text,
  title text not null check (char_length(title) <= 300),
  due_at timestamptz,
  done_at timestamptz,
  done_by text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists jag_contact_tasks_user on public.jag_contact_tasks (user_id, done_at, due_at);
create index if not exists jag_contact_tasks_agent on public.jag_contact_tasks (agent_code, done_at, due_at);
alter table public.jag_contact_tasks enable row level security;

create table if not exists public.jag_contact_collabs (
  user_id uuid not null,
  agent_code text not null,
  added_by text,
  created_at timestamptz not null default now(),
  primary key (user_id, agent_code)
);
alter table public.jag_contact_collabs enable row level security;

create or replace function public.jag_me_name() returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select a.name from public.jag_agents a where a.user_id = auth.uid() and a.active limit 1), auth.jwt()->>'email', 'Team');
$$;

/* ---------- one contact, everything ---------- */
create or replace function public.jag_contact_profile(p_user uuid)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare c public.jag_clients; v_em text; v_ph text; v_me text := public.jag_agent_code_me();
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_clients where user_id = p_user;
  if c.user_id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  v_em := case when lower(btrim(coalesce(c.email, ''))) like '%@%' then lower(btrim(c.email)) end;
  v_ph := public.jag_digits10(c.phone);

  return json_build_object('ok', true, 'me', v_me,
    'contact', json_build_object('user_id', c.user_id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'lang', c.lang,
      'created_at', c.created_at, 'last_seen_at', c.last_seen_at, 'agent_code', c.agent_code, 'showing_agent_code', c.showing_agent_code,
      'stage', c.stage, 'tags', c.tags, 'background', c.background, 'source', c.source, 'contact_pref', c.contact_pref, 'contact_time', c.contact_time,
      'sms_ok', c.sms_ok_at is not null, 'alert_freq', c.alert_freq,
      'buys_with', (select string_agg(coalesce(nullif(x.name, ''), x.email), ', ') from public.jag_clients x
                     where x.user_id in (select public.jag_household(c.user_id)) and x.user_id <> c.user_id),
      'fub_person_id', (select max(q.fub_person_id) from public.jag_fub_queue q where q.user_id = c.user_id)),
    'score', (select json_build_object('score', s.score, 'tags', s.tags, 'top_zip', s.top_zip, 'best_hour', s.best_hour, 'homes', s.homes, 'last_active_at', s.last_active_at)
                from public.jag_client_scores s where s.user_id = c.user_id),
    'priority', public.jag_client_priority(c.user_id),
    'journey', public.jag_client_journey(c.user_id),
    'last_contact', (select max(n.created_at) from public.jag_contact_notes n where n.user_id = c.user_id and n.kind in ('call','email','text')),
    'team', coalesce((select json_agg(json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'photo_url', a.photo_url, 'roles', a.roles) order by a.name)
                        from public.jag_agents a where a.active), '[]'::json),
    'collaborators', coalesce((select json_agg(json_build_object('code', k.agent_code, 'added_by', k.added_by, 'at', k.created_at,
                        'name', a.name, 'photo_url', a.photo_url) order by k.created_at)
                        from public.jag_contact_collabs k left join public.jag_agents a on a.code = k.agent_code where k.user_id = c.user_id), '[]'::json),
    'tasks', coalesce((select json_agg(t order by t.done_at nulls first, t.due_at nulls last, t.id) from (
                        select id, agent_code, title, due_at, done_at, done_by, created_by, created_at from public.jag_contact_tasks
                         where user_id = c.user_id and (done_at is null or done_at > now() - interval '14 days')) t), '[]'::json),
    'favorites', coalesce((select json_agg(f order by f.saved_at desc) from (select mls, snap, last_price, last_status, saved_at
                        from public.jag_client_favorites where user_id = c.user_id order by saved_at desc limit 12) f), '[]'::json),
    'proof', coalesce((select json_agg(p order by p.uploaded_at desc) from (select id, kind, path, file_name, uploaded_at, status
                        from public.jag_client_proof where user_id = c.user_id) p), '[]'::json),
    'offers', coalesce((select json_agg(o order by o.created_at desc) from (select id, created_at, mls, address, list_price, offer_price, status, status_at, agent_code, financing, loan_type
                        from public.jag_offers where user_id = c.user_id) o), '[]'::json),
    'tours', coalesce((select json_agg(t order by t.tour_date desc) from (select r.id, r.tour_date, r.time_window, r.status, r.lead_agent, r.showing_agent, r.note,
                        (select count(*) from public.jag_tour_homes h where h.tour_id = r.id) as homes
                        from public.jag_tours r where r.user_id = c.user_id) t), '[]'::json),
    'lists', coalesce((select json_agg(l order by l.updated_at desc) from (select x.id, x.name, x.token, x.opens, x.last_open_at, x.last_sent_at, x.updated_at,
                        (select count(*) from public.jag_cart_homes h where h.cart_id = x.id) as homes,
                        (select count(*) from public.jag_cart_homes h where h.cart_id = x.id and h.reaction in ('love','tour')) as loved
                        from public.jag_carts x where not x.archived and (x.user_id = c.user_id or (v_em is not null and lower(x.email) = v_em)
                          or (v_ph is not null and public.jag_digits10(x.phone) = v_ph))) l), '[]'::json),
    'apps', coalesce((select json_agg(a order by a.created_at desc) from (select l.id, l.created_at, l.status, l.est_amount, l.source
                        from public.jag_leads l where l.type = 'Mortgage Application' and coalesce(l.status, '') <> 'Merged'
                          and ((v_em is not null and lower(btrim(l.email)) = v_em) or (v_ph is not null and public.jag_digits10(l.phone) = v_ph))) a), '[]'::json),
    -- one history, newest first. kind: note · call · email · text · msg · ai · homes · list · alert · saved · screen · app · tour · offer · account
    'timeline', coalesce((select json_agg(e order by e.at desc) from (
        select n.created_at as at, n.kind, n.author_name as who, n.agent_code as code, n.subject as title, n.body, n.meta, ('n' || n.id) as id
          from public.jag_contact_notes n where n.user_id = c.user_id
        union all
        select m.created_at, 'msg', coalesce(m.sender_name, case when m.sender = 'client' then c.name else m.agent_code end), m.agent_code,
               case when m.sender = 'client' then 'Message from client' else 'Message to client' end, m.body,
               json_build_object('via', m.via, 'from', m.sender)::jsonb, ('m' || m.id)
          from public.jag_messages m where m.user_id = c.user_id
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
         where h.user_id = c.user_id or (v_em is not null and lower(h.email) = v_em) or (v_ph is not null and public.jag_digits10(h.phone) = v_ph)
        union all
        select coalesce(x.last_sent_at, x.created_at), 'list', x.agent_code, x.agent_code, 'Client list: ' || x.name, x.note,
               json_build_object('token', x.token, 'opens', x.opens, 'cart', x.id,
                 'homes', (select count(*) from public.jag_cart_homes ch where ch.cart_id = x.id),
                 'loved', (select count(*) from public.jag_cart_homes ch where ch.cart_id = x.id and ch.reaction in ('love','tour')))::jsonb, ('l' || x.id)
          from public.jag_carts x where not x.archived and (x.user_id = c.user_id or (v_em is not null and lower(x.email) = v_em) or (v_ph is not null and public.jag_digits10(x.phone) = v_ph))
        union all
        select max(al.emailed_at), 'alert', 'JAG Homes', null, 'Alert email: ' || count(*) || ' home' || case when count(*) = 1 then '' else 's' end, null,
               json_build_object('mls', array_agg(al.mls))::jsonb, ('e' || min(al.id))
          from public.jag_client_alerts al where al.user_id = c.user_id and al.emailed_at is not null
         group by date_trunc('day', al.emailed_at)
        union all
        select f.saved_at, 'saved', c.name, null, 'Saved a home', null, json_build_object('mls', f.mls, 'snap', f.snap)::jsonb, ('f' || f.mls)
          from public.jag_client_favorites f where f.user_id = c.user_id
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
          from public.jag_tours r where r.user_id = c.user_id
        union all
        select sr.created_at, 'tour', c.name, sr.agent_code, 'Showing request', sr.note, json_build_object('mls', sr.mls, 'home', sr.home, 'times', sr.times)::jsonb, ('r' || sr.id)
          from public.jag_showing_requests sr where sr.user_id = c.user_id
        union all
        select o.created_at, 'offer', o.agent_code, o.agent_code, 'Offer · ' || coalesce(o.address, 'MLS ' || o.mls) || ' · ' || o.status, o.status_note,
               json_build_object('id', o.id, 'price', o.offer_price, 'list', o.list_price, 'status', o.status)::jsonb, ('o' || o.id)
          from public.jag_offers o where o.user_id = c.user_id
        union all
        select i.created_at, 'account', i.agent_code, i.agent_code, 'Invited to the app', null, json_build_object('channel', i.channel, 'opens', i.opens)::jsonb, ('i' || i.id)
          from public.jag_invites i where i.user_id = c.user_id
        union all
        select c.created_at, 'account', c.name, null, 'Created their JAG account', null, '{}'::jsonb, 'c0'
      ) e where e.at is not null), '[]'::json));
end $function$;

/* ---------- edits ---------- */
create or replace function public.jag_contact_update(p_user uuid, p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare c public.jag_clients; v_me text := public.jag_agent_code_me(); v_new text;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_clients where user_id = p_user;
  if c.user_id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if p ? 'stage' and coalesce(p->>'stage', '') <> '' and p->>'stage' not in
     ('New','Contacted','Applied','Pre-approved','Shopping','Showing','Offer','Under contract','Closed','Nurture','Lost') then
    return json_build_object('ok', false, 'reason', 'stage');
  end if;
  if p ? 'agent_code' and coalesce(p->>'agent_code', '') <> '' and not exists (select 1 from public.jag_agents where code = p->>'agent_code' and active) then
    return json_build_object('ok', false, 'reason', 'agent');
  end if;
  update public.jag_clients set
    stage = case when p ? 'stage' then nullif(p->>'stage', '') else stage end,
    tags = case when p ? 'tags' then coalesce((select array_agg(distinct left(btrim(t), 40)) from jsonb_array_elements_text(p->'tags') t where btrim(t) <> ''), '{}') else tags end,
    background = case when p ? 'background' then nullif(left(btrim(p->>'background'), 4000), '') else background end,
    source = case when p ? 'source' then nullif(left(btrim(p->>'source'), 80), '') else source end,
    name = case when p ? 'name' and btrim(coalesce(p->>'name', '')) <> '' then left(btrim(p->>'name'), 120) else name end,
    phone = case when p ? 'phone' then nullif(left(btrim(p->>'phone'), 40), '') else phone end,
    lang = case when p->>'lang' in ('es','en') then p->>'lang' else lang end,
    agent_code = case when p ? 'agent_code' then nullif(p->>'agent_code', '') else agent_code end,
    agent_set_at = case when p ? 'agent_code' and nullif(p->>'agent_code', '') is distinct from agent_code then now() else agent_set_at end
  where user_id = p_user returning * into c;
  if p ? 'stage' then
    insert into public.jag_contact_notes (user_id, agent_code, author_name, kind, subject, meta)
    values (p_user, v_me, public.jag_me_name(), 'system', 'Stage → ' || coalesce(c.stage, 'none'), jsonb_build_object('stage', c.stage));
  end if;
  v_new := nullif(p->>'agent_code', '');
  if p ? 'agent_code' and v_new is not null and v_new is distinct from v_me then
    perform public.jag_notify_agent(v_new, 'assigned', coalesce(c.name, c.email) || ' was assigned to you',
      'By ' || public.jag_me_name() || '. Open their profile in Contacts.', p_user, null,
      '📌 ' || public.jag_me_name() || ' assigned ' || coalesce(c.name, c.email) || ' to you. Their profile: https://jasonaguirregroup.company/workspace#hub=' || replace('%23c/' || p_user::text, '/', '%2F'));
  end if;
  return json_build_object('ok', true, 'stage', c.stage, 'tags', c.tags, 'agent_code', c.agent_code);
end $function$;

create or replace function public.jag_contact_note(p_user uuid, p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_me text := public.jag_agent_code_me(); v_kind text := coalesce(p->>'kind', 'note'); n public.jag_contact_notes; c public.jag_clients; v_to text; v_who text := public.jag_me_name();
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if v_kind not in ('note','call','text') then return json_build_object('ok', false, 'reason', 'kind'); end if;
  select * into c from public.jag_clients where user_id = p_user;
  if c.user_id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if btrim(coalesce(p->>'body', '')) = '' and v_kind = 'note' then return json_build_object('ok', false, 'reason', 'empty'); end if;
  insert into public.jag_contact_notes (user_id, agent_code, author_name, kind, subject, body, meta)
  values (p_user, v_me, v_who, v_kind, nullif(left(btrim(coalesce(p->>'subject', '')), 300), ''), left(btrim(coalesce(p->>'body', '')), 10000),
          coalesce(p->'meta', '{}'::jsonb) - 'notify')
  returning * into n;
  -- people named in "Notify": in-app + a Lola text
  for v_to in select distinct jsonb_array_elements_text(coalesce(p->'notify', '[]'::jsonb)) loop
    if v_to is distinct from v_me and exists (select 1 from public.jag_agents where code = v_to and active) then
      perform public.jag_notify_agent(v_to, 'note', v_who || ' left a note on ' || coalesce(c.name, c.email),
        left(btrim(coalesce(p->>'body', '')), 160), p_user, null,
        '📝 ' || v_who || ' on ' || coalesce(c.name, c.email) || ': ' || left(btrim(coalesce(p->>'body', '')), 220));
    end if;
  end loop;
  return json_build_object('ok', true, 'id', n.id, 'at', n.created_at);
end $function$;

create or replace function public.jag_contact_task(p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_me text := public.jag_agent_code_me(); t public.jag_contact_tasks; c public.jag_clients;
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
  select * into c from public.jag_clients where user_id = (p->>'user_id')::uuid;
  if c.user_id is null or btrim(coalesce(p->>'title', '')) = '' then return json_build_object('ok', false, 'reason', 'empty'); end if;
  insert into public.jag_contact_tasks (user_id, agent_code, title, due_at, created_by)
  values (c.user_id, coalesce(nullif(p->>'agent_code', ''), v_me), left(btrim(p->>'title'), 300), nullif(p->>'due_at', '')::timestamptz, v_me)
  returning * into t;
  if t.agent_code is distinct from v_me then
    perform public.jag_notify_agent(t.agent_code, 'task', 'New task: ' || t.title, 'For ' || coalesce(c.name, c.email) || ' · from ' || public.jag_me_name(), c.user_id, null, null);
  end if;
  return json_build_object('ok', true, 'id', t.id);
end $function$;

create or replace function public.jag_contact_collab(p_user uuid, p_code text, p_add boolean default true)
returns json language plpgsql security definer set search_path = '' as $function$
declare c public.jag_clients; v_me text := public.jag_agent_code_me(); v_who text := public.jag_me_name();
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_clients where user_id = p_user;
  if c.user_id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if not p_add then
    delete from public.jag_contact_collabs where user_id = p_user and agent_code = p_code;
    return json_build_object('ok', true);
  end if;
  if not exists (select 1 from public.jag_agents where code = p_code and active) then return json_build_object('ok', false, 'reason', 'agent'); end if;
  insert into public.jag_contact_collabs (user_id, agent_code, added_by) values (p_user, p_code, v_me) on conflict do nothing;
  if found and p_code is distinct from v_me then
    insert into public.jag_contact_notes (user_id, agent_code, author_name, kind, subject, meta)
    values (p_user, v_me, v_who, 'system', 'Added ' || coalesce((select name from public.jag_agents where code = p_code), p_code) || ' as a collaborator', jsonb_build_object('collab', p_code));
    perform public.jag_notify_agent(p_code, 'collab', v_who || ' added you to ' || coalesce(c.name, c.email),
      'You''re a collaborator now: their history, tasks and notes are in Contacts.', p_user, null,
      '🤝 ' || v_who || ' added you as a collaborator on ' || coalesce(c.name, c.email) || '. Open Contacts in the JAG workspace: https://jasonaguirregroup.company/workspace#hub');
  end if;
  return json_build_object('ok', true);
end $function$;

-- Agent Hub list: contacts this agent collaborates on are "theirs" too
create or replace function public.jag_my_collabs() returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(user_id), '[]'::json) from public.jag_contact_collabs where agent_code = public.jag_agent_code_me();
$$;

revoke all on function public.jag_contact_profile(uuid), public.jag_contact_update(uuid, jsonb), public.jag_contact_note(uuid, jsonb),
  public.jag_contact_task(jsonb), public.jag_contact_collab(uuid, text, boolean), public.jag_my_collabs(), public.jag_me_name() from public, anon;
grant execute on function public.jag_contact_profile(uuid), public.jag_contact_update(uuid, jsonb), public.jag_contact_note(uuid, jsonb),
  public.jag_contact_task(jsonb), public.jag_contact_collab(uuid, text, boolean), public.jag_my_collabs() to authenticated;
grant execute on function public.jag_contact_profile(uuid) to service_role;
