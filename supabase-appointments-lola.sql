-- ============================================================
-- Appointments: Lola's reminders and nudges (run by edge fn jag-appointments after every sync, ~every 10 min)
--   1. Client reminder by TEXT, ~a day before (or the same day if booked late) — only clients who agreed to texts
--      (ops.client_text checks consent + STOP list + texting hours). Email reminders are sent by the edge function.
--      Starling CRM bookings are skipped: Starling sends its own confirmations.
--   2. No outcome 2 hours after the appointment ended → Lola texts the owner once, with what she sees since.
--   3. Once a day (9 AM+): Jason gets one text with appointments from the last 7 days that nobody followed up on.
-- Links go to the Agent Hub Appointments tab (workspace#hub=%23appts).
-- ============================================================
create or replace function public.jag_phone_fmt(p text)
returns text language sql immutable set search_path to '' as $$
  select case when length(d) = 10 then '(' || substr(d, 1, 3) || ') ' || substr(d, 4, 3) || '-' || substr(d, 7) else nullif(p, '') end
    from (select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10) as d) x;
$$;

-- Lola's read for every client with an appointment in the window, refreshed every 30 min (stored in jag_appointments.lola)
create or replace function public.jag_appts_stage_refresh()
returns int language plpgsql security definer set search_path to '' as $$
declare v_n int;
begin
  with ks as (select distinct k.id, k.fub_id from public.jag_appointments a join public.jag_contacts k on k.fub_id = a.fub_person_id and not k.deleted
               where not a.deleted and a.start_at > now() - interval '61 days' and (a.lola_at is null or a.lola_at < now() - interval '30 minutes')),
       st as (select fub_id, public.jag_lola_stage(id)::jsonb as l from ks)
  update public.jag_appointments a set lola = st.l, lola_at = now() from st where a.fub_person_id = st.fub_id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.jag_appts_stage_refresh() from public, anon, authenticated;
grant execute on function public.jag_appts_stage_refresh() to service_role;

-- the list for automations (no login): same rows as jag_appts_list
create or replace function public.jag_appts_list_service(p_days int default 60)
returns json language sql stable security definer set search_path to '' as $$
  select json_build_object('ok', true, 'rows', coalesce((select json_agg(public.jag_appt_row(a) order by a.start_at desc) from public.jag_appointments a
    where not a.deleted and a.start_at > now() - make_interval(days => p_days) and a.start_at < now() + interval '45 days'), '[]'::json));
$$;
revoke all on function public.jag_appts_list_service(int) from public, anon, authenticated;
grant execute on function public.jag_appts_list_service(int) to service_role;

create or replace function public.jag_appts_tick()
returns json language plpgsql security definer set search_path to '' as $$
declare a record; g record; m record; v_tz text := 'America/Chicago'; v_local timestamp; v_today date; v_body text; v_when text;
        v_txt int := 0; v_nudge int := 0; v_dig int := 0; v_n int; v_hot int; v_kv jsonb; v_link text := 'https://jasonaguirregroup.company/workspace#hub=%23appts';
        v_hour int := extract(hour from now() at time zone 'America/Chicago');
