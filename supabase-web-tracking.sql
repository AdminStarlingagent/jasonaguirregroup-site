-- ============================================================
-- JAG Funnel Tracking · Step 1 — visitors, channels, events
-- One number to track: website visitor → booked appointment.
--
--  jag_web_visitors : one row per browser (anonymous visitor ID
--                     from jag-track.js), first + last channel,
--                     linked to a client account / lead when known
--  jag_web_events   : page views and key funnel actions
--  jag_leads        : + visitor_id, channel (stamped by jag-capture.js)
--
-- The site never reads these tables. It writes ONLY through
-- jag_track() / jag_track_link(); only staff can read them.
-- Safe to re-run.
-- ============================================================

create table if not exists public.jag_web_visitors (
  visitor_id      text primary key,
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now(),
  first_channel   text,
  first_source    text,
  first_campaign  text,
  first_landing   text,
  first_referrer  text,
  last_channel    text,
  lang            text,
  device          text,
  user_id         uuid,
  is_team         boolean not null default false,
  pageviews       int not null default 0
);
create index if not exists jag_web_visitors_first_seen_idx on public.jag_web_visitors (first_seen);
create index if not exists jag_web_visitors_user_idx on public.jag_web_visitors (user_id) where user_id is not null;

create table if not exists public.jag_web_events (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  visitor_id  text not null,
  session_id  text,
  kind        text not null,
  page        text,
  channel     text,
  mls         text,
  detail      text
);
create index if not exists jag_web_events_visitor_idx on public.jag_web_events (visitor_id, created_at);
create index if not exists jag_web_events_kind_idx on public.jag_web_events (kind, created_at);

alter table public.jag_leads add column if not exists visitor_id text;
alter table public.jag_leads add column if not exists channel text;
create index if not exists jag_leads_visitor_idx on public.jag_leads (visitor_id) where visitor_id is not null;

alter table public.jag_web_visitors enable row level security;
alter table public.jag_web_events   enable row level security;

drop policy if exists "staff read visitors" on public.jag_web_visitors;
create policy "staff read visitors" on public.jag_web_visitors for select to authenticated using (public.jag_is_staff());
drop policy if exists "staff read web events" on public.jag_web_events;
create policy "staff read web events" on public.jag_web_events for select to authenticated using (public.jag_is_staff());

