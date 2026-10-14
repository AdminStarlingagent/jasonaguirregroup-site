-- JAG active buyer score
-- One 0-100 score per signed-in website client, recomputed every hour at :15.
-- Hot = 70+, active in the last 3 days, not paused by staff, not flagged hot in the last 14 days.
-- Hot clients go into jag_hot_queue for n8n (AI agent text + Follow Up Boss call task).
-- Safe to run more than once.

-- 1. Allow the new activity kinds the home search will log
alter table public.jag_client_activity drop constraint if exists jag_client_activity_kind_check;
alter table public.jag_client_activity add constraint jag_client_activity_kind_check
  check (kind = any (array['view','search','calc','photos','eval','form_open','inquiry','alert_return','value']));

-- 2. Scores (staff can read them from the admin page)
create table if not exists public.jag_client_scores (
  user_id uuid primary key references public.jag_clients(user_id) on delete cascade,
  score int not null default 0,
  prev_score int,
  tags text[] not null default '{}',
  top_zip text,
  best_hour int,
  reasons jsonb not null default '[]'::jsonb,
  homes jsonb not null default '[]'::jsonb,
  last_active_at timestamptz,
  scored_at timestamptz not null default now(),
  last_hot_at timestamptz
);
alter table public.jag_client_scores enable row level security;
drop policy if exists "staff read scores" on public.jag_client_scores;
create policy "staff read scores" on public.jag_client_scores for select to authenticated using (public.jag_is_staff());

-- 3. Hot queue for n8n
create table if not exists public.jag_hot_queue (
  id bigserial primary key,
  user_id uuid not null references public.jag_clients(user_id) on delete cascade,
  score int not null,
  reasons jsonb not null default '[]'::jsonb,
  tags text[] not null default '{}',
  homes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  tries int not null default 0,
  fub_person_id bigint,
  error text
);
alter table public.jag_hot_queue enable row level security;
drop policy if exists "staff read hot queue" on public.jag_hot_queue;
create policy "staff read hot queue" on public.jag_hot_queue for select to authenticated using (public.jag_is_staff());

