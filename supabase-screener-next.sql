-- ============================================================
-- Screener "Next steps": client website activity for the call screener.
-- jag_screening_client(phone, email): finds the client's website account (last 10 phone digits or email)
-- and returns visits, recently viewed homes, and saved homes. Team sign-ins only.
-- ============================================================
create or replace function public.jag_screening_client(p_phone text default null, p_email text default null)
returns json language plpgsql stable security definer set search_path = '' as $$
declare
  v_ph text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  v_em text := lower(trim(coalesce(p_email, '')));
  c public.jag_clients;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if length(v_ph) < 10 and position('@' in v_em) = 0 then return json_build_object('ok', true, 'found', false); end if;
  select * into c from public.jag_clients x
   where (length(v_ph) = 10 and right(regexp_replace(coalesce(x.phone, ''), '\D', '', 'g'), 10) = v_ph)
      or (position('@' in v_em) > 0 and lower(x.email) = v_em)
   order by x.last_seen_at desc nulls last limit 1;
  if not found then return json_build_object('ok', true, 'found', false); end if;
  return json_build_object('ok', true, 'found', true,
    'client', json_build_object('name', c.name, 'created_at', c.created_at, 'last_seen_at', c.last_seen_at,
      'agent_code', c.agent_code, 'alert_freq', c.alert_freq,
      'agent_name', (select a.name from public.jag_agents a where a.code = c.agent_code)),
    'score', (select json_build_object('score', s.score, 'tags', s.tags, 'top_zip', s.top_zip, 'best_hour', s.best_hour)
                from public.jag_client_scores s where s.user_id = c.user_id),
    'days_7', (select count(distinct (a.created_at at time zone 'America/Chicago')::date) from public.jag_client_activity a
                where a.user_id = c.user_id and a.created_at > now() - interval '7 days'),
    'days_30', (select count(distinct (a.created_at at time zone 'America/Chicago')::date) from public.jag_client_activity a
                where a.user_id = c.user_id and a.created_at > now() - interval '30 days'),
    'views_30', (select count(*) from public.jag_client_activity a where a.user_id = c.user_id and a.kind = 'view'
                and a.created_at > now() - interval '30 days'),
    'searches', (select count(*) from public.jag_client_searches q where q.user_id = c.user_id),
    'viewed', coalesce((select json_agg(v order by v.last_at desc) from (
        select a.mls, max(a.city) as city, max(a.price) as price, max(a.beds) as beds, count(*) as times, max(a.created_at) as last_at
          from public.jag_client_activity a
         where a.user_id = c.user_id and a.kind = 'view' and a.mls is not null
         group by a.mls order by max(a.created_at) desc limit 8) v), '[]'::json),
    'saved', coalesce((select json_agg(f order by f.saved_at desc) from (
        select x.mls, x.saved_at, x.last_price, x.last_status, x.snap->>'addr' as addr, x.snap->>'city' as city,
               x.snap->>'beds' as beds, x.snap->>'photo' as photo
          from public.jag_client_favorites x where x.user_id = c.user_id order by x.saved_at desc limit 8) f), '[]'::json));
end $$;

revoke all on function public.jag_screening_client(text, text) from public, anon;
grant execute on function public.jag_screening_client(text, text) to authenticated;