-- ------------------------------------------------------------
-- jag_track(p) — the only way the site writes tracking data.
-- p = { v, s, k, page, ch, src, camp, land, ref, mls, detail, lang, dev }
-- ------------------------------------------------------------
create or replace function public.jag_track(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_vid  text := left(coalesce(p->>'v',''), 64);
  v_kind text := left(coalesce(p->>'k',''), 32);
  v_ch   text := left(nullif(p->>'ch',''), 24);
  v_uid  uuid := auth.uid();
  v_team boolean := false;
begin
  if v_vid !~ '^[A-Za-z0-9-]{8,64}$' then return; end if;
  if v_kind not in ('page_view','home_view','home_save','home_inquiry','home_tour','search',
                    'lead','apply_start','value_start','offer_start','chat_open',
                    'showing_request','signin','book_click','call_click') then return; end if;
  if v_ch is not null and v_ch not in ('tiktok','meta','google_ads','ai_text','email','sms_share',
                                       'organic_search','social','referral','direct','other') then v_ch := 'other'; end if;

  -- flood guard: 120 events per browser per 10 minutes
  if (select count(*) from public.jag_web_events
       where visitor_id = v_vid and created_at > now() - interval '10 minutes') >= 120 then return; end if;

  if v_uid is not null then v_team := coalesce(public.jag_is_team(), false); end if;

  insert into public.jag_web_visitors as w
    (visitor_id, first_channel, first_source, first_campaign, first_landing, first_referrer,
     last_channel, lang, device, user_id, is_team, pageviews)
  values
    (v_vid, coalesce(v_ch,'direct'), left(p->>'src',80), left(p->>'camp',120), left(p->>'land',200), left(p->>'ref',200),
     coalesce(v_ch,'direct'), left(p->>'lang',5), left(p->>'dev',10), v_uid, v_team,
     case when v_kind = 'page_view' then 1 else 0 end)
  on conflict (visitor_id) do update set
     last_seen    = now(),
     last_channel = case when excluded.last_channel <> 'direct' then excluded.last_channel else w.last_channel end,
     lang         = coalesce(excluded.lang, w.lang),
     user_id      = coalesce(w.user_id, excluded.user_id),
     is_team      = w.is_team or excluded.is_team,
     pageviews    = w.pageviews + excluded.pageviews;

  insert into public.jag_web_events (visitor_id, session_id, kind, page, channel, mls, detail)
  values (v_vid, left(p->>'s',40), v_kind, left(p->>'page',200), v_ch,
          case when p->>'mls' ~ '^[A-Za-z0-9-]{3,24}$' then upper(p->>'mls') end,
          left(p->>'detail',120));
end;
$$;
revoke all on function public.jag_track(jsonb) from public;
grant execute on function public.jag_track(jsonb) to anon, authenticated;

-- ------------------------------------------------------------
-- jag_track_link(visitor) — a signed-in browser ties itself to
-- the client account (and flags team members so they're left out).
-- ------------------------------------------------------------
create or replace function public.jag_track_link(p_visitor text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or p_visitor !~ '^[A-Za-z0-9-]{8,64}$' then return; end if;
  update public.jag_web_visitors
     set user_id = coalesce(user_id, auth.uid()),
         is_team = is_team or coalesce(public.jag_is_team(), false)
   where visitor_id = p_visitor;
end;
$$;
revoke all on function public.jag_track_link(text) from public;
grant execute on function public.jag_track_link(text) to authenticated;
revoke execute on function public.jag_track_link(text) from anon;

-- ------------------------------------------------------------
-- jag_funnel(days) — staff-only summary by first channel.
-- "booked" arrives in Step 2 (FUB appointment matching).
-- ------------------------------------------------------------
create or replace function public.jag_funnel(p_days int default 7)
returns table (channel text, visitors bigint, engaged bigint, leads bigint, applications bigint, accounts bigint, showings bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.jag_is_staff() and auth.role() <> 'service_role' then return; end if;
  return query
  with v as (
    select w.visitor_id, w.first_channel, w.user_id
      from public.jag_web_visitors w
     where w.last_seen > now() - make_interval(days => p_days) and not w.is_team
  ), e as (
    select ev.visitor_id, ev.kind from public.jag_web_events ev
     where ev.created_at > now() - make_interval(days => p_days)
  ), l as (
    select ld.visitor_id, ld.type from public.jag_leads ld
     where ld.created_at > now() - make_interval(days => p_days) and ld.visitor_id is not null
  )
  select coalesce(v.first_channel,'direct'),
         count(distinct v.visitor_id),
         count(distinct v.visitor_id) filter (where exists (select 1 from e where e.visitor_id = v.visitor_id and e.kind <> 'page_view')),
         count(distinct v.visitor_id) filter (where exists (select 1 from l where l.visitor_id = v.visitor_id)),
         count(distinct v.visitor_id) filter (where exists (select 1 from l where l.visitor_id = v.visitor_id and l.type = 'Mortgage Application')),
         count(distinct v.visitor_id) filter (where v.user_id is not null),
         count(distinct v.visitor_id) filter (where exists (select 1 from e where e.visitor_id = v.visitor_id and e.kind = 'showing_request'))
    from v
   group by 1
   order by 2 desc;
end;
$$;
revoke all on function public.jag_funnel(int) from public;
grant execute on function public.jag_funnel(int) to authenticated, service_role;
revoke execute on function public.jag_funnel(int) from anon;
