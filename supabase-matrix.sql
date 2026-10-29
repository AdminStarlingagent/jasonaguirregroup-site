-- ============================================================
-- JAG Matrix: the team's HAR Matrix-style search (/matrix).  (applied as migration jag_matrix, 2026-10-29)
--
--  Carts      a list of homes for one client (like Matrix "Carts"). Any team member can make one; the agent who
--             made it owns it; admins and "lead" agents can see every cart. Each cart has a private link token:
--             /lista#<token> shows the client the homes (no agent remarks, MLS display rules respected) and lets
--             them mark Me encanta / Tal vez / No / Quiero verla. A love or a tour request texts the cart's agent (Lola).
--  Campaigns  "Auto email" like Matrix: the search criteria go into jag_lead_drips.params and the hourly
--             lead-emails function sends new matches on the chosen pace (asap / daily / weekly) until stopped,
--             unsubscribed or 180 days. Works for clients with or without a website account.
--  Searches   the team's own saved searches (Matrix "New Saved Search").
-- Only security-definer RPCs touch these tables (RLS on, no policies).
-- ============================================================

create table if not exists public.jag_carts (
  id uuid primary key default gen_random_uuid(),
  token text unique not null default substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 16),
  agent_code text references public.jag_agents(code) on update cascade on delete set null,
  created_by uuid default auth.uid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  email text, phone text,
  lang text not null default 'es' check (lang in ('es', 'en')),
  user_id uuid,          -- website account, when the client has one
  lead_id uuid,          -- JAG Home Loan App, when they applied
  note text,
  criteria jsonb,        -- the last Matrix criteria used for this client
  opens int not null default 0,
  last_open_at timestamptz,
  last_sent_at timestamptz,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jag_carts_agent on public.jag_carts (agent_code, archived, updated_at desc);
alter table public.jag_carts enable row level security;

create table if not exists public.jag_cart_homes (
  cart_id uuid not null references public.jag_carts(id) on delete cascade,
  mls text not null check (mls ~ '^[0-9A-Za-z-]{3,20}$'),
  snap jsonb not null default '{}'::jsonb,   -- public facts only: price, beds, baths, sqft, address, photo, status, display flags
  agent_note text,
  added_by text,
  added_at timestamptz not null default now(),
  reaction text check (reaction in ('love', 'maybe', 'no', 'tour')),
  client_note text,
  reacted_at timestamptz,
  primary key (cart_id, mls)
);
alter table public.jag_cart_homes enable row level security;

