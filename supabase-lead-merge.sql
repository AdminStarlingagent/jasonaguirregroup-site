-- ============================================================
-- One client, one row: merge a call screening into the client's Home Loan application.
--   jag_merge_leads(keep, drop)        team (admin "Merge" button) or service role. Keeps the application row,
--                                      copies the screening details onto it, links the screening, and marks the
--                                      other row status 'Merged' (hidden in the admin; nothing is deleted).
--   jag_attach_screening_to_app(id)    service role (jag-screening-fub): when a client filled the app BEFORE the
--                                      screening was sent, link the screening to that app instead of adding a
--                                      second "Screened" row. Returns the app lead id, or null when there is none.
-- ============================================================

create or replace function public.jag_merge_leads(p_keep uuid, p_drop uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare k public.jag_leads; d public.jag_leads; v_sid uuid; s public.jag_screenings; v_extra jsonb;
begin
  if not (coalesce(auth.role(), '') = 'service_role' or coalesce(public.jag_is_team(), false)) then
    return json_build_object('ok', false, 'reason', 'not_team');
  end if;
  if p_keep = p_drop then return json_build_object('ok', false, 'reason', 'same'); end if;
  select * into k from public.jag_leads where id = p_keep;
  select * into d from public.jag_leads where id = p_drop;
  if k.id is null or d.id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if d.status = 'Merged' then return json_build_object('ok', false, 'reason', 'already_merged'); end if;

  -- the screening behind either row
  v_sid := coalesce(nullif(d.payload->>'Screening ID', ''), nullif(k.payload->>'Screening ID', ''))::uuid;
  if v_sid is not null then select * into s from public.jag_screenings where id = v_sid; end if;

  v_extra := jsonb_strip_nulls(jsonb_build_object(
    'Screening ID', s.id::text,
    'Screening', case when s.id is not null then 'https://jasonaguirregroup.company/screener.html#s=' || s.id end,
    'Screened By', nullif(s.screener, ''),
    'Screening Readiness', case when s.score is not null then s.score || '%' end,
    'Follow Up Boss', coalesce(nullif(k.payload->>'Follow Up Boss', ''), nullif(d.payload->>'Follow Up Boss', ''),
      case when s.fub_person_id is not null then 'https://jasonhoustonrealty.followupboss.com/2/people/view/' || s.fub_person_id end),
    'Also known as', case when lower(trim(coalesce(d.name, ''))) <> lower(trim(coalesce(k.name, ''))) and coalesce(trim(d.name), '') <> '' then d.name end,
    'Merged from', d.type || ' · ' || to_char(d.created_at at time zone 'America/Chicago', 'Mon DD HH12:MI AM')));

  update public.jag_leads
     set payload = coalesce(payload, '{}'::jsonb) || v_extra,
         email = coalesce(nullif(email, ''), d.email),
         phone = coalesce(nullif(phone, ''), d.phone),
         est_amount = coalesce(est_amount, d.est_amount),
         notes = case when coalesce(d.notes, '') <> '' then trim(both e'\n' from coalesce(notes, '') || e'\n' || d.notes) else notes end
   where id = k.id;
  update public.jag_leads
     set status = 'Merged', payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('Merged into', k.id::text)
   where id = d.id;
  if s.id is not null and k.type = 'Mortgage Application' then
    update public.jag_screenings set app_lead_id = k.id, app_at = coalesce(app_at, k.created_at) where id = s.id;
  end if;
  return json_build_object('ok', true, 'keep', k.id, 'dropped', d.id, 'screening', s.id, 'fub_person_id', s.fub_person_id,
    'keep_name', k.name, 'drop_name', d.name, 'keep_email', coalesce(nullif(k.email, ''), d.email), 'keep_phone', coalesce(nullif(k.phone, ''), d.phone),
    'keep_payload', (select payload from public.jag_leads where id = k.id));
end $$;

create or replace function public.jag_attach_screening_to_app(p_screening uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.jag_screenings; a public.jag_leads; v_phone text; v_email text;
begin
  select * into s from public.jag_screenings where id = p_screening;
  if s.id is null then return null; end if;
  if s.app_lead_id is not null then return s.app_lead_id; end if;
  v_phone := right(regexp_replace(coalesce(s.phone, ''), '\D', '', 'g'), 10);
  v_email := lower(trim(coalesce(s.email, '')));
  select * into a from public.jag_leads l
   where l.type = 'Mortgage Application' and coalesce(l.status, '') <> 'Merged' and l.created_at > now() - interval '30 days'
     and ((length(v_phone) = 10 and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = v_phone)
       or (v_email like '%@%' and lower(trim(coalesce(l.email, ''))) = v_email))
   order by l.created_at desc limit 1;
  if a.id is null then return null; end if;
  update public.jag_screenings set app_lead_id = a.id, app_at = a.created_at where id = s.id;
  update public.jag_leads set
    payload = coalesce(payload, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'Screening ID', s.id::text,
      'Screening', 'https://jasonaguirregroup.company/screener.html#s=' || s.id,
      'Screened By', nullif(s.screener, ''),
      'Screening Readiness', case when s.score is not null then s.score || '%' end,
      'Follow Up Boss', case when s.fub_person_id is not null then 'https://jasonhoustonrealty.followupboss.com/2/people/view/' || s.fub_person_id end,
      'Also known as', case when lower(trim(coalesce(s.client_name, ''))) <> lower(trim(coalesce(a.name, ''))) and coalesce(trim(s.client_name), '') <> '' then s.client_name end)),
    est_amount = coalesce(est_amount, s.est_max)
   where id = a.id;
  return a.id;
end $$;

revoke all on function public.jag_merge_leads(uuid, uuid) from public, anon;
grant execute on function public.jag_merge_leads(uuid, uuid) to authenticated, service_role;
revoke all on function public.jag_attach_screening_to_app(uuid) from public, anon, authenticated;
grant execute on function public.jag_attach_screening_to_app(uuid) to service_role;