-- 4. The scoring job
create or replace function public.jag_score_clients()
returns json language plpgsql security definer set search_path = '' as $$
declare v_scored int; v_hot int;
begin
  with a14 as (
    select * from public.jag_client_activity where created_at > now() - interval '14 days'
  ), per as (
    select c.user_id,
      (select count(distinct a.mls) from a14 a where a.user_id = c.user_id and a.kind = 'view') as homes,
      (select max(n) from (select count(*) n from a14 a where a.user_id = c.user_id and a.kind = 'view' group by a.mls) z) as repeat_max,
      (select count(*) from public.jag_client_favorites f where f.user_id = c.user_id and f.saved_at > now() - interval '7 days') as fav7,
      (select count(*) from public.jag_client_favorites f where f.user_id = c.user_id) as fav_all,
      (select count(*) from public.jag_client_searches s where s.user_id = c.user_id) as searches,
      (select count(*) from a14 a where a.user_id = c.user_id and a.kind = 'calc') as calc,
      (select count(*) from a14 a where a.user_id = c.user_id and a.kind = 'photos') as photos,
      (select count(*) from a14 a where a.user_id = c.user_id and a.kind = 'eval') as evals,
      (select count(*) from a14 a where a.user_id = c.user_id and a.kind = 'value') as valu,
      (select count(*) from a14 a where a.user_id = c.user_id and a.kind = 'form_open') as form_open,
      (select count(*) from a14 a where a.user_id = c.user_id and a.kind = 'inquiry') as inquiry,
      (select count(*) from a14 a where a.user_id = c.user_id and a.kind = 'alert_return' and a.created_at > now() - interval '7 days') as alert_ret,
      (select count(*) from a14 a where a.user_id = c.user_id and a.kind = 'search' and a.price is not null) as price_searches,
      (select count(distinct (a.created_at at time zone 'America/Chicago')::date) from a14 a
         where a.user_id = c.user_id and a.created_at > now() - interval '7 days') as days7,
      (select count(*) from a14 a where a.user_id = c.user_id and a.kind = 'view') as views,
      greatest((select max(a.created_at) from public.jag_client_activity a where a.user_id = c.user_id), c.last_seen_at) as last_act,
      (select a.zip from a14 a where a.user_id = c.user_id and a.kind = 'view' and a.zip is not null
         group by a.zip order by count(*) desc limit 1) as top_zip,
      (select count(*) from a14 a where a.user_id = c.user_id and a.kind = 'view'
         and a.zip = (select a2.zip from a14 a2 where a2.user_id = c.user_id and a2.kind = 'view' and a2.zip is not null
                        group by a2.zip order by count(*) desc limit 1)) as top_zip_views,
      (select extract(hour from a.created_at at time zone 'America/Chicago')::int from public.jag_client_activity a
         where a.user_id = c.user_id and a.created_at > now() - interval '30 days'
         group by 1 having count(*) >= 3 order by count(*) desc, 1 limit 1) as best_hour,
      (select coalesce(jsonb_agg(h order by (h->>'views')::int desc), '[]'::jsonb) from (
         select jsonb_build_object('mls', a.mls, 'views', count(*), 'price', max(a.price), 'zip', max(a.zip), 'city', max(a.city)) h
           from a14 a where a.user_id = c.user_id and a.kind = 'view' and a.mls is not null
          group by a.mls order by count(*) desc, max(a.created_at) desc limit 3) hh) as homes_json
    from public.jag_clients c
  ), pts as (
    select p.*,
      array_remove(array[
        case when p.homes > 0 then jsonb_build_object('pts', least(p.homes * 3, 18), 'why', 'Viewed ' || p.homes || case when p.homes = 1 then ' home in 14 days' else ' homes in 14 days' end) end,
        case when p.repeat_max >= 3 then jsonb_build_object('pts', 20, 'why', 'Viewed the same home ' || p.repeat_max || ' times') end,
        case when p.fav7 > 0 then jsonb_build_object('pts', 15, 'why', 'Saved a home this week') end,
        case when p.fav_all > 0 then jsonb_build_object('pts', least(p.fav_all * 2, 10), 'why', p.fav_all || case when p.fav_all = 1 then ' saved home' else ' saved homes' end) end,
        case when p.searches > 0 then jsonb_build_object('pts', least(p.searches * 5, 10), 'why', p.searches || case when p.searches = 1 then ' saved search' else ' saved searches' end) end,
        case when p.calc > 0 then jsonb_build_object('pts', 10, 'why', 'Used the payment calculator') end,
        case when p.photos > 0 then jsonb_build_object('pts', 5, 'why', 'Went through listing photos') end,
        case when p.valu > 0 then jsonb_build_object('pts', 5, 'why', 'Checked a home value estimate') end,
        case when p.evals > 0 then jsonb_build_object('pts', 25, 'why', 'Clicked "see what I qualify for"') end,
        case when p.inquiry > 0 then jsonb_build_object('pts', 30, 'why', 'Sent a showing, contact or offer request') end,
        case when p.inquiry = 0 and p.form_open > 0 then jsonb_build_object('pts', 10, 'why', 'Started a showing request but did not send it') end,
        case when p.alert_ret > 0 then jsonb_build_object('pts', 10, 'why', 'Came back from an alert email') end,
        case when p.days7 > 0 then jsonb_build_object('pts', least(p.days7 * 3, 15), 'why', 'Active ' || p.days7 || case when p.days7 = 1 then ' day this week' else ' days this week' end) end,
        case when p.last_act < now() - interval '14 days' then jsonb_build_object('pts', -30, 'why', 'No visit in 14+ days')
             when p.last_act < now() - interval '7 days' then jsonb_build_object('pts', -15, 'why', 'No visit in 7+ days') end
      ], null) as parts
    from per p
  ), fin as (
    select t.*,
      greatest(0, least(100, coalesce((select sum((x->>'pts')::int) from unnest(t.parts) x), 0)))::int as score,
      array_remove(array[
        case when t.calc >= 2 or t.evals > 0 or t.price_searches >= 2 then 'price' end,
        case when t.views >= 4 and t.top_zip_views::numeric / nullif(t.views, 0) >= 0.6 then 'area' end,
        case when t.inquiry > 0 or t.evals > 0 then 'ready' end
      ], null) as tags
    from pts t
  ), up as (
    insert into public.jag_client_scores as s (user_id, score, prev_score, tags, top_zip, best_hour, reasons, homes, last_active_at, scored_at)
    select f.user_id, f.score, null, f.tags, f.top_zip, f.best_hour, to_jsonb(f.parts), f.homes_json, f.last_act, now() from fin f
    on conflict (user_id) do update set prev_score = s.score, score = excluded.score, tags = excluded.tags, top_zip = excluded.top_zip,
      best_hour = excluded.best_hour, reasons = excluded.reasons, homes = excluded.homes, last_active_at = excluded.last_active_at, scored_at = now()
    returning s.user_id
  ) select count(*) into v_scored from up;

  with hot as (
    update public.jag_client_scores s set last_hot_at = now()
      from public.jag_clients c
     where c.user_id = s.user_id and s.score >= 70 and not coalesce(c.paused_by_staff, false)
       and s.last_active_at > now() - interval '3 days'
       and (s.last_hot_at is null or s.last_hot_at < now() - interval '14 days')
    returning s.user_id, s.score, s.reasons, s.tags, s.homes
  ), ins as (
    insert into public.jag_hot_queue (user_id, score, reasons, tags, homes)
    select user_id, score, reasons, tags, homes from hot returning 1
  ) select count(*) into v_hot from ins;

  return json_build_object('scored', v_scored, 'new_hot', v_hot);
