-- ============================================================
-- Offers from the website, client proof (pre-approval / proof of funds),
-- team status updates and buyer priority.
-- Clients and the anon site only touch these through the RPCs below.
-- ============================================================

create table if not exists public.jag_offers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  lead_id uuid,
  name text, email text, phone text, co_buyer text, lang text,
  mls text, address text, list_price numeric, property_type text,
  offer_price numeric, earnest numeric, expires date,
  financing text check (financing in ('cash','financed')),
  loan_type text, down_payment text, lender text,
  proof text check (proof in ('yes','working','no')),
  contingencies text[] default '{}',
  option_days int, close_date date, notes text,
  agent_code text,
  status text not null default 'submitted'
    check (status in ('submitted','reviewing','sent','countered','accepted','declined','withdrawn')),
  status_note text, status_at timestamptz, status_by text
);
create index if not exists jag_offers_user on public.jag_offers(user_id);
create index if not exists jag_offers_email on public.jag_offers(lower(email));
alter table public.jag_offers enable row level security;

create table if not exists public.jag_client_proof (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('preapproval','pof')),
  path text not null, file_name text,
  uploaded_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','verified','rejected')),
  note text, reviewed_by text, reviewed_at timestamptz
);
create index if not exists jag_client_proof_user on public.jag_client_proof(user_id);
alter table public.jag_client_proof enable row level security;
drop policy if exists "client reads own proof" on public.jag_client_proof;
create policy "client reads own proof" on public.jag_client_proof for select to authenticated using (user_id = auth.uid());

