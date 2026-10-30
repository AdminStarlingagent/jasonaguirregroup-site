-- ============================================================
-- Agent profiles (jasonaguirregroup.company/agente/<code>) + team videos in JAG Reels.
--
--   jag_agents (new columns)  what the public profile shows: title, bio (ES/EN), languages, areas, HAR login IDs, license
--   jag_agent_sold            homes each agent closed, from HAR (buyer's or listing agent), synced by edge fn jag-agent-profile
--   jag_agent_videos          videos the team uploads from the Agent Hub; Jason approves them before they go public
--   storage bucket agent-videos (public files; only approved videos are ever listed)
--
-- Public (no login): jag_agent_profile(code), jag_team_public(), jag_reel_videos(area), jag_video_view(id)
-- Team (Agent Hub):  jag_my_profile_get(code?), jag_my_profile_save(p, code?), jag_video_add(p), jag_video_remove(id)
-- Jason (approver):  jag_video_review(id, ok, note)
-- Sold prices are never returned (Texas non-disclosure; same rule as the search page). Street addresses aren't either:
-- city, ZIP and subdivision only, so a family's home isn't pinned to their name.
-- ============================================================

alter table public.jag_agents
  add column if not exists profile_on boolean not null default false,
  add column if not exists title_es text,
  add column if not exists title_en text,
  add column if not exists bio_es text,
  add column if not exists bio_en text,
  add column if not exists langs text[] not null default '{es,en}',
  add column if not exists areas text[] not null default '{}',
  add column if not exists har_ids text[] not null default '{}',
  add column if not exists license_no text,
  add column if not exists licensed_year int,
  add column if not exists profile_sort int not null default 50,
  add column if not exists profile_at timestamptz;

create table if not exists public.jag_agent_sold (
  mls text not null,
  agent_code text not null references public.jag_agents(code) on update cascade on delete cascade,
  side text not null check (side in ('buyer', 'list')),
  sold_date date,
  city text, zip text, subdivision text,
  lat double precision, lng double precision,
  beds numeric, baths numeric, sqft int, ptype text, style text,
  photo text,
  hidden boolean not null default false,
  synced_at timestamptz not null default now(),
  primary key (mls, agent_code, side)
);
create index if not exists jag_agent_sold_agent on public.jag_agent_sold (agent_code, sold_date desc);
alter table public.jag_agent_sold enable row level security;

create table if not exists public.jag_agent_videos (
  id uuid primary key default gen_random_uuid(),
  agent_code text not null references public.jag_agents(code) on update cascade on delete cascade,
  path text not null unique,
  poster text,
  kind text not null default 'other' check (kind in ('intro', 'tour', 'area', 'tip', 'closing', 'other')),
  title text,
  area text,
  lang text check (lang in ('es', 'en')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'removed')),
  review_note text,
  codec text,
  duration numeric,
  width int, height int, size_bytes bigint,
  uploaded_by uuid,
  reviewed_by text, reviewed_at timestamptz,
  views int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jag_agent_videos_pub on public.jag_agent_videos (status, created_at desc);
alter table public.jag_agent_videos enable row level security;

-- storage: public files (the feed streams them), team-only uploads into their own folder
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agent-videos', 'agent-videos', true, 209715200,
        array['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- the one person who approves videos: the team lead in ops.team (Jason), or staff
create or replace function public.jag_video_approver() returns boolean
language sql stable security definer set search_path to '' as $$
  select public.jag_is_staff() or exists (
    select 1 from ops.team t join public.jag_agents a on a.fub_user_id = t.fub_user_id
     where t.active and t.role = 'lead' and a.code = public.jag_agent_code_me());
$$;

drop policy if exists "agent videos: team uploads to own folder" on storage.objects;
create policy "agent videos: team uploads to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'agent-videos' and (
    (storage.foldername(name))[1] = public.jag_agent_code_me() or public.jag_video_approver()));
drop policy if exists "agent videos: owner or approver deletes" on storage.objects;
create policy "agent videos: owner or approver deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'agent-videos' and (
    (storage.foldername(name))[1] = public.jag_agent_code_me() or public.jag_video_approver()));