create table if not exists public.jag_team_searches (
  id uuid primary key default gen_random_uuid(),
  agent_code text references public.jag_agents(code) on update cascade on delete cascade,
  created_by uuid default auth.uid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  criteria jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.jag_team_searches enable row level security;

-- campaigns from /matrix ride on the existing lead email engine
alter table public.jag_lead_drips add column if not exists params jsonb;
alter table public.jag_lead_drips add column if not exists label text;
alter table public.jag_lead_drips add column if not exists pace text not null default 'standard';
alter table public.jag_lead_drips add column if not exists cart_id uuid;
alter table public.jag_lead_drips add column if not exists ends_at timestamptz;
alter table public.jag_lead_drips add column if not exists user_id uuid;
do $$ begin
  alter table public.jag_lead_drips add constraint jag_lead_drips_pace check (pace in ('standard', 'asap', 'daily', 'weekly'));
exception when duplicate_object then null; end $$;
-- one active screener campaign per email (as before) + one active Matrix campaign per cart
drop index if exists public.jag_lead_drips_one_active;
create unique index if not exists jag_lead_drips_one_active on public.jag_lead_drips (lower(email)) where status = 'active' and params is null;
create unique index if not exists jag_lead_drips_one_cart on public.jag_lead_drips (cart_id) where status = 'active' and cart_id is not null;

-- ---------- helpers ----------
-- can the signed-in team member see every cart? (admins and "lead" agents)
create or replace function public.jag_cart_see_all()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.jag_is_staff(), false) or coalesce(public.jag_has_role('lead'), false);
$$;
create or replace function public.jag_cart_can(p_cart uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.jag_is_team() and exists (select 1 from public.jag_carts c where c.id = p_cart
     and (public.jag_cart_see_all() or c.agent_code = public.jag_agent_code_me() or c.created_by = auth.uid()));
$$;

-- ---------- carts (team) ----------
create or replace function public.jag_cart_list(p_all boolean default false)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare v_me text := public.jag_agent_code_me(); v_all boolean := p_all and public.jag_cart_see_all();
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  return json_build_object('ok', true, 'me', v_me, 'see_all', public.jag_cart_see_all(), 'carts', coalesce((
    select json_agg(x order by x.updated_at desc) from (
      select c.id, c.token, c.name, c.email, c.phone, c.lang, c.agent_code, c.user_id, c.lead_id, c.note, c.criteria,
             c.opens, c.last_open_at, c.last_sent_at, c.created_at, c.updated_at,
             (select a.name from public.jag_agents a where a.code = c.agent_code) as agent_name,
             (select count(*) from public.jag_cart_homes h where h.cart_id = c.id) as homes,
             (select count(*) from public.jag_cart_homes h where h.cart_id = c.id and h.reaction in ('love', 'tour')) as loved,
             (select json_build_object('id', d.id, 'status', d.status, 'pace', d.pace, 'sent_count', d.sent_count, 'last_sent_at', d.last_sent_at,
                     'next_at', d.next_at, 'label', d.label, 'last_error', d.last_error)
                from public.jag_lead_drips d where d.cart_id = c.id order by d.created_at desc limit 1) as campaign
        from public.jag_carts c
       where not c.archived and (v_all or c.agent_code = v_me or c.created_by = auth.uid())
       order by c.updated_at desc limit 300) x), '[]'::json));
end $function$;

-- create or update a cart. p: {id?, name, email?, phone?, lang?, user_id?, lead_id?, note?, criteria?}
create or replace function public.jag_cart_save(p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_em text := lower(nullif(btrim(coalesce(p->>'email', '')), '')); v public.jag_carts; v_uid uuid;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if coalesce(btrim(p->>'name'), '') = '' and v_id is null then return json_build_object('ok', false, 'reason', 'name'); end if;
  if v_em is not null and v_em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return json_build_object('ok', false, 'reason', 'email'); end if;
  v_uid := nullif(p->>'user_id', '')::uuid;
  if v_uid is null and v_em is not null then select c.user_id into v_uid from public.jag_clients c where lower(c.email) = v_em limit 1; end if;
  if v_id is null then
    insert into public.jag_carts (agent_code, name, email, phone, lang, user_id, lead_id, note, criteria)
    values (public.jag_agent_code_me(), left(btrim(p->>'name'), 80), v_em, nullif(btrim(coalesce(p->>'phone', '')), ''),
            case when p->>'lang' = 'en' then 'en' else 'es' end, v_uid, nullif(p->>'lead_id', '')::uuid,
            nullif(left(btrim(coalesce(p->>'note', '')), 500), ''), case when jsonb_typeof(p->'criteria') = 'object' then p->'criteria' end)
    returning * into v;
  else
    if not public.jag_cart_can(v_id) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
    update public.jag_carts set
      name = case when p ? 'name' and btrim(p->>'name') <> '' then left(btrim(p->>'name'), 80) else name end,
      email = case when p ? 'email' then v_em else email end,
      phone = case when p ? 'phone' then nullif(btrim(coalesce(p->>'phone', '')), '') else phone end,
      lang = case when p->>'lang' in ('es', 'en') then p->>'lang' else lang end,
      user_id = coalesce(v_uid, user_id),
      note = case when p ? 'note' then nullif(left(btrim(coalesce(p->>'note', '')), 500), '') else note end,
      criteria = case when jsonb_typeof(p->'criteria') = 'object' then p->'criteria' else criteria end,
      archived = case when p ? 'archived' then coalesce((p->>'archived')::boolean, false) else archived end,
      updated_at = now()
     where id = v_id returning * into v;
  end if;
  return json_build_object('ok', true, 'id', v.id, 'token', v.token);
end $function$;

-- add homes: p_homes = [{mls, snap}]
create or replace function public.jag_cart_add(p_cart uuid, p_homes jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare n int;
begin
  if not public.jag_cart_can(p_cart) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  insert into public.jag_cart_homes (cart_id, mls, snap, added_by)
  select p_cart, left(h->>'mls', 20), coalesce(h->'snap', '{}'::jsonb), public.jag_agent_code_me()
    from jsonb_array_elements(coalesce(p_homes, '[]'::jsonb)) h
   where coalesce(h->>'mls', '') ~ '^[0-9A-Za-z-]{3,20}$'
  on conflict (cart_id, mls) do update set snap = excluded.snap;
  get diagnostics n = row_count;
  update public.jag_carts set updated_at = now() where id = p_cart;
  return json_build_object('ok', true, 'added', n, 'total', (select count(*) from public.jag_cart_homes where cart_id = p_cart));
end $function$;

create or replace function public.jag_cart_remove(p_cart uuid, p_mls text[])
returns json language plpgsql security definer set search_path = '' as $function$
begin
  if not public.jag_cart_can(p_cart) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  delete from public.jag_cart_homes where cart_id = p_cart and mls = any(coalesce(p_mls, '{}'));
  update public.jag_carts set updated_at = now() where id = p_cart;
  return json_build_object('ok', true, 'total', (select count(*) from public.jag_cart_homes where cart_id = p_cart));
end $function$;

create or replace function public.jag_cart_note(p_cart uuid, p_mls text, p_note text)
returns json language plpgsql security definer set search_path = '' as $function$
begin
  if not public.jag_cart_can(p_cart) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  update public.jag_cart_homes set agent_note = nullif(left(btrim(coalesce(p_note, '')), 300), '') where cart_id = p_cart and mls = p_mls;
  return json_build_object('ok', true);
end $function$;

create or replace function public.jag_cart_get(p_cart uuid)
returns json language plpgsql stable security definer set search_path = '' as $function$
begin
  if not public.jag_cart_can(p_cart) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  return json_build_object('ok', true,
    'cart', (select row_to_json(c) from public.jag_carts c where c.id = p_cart),
    'homes', coalesce((select json_agg(h order by h.added_at desc) from public.jag_cart_homes h where h.cart_id = p_cart), '[]'::json),
    'campaign', (select row_to_json(x) from (select d.id, d.status, d.pace, d.label, d.params, d.sent_count, d.last_sent_at, d.next_at,
                   d.ends_at, d.last_error, d.email, d.lang from public.jag_lead_drips d where d.cart_id = p_cart order by d.created_at desc limit 1) x));
end $function$;

-- the agent sent the link (text / WhatsApp / email / copy): log it like other homes sent
create or replace function public.jag_cart_sent(p_cart uuid, p_channel text default null)
returns json language plpgsql security definer set search_path = '' as $function$
declare c public.jag_carts;
begin
  if not public.jag_cart_can(p_cart) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  update public.jag_carts set last_sent_at = now(), updated_at = now() where id = p_cart returning * into c;
  insert into public.jag_homes_sent (agent_code, sent_by, email, phone, user_id, channel, mls, label, link)
  values (coalesce(public.jag_agent_code_me(), c.agent_code), coalesce(public.jag_agent_code_me(), 'team'), c.email, c.phone, c.user_id,
          case when p_channel = 'email' then 'email' else 'text' end, (select coalesce(array_agg(h.mls), '{}') from public.jag_cart_homes h where h.cart_id = c.id),
          'Lista: ' || c.name, 'https://jasonaguirregroup.company/lista#' || c.token);
  return json_build_object('ok', true);
end $function$;

-- find a client to attach a new cart to: website accounts + JAG Home Loan App leads
create or replace function public.jag_cart_people(p_q text)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare v text := '%' || lower(btrim(coalesce(p_q, ''))) || '%'; v_d text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if length(btrim(coalesce(p_q, ''))) < 2 then return json_build_object('ok', true, 'people', '[]'::json); end if;
  return json_build_object('ok', true, 'people', coalesce((select json_agg(x) from (
    (select 'account' as kind, c.user_id::text as id, c.name, c.email, c.phone, c.lang from public.jag_clients c
      where lower(coalesce(c.name, '') || ' ' || coalesce(c.email, '')) like v or (length(v_d) >= 4 and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || v_d || '%')
      order by c.last_seen_at desc nulls last limit 6)
    union all
    (select 'app' as kind, l.id::text, l.name, l.email, l.phone, l.lang from public.jag_leads l
      where l.type in ('Mortgage Application', 'Screened') and (lower(coalesce(l.name, '') || ' ' || coalesce(l.email, '')) like v
         or (length(v_d) >= 4 and regexp_replace(coalesce(l.phone, ''), '\D', '', 'g') like '%' || v_d || '%'))
      order by l.created_at desc limit 6)) x), '[]'::json));
end $function$;

-- ---------- campaigns ----------
-- p: {cart, params (Matrix criteria), label, pace asap|daily|weekly, email?, lang?, consent}
create or replace function public.jag_cart_campaign(p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_cart uuid := nullif(p->>'cart', '')::uuid; c public.jag_carts; v_em text; v_id uuid; v_pace text := coalesce(p->>'pace', 'daily');
begin
  if not public.jag_cart_can(v_cart) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  if coalesce((p->>'consent')::boolean, false) is not true then return json_build_object('ok', false, 'reason', 'consent'); end if;
  if v_pace not in ('asap', 'daily', 'weekly') then v_pace := 'daily'; end if;
  if jsonb_typeof(p->'params') <> 'object' then return json_build_object('ok', false, 'reason', 'criteria'); end if;
  select * into c from public.jag_carts where id = v_cart;
  v_em := lower(btrim(coalesce(nullif(p->>'email', ''), c.email, '')));
  if v_em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return json_build_object('ok', false, 'reason', 'email'); end if;
  if exists (select 1 from public.jag_lead_drips d where lower(d.email) = v_em and d.status = 'unsubscribed' and d.params is not null
              and d.created_at > now() - interval '365 days') and coalesce((p->>'resubscribe')::boolean, false) is not true then
    return json_build_object('ok', false, 'reason', 'unsubscribed');
  end if;
  update public.jag_carts set email = v_em, lang = case when p->>'lang' in ('es', 'en') then p->>'lang' else lang end,
         criteria = p->'params', updated_at = now() where id = v_cart returning * into c;
  update public.jag_lead_drips set params = p->'params', label = left(coalesce(nullif(btrim(p->>'label'), ''), label), 120), pace = v_pace,
         email = v_em, lang = c.lang, name = c.name, phone = c.phone, user_id = c.user_id, consent_at = now(), next_at = now(), last_error = null
   where cart_id = v_cart and status = 'active' returning id into v_id;
  if v_id is null then
    insert into public.jag_lead_drips (email, name, phone, lang, agent_code, params, label, pace, cart_id, user_id, ends_at, next_at)
    values (v_em, c.name, c.phone, c.lang, coalesce(public.jag_agent_code_me(), c.agent_code), p->'params',
            left(coalesce(nullif(btrim(p->>'label'), ''), 'Búsqueda de ' || c.name), 120), v_pace, v_cart, c.user_id, now() + interval '180 days', now())
    returning id into v_id;
  end if;
  perform ops.kick_lead_emails();
  return json_build_object('ok', true, 'id', v_id);
end $function$;

create or replace function public.jag_cart_campaign_stop(p_cart uuid)
returns json language plpgsql security definer set search_path = '' as $function$
begin
  if not public.jag_cart_can(p_cart) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  update public.jag_lead_drips set status = 'stopped', stop_reason = 'agent' where cart_id = p_cart and status = 'active';
  return json_build_object('ok', true);
end $function$;

-- run lead-emails right away (a new campaign's welcome email goes out within a minute, 8 AM–8 PM)
create or replace function ops.kick_lead_emails()
returns void language plpgsql security definer set search_path = '' as $function$
declare v_tok text;
begin
  select decrypted_secret into v_tok from vault.decrypted_secrets where name = 'jag_alerts_token';
  if v_tok is null then return; end if;
  perform net.http_post(url := 'https://nyaxywghbpphjhwcmspd.supabase.co/functions/v1/lead-emails', body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jag-token', v_tok), timeout_milliseconds := 30000);
exception when others then null;
end $function$;

-- ---------- team saved searches ----------
create or replace function public.jag_tsearch_list()
returns json language plpgsql stable security definer set search_path = '' as $function$
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  return json_build_object('ok', true, 'searches', coalesce((select json_agg(s order by s.created_at desc) from public.jag_team_searches s
     where s.agent_code = public.jag_agent_code_me() or s.created_by = auth.uid()), '[]'::json));
end $function$;
create or replace function public.jag_tsearch_save(p_name text, p_criteria jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_id uuid;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  insert into public.jag_team_searches (agent_code, name, criteria) values (public.jag_agent_code_me(), left(btrim(p_name), 80), p_criteria) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end $function$;
create or replace function public.jag_tsearch_delete(p_id uuid)
returns json language plpgsql security definer set search_path = '' as $function$
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  delete from public.jag_team_searches where id = p_id and (agent_code = public.jag_agent_code_me() or created_by = auth.uid());
  return json_build_object('ok', true);
end $function$;

-- ---------- the client's page (/lista#token, no sign-in) ----------
create or replace function public.jag_cart_public(p_token text)
returns json language plpgsql security definer set search_path = '' as $function$
declare c public.jag_carts; a public.jag_agents;
begin
  select * into c from public.jag_carts where token = p_token and not archived;
  if not found then return json_build_object('ok', false); end if;
  select * into a from public.jag_agents where code = c.agent_code and active;
  return json_build_object('ok', true, 'first', split_part(btrim(c.name), ' ', 1), 'lang', c.lang,
    'agent', case when a.code is null then null else json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'phone', a.phone, 'photo_url', a.photo_url) end,
    'homes', coalesce((select json_agg(json_build_object('mls', h.mls, 'snap', h.snap, 'note', h.agent_note, 'reaction', h.reaction, 'client_note', h.client_note) order by h.added_at desc)
                         from public.jag_cart_homes h where h.cart_id = c.id
                          and coalesce(h.snap->>'pub', 'Y') <> 'N'), '[]'::json));
end $function$;

-- count one open (the page calls it once per visit)
create or replace function public.jag_cart_opened(p_token text)
returns void language plpgsql security definer set search_path = '' as $function$
declare c public.jag_carts; v_member int;
begin
  update public.jag_carts set opens = opens + 1, last_open_at = now() where token = p_token and not archived returning * into c;
  -- first open: let the agent know the client is looking
  if c.id is not null and c.opens = 1 then
    select t.id into v_member from public.jag_agents ag join ops.team t on t.fub_user_id = ag.fub_user_id and t.active where ag.code = c.agent_code;
    if v_member is not null then
      perform ops.lola_text(v_member, '👀 ' || c.name || ' just opened the homes list you sent (' ||
        (select count(*) from public.jag_cart_homes h where h.cart_id = c.id) || ' homes). Perfect time to call, babe. https://jasonaguirregroup.company/matrix#cart=' || c.id, 'cart_open', null);
      perform ops.kick_team_texts();
    end if;
  end if;
end $function$;

-- the client reacts to a home: love | maybe | no | tour (+ optional note). Love and tour text the agent.
create or replace function public.jag_cart_react(p_token text, p_mls text, p_reaction text, p_note text default null)
returns json language plpgsql security definer set search_path = '' as $function$
declare c public.jag_carts; h public.jag_cart_homes; v_member int; v_addr text; v_prev text;
begin
  if p_reaction is not null and p_reaction not in ('love', 'maybe', 'no', 'tour') then return json_build_object('ok', false); end if;
  select * into c from public.jag_carts where token = p_token and not archived;
  if not found then return json_build_object('ok', false); end if;
  select reaction into v_prev from public.jag_cart_homes where cart_id = c.id and mls = p_mls;
  update public.jag_cart_homes set reaction = p_reaction, reacted_at = now(),
         client_note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 400), ''), client_note)
   where cart_id = c.id and mls = p_mls returning * into h;
  if h.mls is null then return json_build_object('ok', false); end if;
  update public.jag_carts set updated_at = now() where id = c.id;
  if p_reaction in ('love', 'tour') and v_prev is distinct from p_reaction then
    v_addr := coalesce(nullif(h.snap->>'addr', ''), 'MLS ' || h.mls) || coalesce(' ($' || to_char((h.snap->>'price')::numeric, 'FM999,999,999') || ')', '');
    select t.id into v_member from public.jag_agents ag join ops.team t on t.fub_user_id = ag.fub_user_id and t.active where ag.code = c.agent_code;
    if v_member is not null then
      perform ops.lola_text(v_member,
        case when p_reaction = 'tour' then '🏃‍♀️ ' || c.name || ' wants to SEE ' || v_addr || '. Book the showing before someone else does!'
             else '😍 ' || c.name || ' loves ' || v_addr || '. Call while it''s hot, girl.' end
        || coalesce(' Note: "' || left(btrim(p_note), 160) || '"', '')
        || ' https://jasonaguirregroup.company/matrix#cart=' || c.id, 'cart_react', null);
      perform ops.kick_team_texts();
    end if;
  end if;
  return json_build_object('ok', true);
end $function$;

-- ---------- grants ----------
revoke all on function public.jag_cart_see_all(), public.jag_cart_can(uuid), public.jag_cart_list(boolean), public.jag_cart_save(jsonb),
  public.jag_cart_add(uuid, jsonb), public.jag_cart_remove(uuid, text[]), public.jag_cart_note(uuid, text, text), public.jag_cart_get(uuid),
  public.jag_cart_sent(uuid, text), public.jag_cart_people(text), public.jag_cart_campaign(jsonb), public.jag_cart_campaign_stop(uuid),
  public.jag_tsearch_list(), public.jag_tsearch_save(text, jsonb), public.jag_tsearch_delete(uuid),
  public.jag_cart_public(text), public.jag_cart_opened(text), public.jag_cart_react(text, text, text, text) from public;
revoke all on function public.jag_cart_see_all(), public.jag_cart_can(uuid), public.jag_cart_list(boolean), public.jag_cart_save(jsonb),
  public.jag_cart_add(uuid, jsonb), public.jag_cart_remove(uuid, text[]), public.jag_cart_note(uuid, text, text), public.jag_cart_get(uuid),
  public.jag_cart_sent(uuid, text), public.jag_cart_people(text), public.jag_cart_campaign(jsonb), public.jag_cart_campaign_stop(uuid),
  public.jag_tsearch_list(), public.jag_tsearch_save(text, jsonb), public.jag_tsearch_delete(uuid) from anon;
revoke all on function ops.kick_lead_emails() from public, anon, authenticated;
grant execute on function public.jag_cart_see_all(), public.jag_cart_can(uuid), public.jag_cart_list(boolean), public.jag_cart_save(jsonb),
  public.jag_cart_add(uuid, jsonb), public.jag_cart_remove(uuid, text[]), public.jag_cart_note(uuid, text, text), public.jag_cart_get(uuid),
  public.jag_cart_sent(uuid, text), public.jag_cart_people(text), public.jag_cart_campaign(jsonb), public.jag_cart_campaign_stop(uuid),
  public.jag_tsearch_list(), public.jag_tsearch_save(text, jsonb), public.jag_tsearch_delete(uuid) to authenticated;
grant execute on function public.jag_cart_public(text), public.jag_cart_opened(text), public.jag_cart_react(text, text, text, text) to anon, authenticated;