begin
  v_today := (now() at time zone v_tz)::date;
  perform public.jag_appts_stage_refresh();   -- Lola's read of each client (stored for a fast list)

  -- 1. client text reminders
  for a in select ap.id, ap.start_at, ap.owner_user_id, ap.location, k.user_id, coalesce(k.first_name, split_part(k.name, ' ', 1)) as first, k.lang
             from public.jag_appointments ap join public.jag_contacts k on k.fub_id = ap.fub_person_id and not k.deleted
            where not ap.deleted and not ap.all_day and k.user_id is not null
              and ap.start_at between now() + interval '90 minutes' and now() + interval '26 hours'
              and ap.client_reminded->>'text' is null and coalesce(ap.title, '') !~* '^starling'
  loop
    select gg.first_name, coalesce(gg.phone_override, gg.phone) as phone into g from public.jag_agents gg where gg.fub_user_id = a.owner_user_id and gg.active limit 1;
    v_local := a.start_at at time zone v_tz;
    v_when := case when v_local::date = v_today then (case when coalesce(a.lang, 'es') = 'en' then 'today' else 'hoy' end)
                   else (case when coalesce(a.lang, 'es') = 'en' then 'tomorrow' else 'mañana' end) end;
    v_body := case when coalesce(a.lang, 'es') = 'en' then
        'Hi ' || coalesce(a.first, '') || '! Reminder from Jason Aguirre Group: your appointment' || coalesce(' with ' || g.first_name, '') || ' is ' || v_when || ' at ' || to_char(v_local, 'FMHH12:MI AM') || '.'
        || coalesce(' Need to change it? Call or text ' || g.first_name || ' at ' || public.jag_phone_fmt(g.phone) || '.', '')
      else
        '¡Hola ' || coalesce(a.first, '') || '! Le recuerda Jason Aguirre Group: su cita' || coalesce(' con ' || g.first_name, '') || ' es ' || v_when || ' a las ' || to_char(v_local, 'FMHH12:MI AM') || '.'
        || coalesce(' ¿Necesita cambiarla? Llame o mande texto a ' || g.first_name || ' al ' || public.jag_phone_fmt(g.phone) || '.', '') end;
    if ops.client_text(a.user_id, v_body, 'appt_remind', a.id) is not null then v_txt := v_txt + 1; end if;
    update public.jag_appointments set client_reminded = client_reminded || jsonb_build_object('text', now()) where id = a.id;
  end loop;

  -- 2. no outcome 2 h after it ended: ask the owner once (9 AM - 7 PM)
  if v_hour between 9 and 18 then
    for a in select ap.*, coalesce(k.first_name, split_part(coalesce(k.name, ap.person_name), ' ', 1)) as first, left(coalesce(k.last_name, ''), 1) as li
               from public.jag_appointments ap left join public.jag_contacts k on k.fub_id = ap.fub_person_id and not k.deleted
              where not ap.deleted and not ap.all_day and ap.outcome is null and ap.nudged->>'outcome' is null
                and coalesce(ap.end_at, ap.start_at + interval '1 hour') < now() - interval '2 hours'
                and ap.start_at > now() - interval '3 days'
    loop
      select t.id, split_part(t.name, ' ', 1) as first into m from ops.team t where t.fub_user_id = a.owner_user_id and t.active and t.mobile_e164 is not null limit 1;
      if m.id is not null then
        v_local := a.start_at at time zone v_tz;
        v_body := 'Lola here 👀 ' || m.first || ', how did ' || coalesce(a.first, 'your client') || coalesce(' ' || nullif(a.li, '') || '.', '') || '''s '
          || case when v_local::date = v_today then 'appointment today at ' else 'appointment ' || to_char(v_local, 'Dy') || ' at ' end || to_char(v_local, 'FMHH12:MI AM') || ' go? '
          || case when a.follow->>'last_at' is not null then 'I see a ' || coalesce(a.follow->>'last_kind', 'touch') || ' after it, nice. '
                  when (a.follow->'attend'->>'min') is not null then 'I see a ' || (a.follow->'attend'->>'min') || '-min call at that time. '
                  else 'I don''t see a call or text since. ' end
          || 'Log it (showed / no-show + a note), it updates FUB too: ' || v_link;
        perform ops.lola_text(m.id, v_body, 'appt_outcome', a.id);
        v_nudge := v_nudge + 1;
      end if;
      update public.jag_appointments set nudged = nudged || jsonb_build_object('outcome', now()) where id = a.id;
    end loop;
  end if;

  -- 3. once a day: Jason's list of appointments nobody followed up on (last 7 days)
  select v into v_kv from public.jag_kv where k = 'appt_digest';
  if v_hour >= 9 and v_hour < 18 and coalesce(v_kv->>'day', '') <> v_today::text then
    select count(*), count(*) filter (where coalesce((ap.lola->>'hot')::boolean, false))
      into v_n, v_hot
      from public.jag_appointments ap
     where not ap.deleted and not ap.all_day and ap.outcome is null and ap.follow->>'last_at' is null
       and ap.start_at between now() - interval '7 days' and now() - interval '24 hours';
    if v_n > 0 then
      select t.id into m from ops.team t where t.active and t.role = 'lead' and t.mobile_e164 is not null order by t.id limit 1;
      if m.id is not null then
        perform ops.lola_text(m.id, 'Lola''s appointment check ☕ ' || v_n || ' appointment' || case when v_n = 1 then '' else 's' end
          || ' from the last 7 days with no follow-up and no outcome' || case when v_hot > 0 then ' (' || v_hot || ' hot client' || case when v_hot = 1 then '' else 's' end || ')' else '' end
          || '. See who: ' || v_link, 'appt_digest', null);
        v_dig := 1;
      end if;
    end if;
    insert into public.jag_kv (k, v) values ('appt_digest', jsonb_build_object('day', v_today::text, 'n', coalesce(v_n, 0)))
    on conflict (k) do update set v = excluded.v;
  end if;

  return json_build_object('client_texts', v_txt, 'nudges', v_nudge, 'digest', v_dig);
end $$;

-- clients who get the reminder EMAIL now (the edge function sends it, then marks client_reminded.email)
create or replace function public.jag_appts_email_due()
returns json language sql stable security definer set search_path to '' as $$
  select coalesce(json_agg(x), '[]'::json) from (
    select ap.id, ap.start_at, ap.location, ap.type, coalesce(k.first_name, split_part(k.name, ' ', 1)) as first, lower(k.email) as email,
           coalesce(k.lang, 'es') as lang,
           (select json_build_object('first', g.first_name, 'name', g.name, 'phone', coalesce(g.phone_override, g.phone), 'photo_url', g.photo_url)
              from public.jag_agents g where g.fub_user_id = ap.owner_user_id and g.active limit 1) as agent
      from public.jag_appointments ap join public.jag_contacts k on k.fub_id = ap.fub_person_id and not k.deleted
     where not ap.deleted and not ap.all_day and k.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       and ap.start_at between now() + interval '90 minutes' and now() + interval '26 hours'
       and ap.client_reminded->>'email' is null and coalesce(ap.title, '') !~* '^starling'
       and not exists (select 1 from public.jag_email_suppress s where s.email = lower(k.email))
     limit 40) x;
$$;

-- helpers for the edge function (the ops schema isn't exposed to the API)
create or replace function public.jag_appts_ops_owners(p_ids bigint[])
returns json language sql stable security definer set search_path to '' as $$
  select coalesce(json_agg(json_build_object('id', o.appointment_id, 'assigned', o.assigned_user_id)), '[]'::json)
    from ops.appointments o where o.appointment_id = any(coalesce(p_ids, '{}'));
$$;
create or replace function public.jag_appts_team_fub()
returns json language sql stable security definer set search_path to '' as $$
  select coalesce(json_agg(t.fub_user_id order by t.id), '[]'::json) from ops.team t where t.active and t.fub_user_id is not null;
$$;
create or replace function public.jag_appts_check_done(p_fub_id bigint)
returns void language sql security definer set search_path to '' as $$
  update ops.checks set status = 'satisfied', satisfied_by = 'outcome logged in hub', satisfied_at = now(), next_action_at = null, updated_at = now()
   where appointment_id = p_fub_id and status in ('pending', 'alerting');
$$;

revoke all on function public.jag_appts_tick(), public.jag_appts_email_due(), public.jag_appts_ops_owners(bigint[]), public.jag_appts_team_fub(), public.jag_appts_check_done(bigint) from public, anon, authenticated;
grant execute on function public.jag_appts_tick(), public.jag_appts_email_due(), public.jag_appts_ops_owners(bigint[]), public.jag_appts_team_fub(), public.jag_appts_check_done(bigint) to service_role;