create or replace function public.jag_video_url(p_path text) returns text
language sql immutable set search_path to '' as $$
  select case when p_path is null or p_path = '' then null
              else 'https://nyaxywghbpphjhwcmspd.supabase.co/storage/v1/object/public/agent-videos/' || p_path end;
$$;

-- one approved video, as the page and the feed use it
create or replace function public.jag_video_json(v public.jag_agent_videos) returns json
language sql stable set search_path to '' as $$
  select json_build_object('id', v.id, 'url', public.jag_video_url(v.path), 'poster', public.jag_video_url(v.poster),
    'kind', v.kind, 'title', v.title, 'area', v.area, 'lang', v.lang, 'codec', v.codec, 'duration', v.duration,
    'w', v.width, 'h', v.height, 'views', v.views, 'at', v.created_at);
$$;

-- small agent card (feed, team list)
create or replace function public.jag_agent_card(a public.jag_agents) returns json
language sql stable set search_path to '' as $$
  select json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'photo_url', a.photo_url,
    'title_es', a.title_es, 'title_en', a.title_en);
$$;

-- ---------------- public: the profile page ----------------
create or replace function public.jag_agent_profile(p_code text) returns json
language plpgsql stable security definer set search_path to '' as $$
declare a public.jag_agents; v_sold json; v_stats json; v_cities json; v_videos json; v_team json;
begin
  select * into a from public.jag_agents where active and profile_on and code = lower(btrim(coalesce(p_code, '')));
  if a.code is null then return json_build_object('ok', false); end if;

  select json_build_object('closed', count(distinct s.mls), 'buyers', count(distinct s.mls) filter (where s.side = 'buyer'),
           'sellers', count(distinct s.mls) filter (where s.side = 'list'), 'first', min(s.sold_date), 'last', max(s.sold_date))
    into v_stats from public.jag_agent_sold s where s.agent_code = a.code and not s.hidden;

  select coalesce(json_agg(x order by x.n desc, x.city), '[]'::json) into v_cities from (
    select s.city, count(distinct s.mls) n, avg(s.lat) lat, avg(s.lng) lng
      from public.jag_agent_sold s where s.agent_code = a.code and not s.hidden and s.city is not null
     group by s.city order by n desc, s.city limit 12) x;

  select coalesce(json_agg(json_build_object('mls', x.mls, 'date', to_char(x.sold_date, 'YYYY-MM'), 'city', x.city, 'zip', x.zip,
           'sub', x.subdivision, 'lat', round(x.lat::numeric, 3), 'lng', round(x.lng::numeric, 3), 'beds', x.beds, 'baths', x.baths,
           'sqft', x.sqft, 'ptype', x.ptype, 'style', x.style, 'photo', x.photo, 'side', x.side) order by x.sold_date desc nulls last), '[]'::json)
    into v_sold from (
      select distinct on (s.mls) s.* from public.jag_agent_sold s where s.agent_code = a.code and not s.hidden
       order by s.mls, s.sold_date desc) x;

  select coalesce(json_agg(public.jag_video_json(v) order by (v.kind = 'intro') desc, v.created_at desc), '[]'::json) into v_videos
    from public.jag_agent_videos v where v.agent_code = a.code and v.status = 'approved';

  select coalesce(json_agg(public.jag_agent_card(t) order by t.profile_sort, t.name), '[]'::json) into v_team
    from public.jag_agents t where t.active and t.profile_on and t.code <> a.code;

  return json_build_object('ok', true,
    'agent', json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'photo_url', a.photo_url,
      'phone', coalesce(a.phone_override, a.phone), 'title_es', a.title_es, 'title_en', a.title_en, 'bio_es', a.bio_es, 'bio_en', a.bio_en,
      'langs', a.langs, 'areas', a.areas, 'license_no', a.license_no, 'licensed_year', a.licensed_year),
    'stats', v_stats, 'cities', v_cities, 'sold', v_sold, 'videos', v_videos, 'team', v_team);
end $$;

-- public: the whole team (for the team strip and a team page)
create or replace function public.jag_team_public() returns json
language sql stable security definer set search_path to '' as $$
  select coalesce(json_agg(json_build_object('card', public.jag_agent_card(a),
           'closed', (select count(distinct s.mls) from public.jag_agent_sold s where s.agent_code = a.code and not s.hidden),
           'videos', (select count(*) from public.jag_agent_videos v where v.agent_code = a.code and v.status = 'approved'))
         order by a.profile_sort, a.name), '[]'::json)
    from public.jag_agents a where a.active and a.profile_on;