end $$;

-- 5. What n8n acts on. Only releases during Texas solicitation hours
--    (Mon-Sat 9 AM-9 PM, Sun noon-9 PM Central); we stop at 8 PM to leave margin.
create or replace function public.jag_hot_pending(p_limit int default 10)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(x order by x.id), '[]'::json) from (
    select q.id, q.user_id, q.score, q.reasons, q.tags, q.homes, s.top_zip, s.best_hour,
           c.email, c.name, c.phone, c.lang
      from public.jag_hot_queue q
      join public.jag_clients c on c.user_id = q.user_id
      left join public.jag_client_scores s on s.user_id = q.user_id
     where q.sent_at is null and q.tries < 5
       and (case when extract(dow from now() at time zone 'America/Chicago') = 0
                 then extract(hour from now() at time zone 'America/Chicago') between 12 and 19
                 else extract(hour from now() at time zone 'America/Chicago') between 9 and 19 end)
     order by q.id limit greatest(1, least(coalesce(p_limit, 10), 25))) x;
$$;

create or replace function public.jag_hot_mark(p_id bigint, p_ok boolean, p_person bigint default null, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.jag_hot_queue set tries = tries + 1,
    sent_at = case when p_ok then now() else sent_at end,
    fub_person_id = coalesce(p_person, fub_person_id), error = left(p_error, 400)
   where id = p_id;
$$;

revoke all on function public.jag_score_clients() from public, anon, authenticated;
revoke all on function public.jag_hot_pending(int) from public, anon, authenticated;
revoke all on function public.jag_hot_mark(bigint, boolean, bigint, text) from public, anon, authenticated;
grant execute on function public.jag_score_clients() to service_role;
grant execute on function public.jag_hot_pending(int) to service_role;
grant execute on function public.jag_hot_mark(bigint, boolean, bigint, text) to service_role;

-- 6. Run every hour at :15
select cron.unschedule('jag-client-scores') where exists (select 1 from cron.job where jobname = 'jag-client-scores');
select cron.schedule('jag-client-scores', '15 * * * *', 'select public.jag_score_clients()');

-- 7. First run (should return scored = number of website accounts)
select public.jag_score_clients();