-- private bucket: each client uploads only into their own folder
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-proof','client-proof', false, 10485760,
        array['application/pdf','image/jpeg','image/png','image/heic','image/heif','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "client proof: upload own" on storage.objects;
create policy "client proof: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'client-proof' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "client proof: read own" on storage.objects;
create policy "client proof: read own" on storage.objects for select to authenticated
  using (bucket_id = 'client-proof' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "client proof: team reads" on storage.objects;
create policy "client proof: team reads" on storage.objects for select to authenticated
  using (bucket_id = 'client-proof' and (public.jag_is_staff() or public.jag_agent_code_me() is not null));

-- anyone on the team: admin staff or an active agent
create or replace function public.jag_is_team() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.jag_is_staff() or public.jag_agent_code_me() is not null;
$$;

-- ---------- the website submits an offer (anon or signed in) ----------
create or replace function public.jag_offer_submit(p jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_lead uuid; v_id uuid; v_agent text; v_phone text := left(regexp_replace(coalesce(p->>'phone',''), '\D', '', 'g'), 15);
  v_email text := lower(left(trim(coalesce(p->>'email','')), 160)); v_name text := left(trim(coalesce(p->>'name','')), 120);
  v_price numeric := nullif(regexp_replace(coalesce(p->>'offer_price',''), '[^0-9.]', '', 'g'), '')::numeric;
begin
  if v_name = '' or length(v_phone) < 10 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or coalesce(v_price,0) <= 0 then
    return json_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- simple flood guard
  if (select count(*) from public.jag_offers where phone = v_phone and created_at > now() - interval '1 hour') >= 5 then
    return json_build_object('ok', false, 'reason', 'too_many');
  end if;
  select a.code into v_agent from public.jag_agents a where a.active and a.code = lower(p->>'agent_code');
  if v_agent is null and auth.uid() is not null then
    select c.agent_code into v_agent from public.jag_clients c where c.user_id = auth.uid();
  end if;

  insert into public.jag_leads (type, name, email, phone, lang, source, status, payload, est_amount)
  values ('Buyer Offer', v_name, v_email, v_phone, left(p->>'lang', 5), left(p->>'source', 300), 'New', p, v_price)
  returning id into v_lead;

  insert into public.jag_offers (user_id, lead_id, name, email, phone, co_buyer, lang, mls, address, list_price, property_type,
    offer_price, earnest, expires, financing, loan_type, down_payment, lender, proof, contingencies, option_days, close_date, notes, agent_code)
  values (auth.uid(), v_lead, v_name, v_email, v_phone, left(p->>'co_buyer', 120), left(p->>'lang', 5),
    left(p->>'mls', 30), left(p->>'address', 200), nullif(regexp_replace(coalesce(p->>'list_price',''), '[^0-9.]', '', 'g'), '')::numeric,
    left(p->>'property_type', 40), v_price,
    nullif(regexp_replace(coalesce(p->>'earnest',''), '[^0-9.]', '', 'g'), '')::numeric,
    nullif(p->>'expires','')::date,
    case when p->>'financing' in ('cash','financed') then p->>'financing' end,
    left(p->>'loan_type', 30), left(p->>'down_payment', 40), left(p->>'lender', 80),
    case when p->>'proof' in ('yes','working','no') then p->>'proof' end,
    coalesce((select array_agg(left(x, 40)) from jsonb_array_elements_text(coalesce(p->'contingencies','[]'::jsonb)) x), '{}'),
    nullif(regexp_replace(coalesce(p->>'option_days',''), '\D', '', 'g'), '')::int,
    nullif(p->>'close_date','')::date, left(p->>'notes', 2000), v_agent)
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end $$;

-- ---------- the client's portal: their offers + proof ----------
create or replace function public.jag_my_offers() returns json
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(auth.jwt()->>'email');
begin
  if auth.uid() is null then return json_build_object('ok', false); end if;
  -- claim offers sent before signing in (the email is verified by the sign-in code)
  update public.jag_offers set user_id = auth.uid() where user_id is null and lower(email) = v_email and v_email <> '';
  return json_build_object('ok', true,
    'offers', coalesce((select json_agg(o order by o.created_at desc) from (
       select id, created_at, mls, address, list_price, offer_price, earnest, financing, loan_type, proof, contingencies,
              option_days, close_date, status, status_note, status_at
         from public.jag_offers where user_id = auth.uid()) o), '[]'::json),
    'proof', coalesce((select json_agg(x order by x.uploaded_at desc) from (
       select id, kind, file_name, uploaded_at, status, note from public.jag_client_proof where user_id = auth.uid()) x), '[]'::json));
end $$;

create or replace function public.jag_proof_add(p_kind text, p_path text, p_name text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or p_kind not in ('preapproval','pof') or split_part(p_path, '/', 1) <> auth.uid()::text then
    return json_build_object('ok', false);
  end if;
  insert into public.jag_client_proof (user_id, kind, path, file_name) values (auth.uid(), p_kind, left(p_path, 300), left(p_name, 160));
  return json_build_object('ok', true);
end $$;

-- ---------- the team ----------
create or replace function public.jag_offer_set_status(p_id uuid, p_status text, p_note text default null) returns json
language plpgsql security definer set search_path = '' as $$
declare v_by text := coalesce(public.jag_agent_code_me(), auth.jwt()->>'email');
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if p_status not in ('submitted','reviewing','sent','countered','accepted','declined','withdrawn') then
    return json_build_object('ok', false, 'reason', 'bad_status'); end if;
  update public.jag_offers set status = p_status, status_note = nullif(left(trim(coalesce(p_note,'')), 500), ''),
         status_at = now(), status_by = v_by, updated_at = now() where id = p_id;
  update public.jag_leads l set status = case p_status when 'accepted' then 'Won' when 'declined' then 'Lost' else l.status end
    from public.jag_offers o where o.id = p_id and l.id = o.lead_id and p_status in ('accepted','declined');
  return json_build_object('ok', true);
end $$;

create or replace function public.jag_proof_review(p_id uuid, p_status text, p_note text default null) returns json
language plpgsql security definer set search_path = '' as $$
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if p_status not in ('pending','verified','rejected') then return json_build_object('ok', false); end if;
  update public.jag_client_proof set status = p_status, note = nullif(left(trim(coalesce(p_note,'')), 300), ''),
         reviewed_by = coalesce(public.jag_agent_code_me(), auth.jwt()->>'email'), reviewed_at = now() where id = p_id;
  return json_build_object('ok', true);
end $$;

-- priority: 1 = verified pre-approval or proof of funds, 2 = in contact with us, 3 = browsing
create or replace function public.jag_client_priority(p_user uuid) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'proof', (select kind from public.jag_client_proof where user_id = p_user and status = 'verified' order by reviewed_at desc limit 1),
    'proof_pending', exists (select 1 from public.jag_client_proof where user_id = p_user and status = 'pending'),
    'in_contact', exists (select 1 from public.jag_clients c where c.user_id = p_user and c.agent_code is not null)
                  or exists (select 1 from public.jag_offers o where o.user_id = p_user)
                  or exists (select 1 from public.jag_client_activity a where a.user_id = p_user and a.kind in ('inquiry','form_open')
                             and a.created_at > now() - interval '60 days'),
    'offers', (select count(*) from public.jag_offers o where o.user_id = p_user),
    'last_offer', (select status from public.jag_offers o where o.user_id = p_user order by created_at desc limit 1));
$$;
revoke all on function public.jag_client_priority(uuid) from public, anon, authenticated;

-- every offer, newest first, with the buyer's priority (team only)
create or replace function public.jag_offers_team() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  return json_build_object('ok', true, 'offers', coalesce((select json_agg(x order by x.created_at desc) from (
     select o.*, case when o.user_id is null then null else public.jag_client_priority(o.user_id) end as priority
       from public.jag_offers o order by o.created_at desc limit 300) x), '[]'::json),
    'proof', coalesce((select json_agg(y order by y.uploaded_at desc) from (
     select p.id, p.user_id, p.kind, p.path, p.file_name, p.uploaded_at, p.status, p.note, p.reviewed_by, p.reviewed_at,
            c.name, c.email, c.phone
       from public.jag_client_proof p left join public.jag_clients c on c.user_id = p.user_id
      order by p.uploaded_at desc limit 300) y), '[]'::json));
end $$;

-- Agent Hub client list, now with priority tier first
create or replace function public.jag_agent_clients() returns json
language plpgsql stable security definer set search_path = '' as $$
declare v_code text := public.jag_agent_code_me();
begin
  if v_code is null and not public.jag_is_staff() then return json_build_object('ok', false, 'reason', 'not_agent'); end if;
  return json_build_object('ok', true, 'me', v_code, 'clients', coalesce((
    select json_agg(x order by x.tier, x.score desc nulls last, x.last_seen_at desc nulls last) from (
      select z.*, case when (z.priority->>'proof') is not null then 1 when (z.priority->>'in_contact')::boolean then 2 else 3 end as tier
      from (
      select c.user_id, c.name, c.email, c.phone, c.lang, c.created_at, c.last_seen_at, c.agent_code, c.alert_freq,
             s.score, s.tags, s.top_zip, s.best_hour, s.homes, s.last_hot_at,
             public.jag_client_priority(c.user_id) as priority,
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
        left join public.jag_client_scores s on s.user_id = c.user_id) z) x), '[]'::json),
    'shares', coalesce((select json_agg(y order by y.created_at desc) from (
      select id, kind, mls, label, channel, created_at, opens, last_open_at from public.jag_agent_shares
       where agent_code = v_code order by created_at desc limit 40) y), '[]'::json));
end $$;

-- one client's detail now includes their offers and proof
create or replace function public.jag_agent_client_detail(p_user uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.jag_agent_code_me() is null and not public.jag_is_staff() then return json_build_object('ok', false); end if;
  return json_build_object('ok', true,
    'favorites', coalesce((select json_agg(f order by f.saved_at desc) from public.jag_client_favorites f where f.user_id = p_user), '[]'::json),
    'searches', coalesce((select json_agg(s order by s.created_at desc) from public.jag_client_searches s where s.user_id = p_user), '[]'::json),
    'activity', coalesce((select json_agg(a order by a.created_at desc) from (select kind, mls, zip, city, price, beds, created_at
       from public.jag_client_activity where user_id = p_user order by created_at desc limit 40) a), '[]'::json),
    'offers', coalesce((select json_agg(o order by o.created_at desc) from public.jag_offers o where o.user_id = p_user), '[]'::json),
    'proof', coalesce((select json_agg(p order by p.uploaded_at desc) from (select id, kind, path, file_name, uploaded_at, status, note
       from public.jag_client_proof where user_id = p_user) p), '[]'::json));
end $$;

revoke all on function public.jag_offer_submit(jsonb) from public;
grant execute on function public.jag_offer_submit(jsonb) to anon, authenticated;
revoke all on function public.jag_my_offers() from public, anon;
grant execute on function public.jag_my_offers() to authenticated;
revoke all on function public.jag_proof_add(text, text, text) from public, anon;
grant execute on function public.jag_proof_add(text, text, text) to authenticated;
revoke all on function public.jag_offer_set_status(uuid, text, text) from public, anon;
grant execute on function public.jag_offer_set_status(uuid, text, text) to authenticated;
revoke all on function public.jag_proof_review(uuid, text, text) from public, anon;
grant execute on function public.jag_proof_review(uuid, text, text) to authenticated;
revoke all on function public.jag_offers_team() from public, anon;
grant execute on function public.jag_offers_team() to authenticated;
revoke all on function public.jag_is_team() from public, anon;
grant execute on function public.jag_is_team() to authenticated;