$$;

-- public: team videos for JAG Reels. Videos tagged with the area being searched come first, then the rest, newest first
-- with a little shuffle so the same video doesn't always lead.
create or replace function public.jag_reel_videos(p_area text default null, p_limit int default 30) returns json
language sql stable security definer set search_path to '' as $$
  select coalesce(json_agg(json_build_object('video', public.jag_video_json(y.vid), 'agent', public.jag_agent_card(y.ag))
                    order by y.hit desc, y.score desc), '[]'::json)
    from (select x.vid, a as ag, x.hit, x.score
            from (select v as vid, (p_area is not null and v.area is not null and lower(v.area) = lower(btrim(p_area))) as hit,
                         extract(epoch from v.created_at) / 86400.0 + random() * 7 as score
                    from public.jag_agent_videos v where v.status = 'approved'
                   order by v.created_at desc limit 200) x
            join public.jag_agents a on a.code = (x.vid).agent_code and a.active and a.profile_on
           order by x.hit desc, x.score desc
           limit least(greatest(coalesce(p_limit, 30), 1), 60)) y;
$$;

create or replace function public.jag_video_view(p_id uuid) returns void
language sql security definer set search_path to '' as $$
  update public.jag_agent_videos set views = views + 1 where id = p_id and status = 'approved';
$$;

-- ---------------- team: my profile + my videos (Jason can open anyone's) ----------------
create or replace function public.jag_my_profile_get(p_code text default null) returns json
language plpgsql stable security definer set search_path to '' as $$
declare v_me text := public.jag_agent_code_me(); v_appr boolean := public.jag_video_approver(); v_code text; a public.jag_agents;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'team_only'); end if;
  v_code := case when p_code is not null and v_appr then lower(p_code) else v_me end;
  select * into a from public.jag_agents where code = v_code;
  if a.code is null then return json_build_object('ok', false, 'reason', 'no_agent'); end if;
  return json_build_object('ok', true, 'approver', v_appr, 'me', v_me,
    'agent', json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'photo_url', public.jag_agent_photo(a),
      'phone', coalesce(a.phone_override, a.phone), 'profile_on', a.profile_on, 'title_es', a.title_es, 'title_en', a.title_en,
      'bio_es', a.bio_es, 'bio_en', a.bio_en, 'langs', a.langs, 'areas', a.areas, 'har_ids', a.har_ids,
      'license_no', a.license_no, 'licensed_year', a.licensed_year),
    'closed', (select count(distinct s.mls) from public.jag_agent_sold s where s.agent_code = a.code and not s.hidden),
    'videos', (select coalesce(json_agg(json_build_object('id', v.id, 'url', public.jag_video_url(v.path), 'poster', public.jag_video_url(v.poster),
                 'kind', v.kind, 'title', v.title, 'area', v.area, 'status', v.status, 'note', v.review_note, 'codec', v.codec,
                 'duration', v.duration, 'views', v.views, 'at', v.created_at) order by v.created_at desc), '[]'::json)
                 from public.jag_agent_videos v where v.agent_code = a.code and v.status <> 'removed'),
    'queue', case when v_appr then (select coalesce(json_agg(json_build_object('id', v.id, 'url', public.jag_video_url(v.path),
                 'poster', public.jag_video_url(v.poster), 'kind', v.kind, 'title', v.title, 'area', v.area, 'codec', v.codec,
                 'duration', v.duration, 'at', v.created_at, 'agent', public.jag_agent_card(g)) order by v.created_at), '[]'::json)
                 from public.jag_agent_videos v join public.jag_agents g on g.code = v.agent_code where v.status = 'pending') end,
    'team', case when v_appr then (select coalesce(json_agg(json_build_object('code', g.code, 'name', g.name, 'profile_on', g.profile_on)
                 order by g.profile_sort, g.name), '[]'::json) from public.jag_agents g where g.active) end);
end $$;

create or replace function public.jag_my_profile_save(p jsonb, p_code text default null) returns json
language plpgsql security definer set search_path to '' as $$
declare v_me text := public.jag_agent_code_me(); v_appr boolean := public.jag_video_approver(); v_code text;
        v_t text[];
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'team_only'); end if;
  v_code := case when p_code is not null and v_appr then lower(p_code) else v_me end;
  if v_code is null then return json_build_object('ok', false, 'reason', 'no_agent'); end if;
  update public.jag_agents set
    title_es = case when p ? 'title_es' then nullif(left(btrim(p->>'title_es'), 60), '') else title_es end,
    title_en = case when p ? 'title_en' then nullif(left(btrim(p->>'title_en'), 60), '') else title_en end,
    bio_es = case when p ? 'bio_es' then nullif(left(btrim(p->>'bio_es'), 1200), '') else bio_es end,
    bio_en = case when p ? 'bio_en' then nullif(left(btrim(p->>'bio_en'), 1200), '') else bio_en end,
    langs = case when p ? 'langs' then coalesce(array(select x from jsonb_array_elements_text(p->'langs') x where x in ('es', 'en', 'pt', 'fr') limit 4), '{}') else langs end,
    areas = case when p ? 'areas' then coalesce(array(select left(btrim(x), 40) from jsonb_array_elements_text(p->'areas') x where btrim(x) <> '' limit 15), '{}') else areas end,
    har_ids = case when p ? 'har_ids' then coalesce(array(select left(btrim(x), 30) from jsonb_array_elements_text(p->'har_ids') x where btrim(x) ~ '^[A-Za-z0-9._-]{2,30}$' limit 4), '{}') else har_ids end,
    license_no = case when p ? 'license_no' then nullif(left(regexp_replace(p->>'license_no', '[^0-9A-Za-z-]', '', 'g'), 20), '') else license_no end,
    licensed_year = case when p ? 'licensed_year' then case when (p->>'licensed_year') ~ '^(19[5-9]\d|20[0-3]\d)$' then (p->>'licensed_year')::int end else licensed_year end,
    profile_on = case when v_appr and p ? 'profile_on' then coalesce((p->>'profile_on')::boolean, profile_on) else profile_on end,
    profile_at = now(), updated_at = now()
  where code = v_code;
  return json_build_object('ok', true);
end $$;

-- a video the Agent Hub just uploaded to storage (path = <code>/<file>). Jason's own go live right away; the rest wait for him.
create or replace function public.jag_video_add(p jsonb) returns json
language plpgsql security definer set search_path to '' as $$
declare v_me text := public.jag_agent_code_me(); v_appr boolean := public.jag_video_approver(); v_code text; v_path text; v_id uuid;
        v_name text; v_mid int;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'team_only'); end if;
  v_path := btrim(coalesce(p->>'path', ''));
  v_code := split_part(v_path, '/', 1);
  if v_code = '' or (v_code <> v_me and not v_appr) or v_path !~ '^[a-z0-9]+/[A-Za-z0-9_-]{8,64}\.(mp4|mov|webm)$' then
    return json_build_object('ok', false, 'reason', 'path');
  end if;
  insert into public.jag_agent_videos (agent_code, path, poster, kind, title, area, lang, codec, duration, width, height, size_bytes,
                                       uploaded_by, status, reviewed_by, reviewed_at)
  values (v_code, v_path,
          case when coalesce(p->>'poster', '') ~ ('^' || v_code || '/[A-Za-z0-9_-]{8,64}\.(jpg|jpeg|png|webp)$') then p->>'poster' end,
          case when p->>'kind' in ('intro', 'tour', 'area', 'tip', 'closing', 'other') then p->>'kind' else 'other' end,
          nullif(left(btrim(coalesce(p->>'title', '')), 120), ''), nullif(left(btrim(coalesce(p->>'area', '')), 40), ''),
          case when p->>'lang' in ('es', 'en') then p->>'lang' end,
          nullif(left(p->>'codec', 12), ''), case when (p->>'duration') ~ '^\d+(\.\d+)?$' then round((p->>'duration')::numeric, 1) end,
          case when (p->>'w') ~ '^\d{1,5}$' then (p->>'w')::int end, case when (p->>'h') ~ '^\d{1,5}$' then (p->>'h')::int end,
          case when (p->>'size') ~ '^\d{1,12}$' then (p->>'size')::bigint end,
          auth.uid(), case when v_appr then 'approved' else 'pending' end,
          case when v_appr then v_me end, case when v_appr then now() end)
  returning id into v_id;
  if not v_appr then
    -- tell Jason (the lead) there's a video waiting: one text per upload, in English like the other team alerts
    select a.first_name into v_name from public.jag_agents a where a.code = v_code;
    select t.id into v_mid from ops.team t where t.active and t.role = 'lead' and t.mobile_e164 is not null order by t.id limit 1;
    if v_mid is not null then
      perform ops.lola_text(v_mid, '🎬 ' || coalesce(v_name, 'An agent') || ' uploaded a video for their profile' ||
        coalesce(': "' || left(nullif(btrim(coalesce(p->>'title', '')), ''), 60) || '"', '') ||
        '. Approve it or not: https://jasonaguirregroup.company/workspace#hub=%23profile', 'video_review', null, false);
    end if;
  end if;
  return json_build_object('ok', true, 'id', v_id, 'status', case when v_appr then 'approved' else 'pending' end);
end $$;

create or replace function public.jag_video_review(p_id uuid, p_ok boolean, p_note text default null) returns json
language plpgsql security definer set search_path to '' as $$
begin
  if not public.jag_video_approver() then return json_build_object('ok', false, 'reason', 'approver_only'); end if;
  update public.jag_agent_videos set status = case when p_ok then 'approved' else 'rejected' end,
         review_note = nullif(left(btrim(coalesce(p_note, '')), 300), ''), reviewed_by = public.jag_agent_code_me(), reviewed_at = now(), updated_at = now()
   where id = p_id and status in ('pending', 'approved', 'rejected');
  return json_build_object('ok', found);
end $$;

create or replace function public.jag_video_remove(p_id uuid) returns json
language plpgsql security definer set search_path to '' as $$
declare v public.jag_agent_videos;
begin
  select * into v from public.jag_agent_videos where id = p_id;
  if v.id is null or not (v.agent_code = public.jag_agent_code_me() or public.jag_video_approver()) then return json_build_object('ok', false); end if;
  update public.jag_agent_videos set status = 'removed', updated_at = now() where id = p_id;
  return json_build_object('ok', true, 'path', v.path, 'poster', v.poster);
end $$;

-- edge function jag-agent-profile (sold sync) helpers
create or replace function public.jag_agent_har_ids() returns json
language sql stable security definer set search_path to '' as $$
  select coalesce(json_agg(json_build_object('code', a.code, 'ids', a.har_ids)), '[]'::json)
    from public.jag_agents a where a.active and cardinality(a.har_ids) > 0;
$$;

revoke all on function public.jag_video_approver(), public.jag_agent_profile(text), public.jag_team_public(), public.jag_reel_videos(text, int),
  public.jag_video_view(uuid), public.jag_my_profile_get(text), public.jag_my_profile_save(jsonb, text), public.jag_video_add(jsonb),
  public.jag_video_review(uuid, boolean, text), public.jag_video_remove(uuid), public.jag_agent_har_ids() from public;
grant execute on function public.jag_agent_profile(text), public.jag_team_public(), public.jag_reel_videos(text, int), public.jag_video_view(uuid)
  to anon, authenticated;
grant execute on function public.jag_video_approver(), public.jag_my_profile_get(text), public.jag_my_profile_save(jsonb, text),
  public.jag_video_add(jsonb), public.jag_video_review(uuid, boolean, text), public.jag_video_remove(uuid) to authenticated;
grant execute on function public.jag_agent_har_ids() to service_role;
grant execute on function public.jag_video_url(text), public.jag_video_json(public.jag_agent_videos), public.jag_agent_card(public.jag_agents) to anon, authenticated;

-- starting profiles: the five people on the public team. Titles from Jason (Oct 30 2026); bios are short and factual
-- so each agent can make them their own in the Agent Hub (My profile).
update public.jag_agents set profile_on = true, profile_sort = 1, title_es = 'Líder del equipo', title_en = 'Team Lead',
  har_ids = '{JasonAguir}', license_no = coalesce(license_no, '708694'), licensed_year = coalesce(licensed_year, 2018),
  bio_es = coalesce(bio_es, 'Fundador del Jason Aguirre Group en eXp Realty. Agente con licencia en Texas desde 2018 y Agente ICON de eXp. Ayudo a familias de Houston a comprar su primera casa, incluso con ITIN o con un plan para mejorar su crédito, en español o en inglés.'),
  bio_en = coalesce(bio_en, 'Founder of the Jason Aguirre Group at eXp Realty. Licensed in Texas since 2018 and an eXp ICON Agent. I help Houston families buy their first home, including ITIN buyers and buyers working on their credit, in Spanish or English.')
 where code = 'jason';
update public.jag_agents set profile_on = true, profile_sort = 2, title_es = 'Agente de visitas', title_en = 'Showing Agent', har_ids = '{MonicaMMR}'
 where code = 'monica';
update public.jag_agents set profile_on = true, profile_sort = 3, title_es = 'Especialista en vivienda', title_en = 'Home Specialist', har_ids = '{Katfernan}'
 where code = 'katherine';
update public.jag_agents set profile_on = true, profile_sort = 4, title_es = 'Especialista en vivienda', title_en = 'Home Specialist'
 where code = 'veronica';
update public.jag_agents set profile_on = true, profile_sort = 5, title_es = 'Especialista en vivienda', title_en = 'Home Specialist'
 where code = 'martha';
update public.jag_agents set
  bio_es = coalesce(bio_es, 'Parte del Jason Aguirre Group en eXp Realty. Le ayudo en cada paso para comprar su casa en el área de Houston.'),
  bio_en = coalesce(bio_en, 'Part of the Jason Aguirre Group at eXp Realty. I help you at every step of buying your home in the Houston area.')
 where code in ('monica', 'katherine', 'veronica', 'martha');

-- ============================================================
-- Profile photo (Oct 30 2026): agents can upload their own photo (agent-videos/<code>/photo-*.jpg); otherwise the
-- Follow Up Boss photo is used (Google avatars at 480px instead of 96px). Junk values like "[]" are never shown.
-- jag_agent_card / jag_agent_profile / jag_my_profile_get return jag_agent_photo(a) as photo_url.
-- ============================================================
alter table public.jag_agents add column if not exists profile_photo text;

create or replace function public.jag_agent_photo(a public.jag_agents) returns text
language sql stable set search_path to '' as $$
  select case when a.profile_photo is not null then public.jag_video_url(a.profile_photo)
              when a.photo_url ~ '^https://' then regexp_replace(a.photo_url, '=s\d+-c$', '=s480-c') end;
$$;
grant execute on function public.jag_agent_photo(public.jag_agents) to anon, authenticated;

create or replace function public.jag_agent_card(a public.jag_agents) returns json
language sql stable set search_path to '' as $$
  select json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name, 'photo_url', public.jag_agent_photo(a),
    'title_es', a.title_es, 'title_en', a.title_en);
$$;

create or replace function public.jag_my_profile_photo(p_path text, p_code text default null) returns json
language plpgsql security definer set search_path to '' as $$
declare v_me text := public.jag_agent_code_me(); v_code text;
begin
  if not public.jag_is_team() then return json_build_object('ok', false); end if;
  v_code := case when p_code is not null and public.jag_video_approver() then lower(p_code) else v_me end;
  if p_path is not null and p_path !~ ('^' || v_code || '/photo-[A-Za-z0-9_-]{6,40}\.(jpg|jpeg|png|webp)$') then
    return json_build_object('ok', false, 'reason', 'path');
  end if;
  update public.jag_agents set profile_photo = p_path, updated_at = now() where code = v_code;
  return json_build_object('ok', true, 'url', public.jag_video_url(p_path));
end $$;
revoke all on function public.jag_my_profile_photo(text, text) from public;
grant execute on function public.jag_my_profile_photo(text, text) to authenticated;
-- (jag_agent_profile above was re-created with 'photo_url', public.jag_agent_photo(a) in its agent object)

-- daily sold-homes refresh from HAR
-- select cron.schedule('jag-agent-sold-sync', '41 10 * * *', $c$ select net.http_post(url := '.../functions/v1/jag-agent-profile',
--   headers := jsonb_build_object('Content-Type','application/json','x-jag-token', <vault jag_alerts_token>),
--   body := '{"action":"sync_sold"}'::jsonb, timeout_milliseconds := 150000); $c$);
