-- =====================================================================
-- JAG Ops · Phase 1: Speed-to-Lead & Appointment Watchdog  (schema "ops")
-- ALREADY APPLIED to jag-crm on 2026-10-10 as three migrations:
--   ops_phase1_tables, ops_phase1_logic, ops_phase1_wait_text
-- Kept here as the record. Do NOT re-run on the live project (the team
-- seed would insert a second copy). Use it only to rebuild from scratch.
--
-- Nothing secret lives in this file. Phone numbers, FUB user IDs, API keys
-- and the watchdog secret are entered in Supabase / n8n, never here.
-- The system ships switched OFF: ops.settings.enabled = false.
--
-- Next step for Jason: run supabase-ops-timer.sql (separate file).
-- Self-check queries are at the bottom of this file.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Migration: ops_phase1_tables
-- Tables, settings defaults, team roster (no phones / FUB IDs yet)
-- ---------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

create schema if not exists ops;
revoke all on schema ops from public, anon, authenticated;

-- every tunable number lives here, editable without code
create table if not exists ops.settings (
  key text primary key,
  value jsonb not null,
  note text,
  updated_at timestamptz not null default now()
);

create table if not exists ops.team (
  id serial primary key,
  name text not null,
  fub_user_id bigint unique,
  role text not null check (role in ('lead','backup','isa','showing','tc','other')),
  mobile_e164 text check (mobile_e164 is null or mobile_e164 ~ '^\+1[0-9]{10}$'),
  language text not null default 'es',
  first_ping_for_own boolean not null default false,
  is_default_first_ping boolean not null default false,
  escalation_level int check (escalation_level in (1,2)),
  active boolean not null default true
);

create table if not exists ops.fub_events (
  event_id text primary key,
  event text not null,
  resource_ids jsonb,
  uri text,
  payload jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  result text
);

create table if not exists ops.checks (
  id bigint generated always as identity primary key,
  check_type text not null check (check_type in ('first_call','appt_call')),
  dedupe_key text not null unique,
  person_id bigint not null,
  person_label text,
  appointment_id bigint,
  appointment_start timestamptz,
  first_ping_member_id int references ops.team(id),
  window_start timestamptz not null,
  due_at timestamptz not null,
  next_action_at timestamptz,
  escalation_level int not null default -1,
  status text not null default 'pending' check (status in ('pending','alerting','escalated','satisfied','cancelled','expired')),
  satisfied_at timestamptz,
  satisfied_by text,
  done_token text not null unique default encode(extensions.gen_random_bytes(16),'hex'),
  claimed_at timestamptz,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists checks_due_idx on ops.checks (status, next_action_at);
create index if not exists checks_open_person_idx on ops.checks (person_id) where status in ('pending','alerting','escalated');
create index if not exists checks_appt_idx on ops.checks (appointment_id) where appointment_id is not null;

create table if not exists ops.alerts (
  id bigint generated always as identity primary key,
  check_id bigint references ops.checks(id),
  kind text not null default 'check' check (kind in ('check','overflow')),
  member_id int references ops.team(id),
  level int,
  channel text not null check (channel in ('sms','fub_task')),
  body text,
  status text not null default 'pending' check (status in ('pending','sent','failed','capped','skipped')),
  provider_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists alerts_member_idx on ops.alerts (member_id, created_at desc);

alter table ops.settings enable row level security;
alter table ops.team enable row level security;
alter table ops.fub_events enable row level security;
alter table ops.checks enable row level security;
alter table ops.alerts enable row level security;
revoke all on all tables in schema ops from public, anon, authenticated;

insert into ops.settings (key, value, note) values
 ('enabled',                    'false'::jsonb, 'Master switch. Nothing is alerted while false.'),
 ('tz',                         '"America/Chicago"'::jsonb, 'Time zone for business hours'),
 ('business_start',             '"09:00"'::jsonb, 'Start of business hours (local)'),
 ('business_end',               '"20:00"'::jsonb, 'End of business hours (local)'),
 ('business_days',              '[0,1,2,3,4,5,6]'::jsonb, 'Days alerts may go out, 0=Sunday'),
 ('first_call_minutes',         '10'::jsonb, 'New lead: first call due this many minutes after it arrives'),
 ('appt_check_after_minutes',   '10'::jsonb, 'Appointment: check this many minutes after start'),
 ('appt_window_before_minutes', '5'::jsonb, 'Appointment: a call this many minutes before start counts'),
 ('escalate_backup_minutes',    '15'::jsonb, 'Minutes after due time that the backup (Kat) is pinged'),
 ('escalate_lead_minutes',      '30'::jsonb, 'Minutes after due time that Jason is pinged'),
 ('overflow_age_hours',         '24'::jsonb, 'A lead untouched this long counts toward overflow'),
 ('overflow_threshold',         '10'::jsonb, 'Alert Jason when more than this many leads are untouched'),
 ('max_pings_per_hour',         '6'::jsonb, 'Real-time texts per person per hour; extras are held for the digest'),
 ('create_fub_tasks',           'true'::jsonb, 'Create a FUB task for the first person pinged (approved write)'),
 ('lead_max_age_hours',         '6'::jsonb, 'Ignore peopleCreated events for people created longer ago than this'),
 ('exclude_sources',            '["Import"]'::jsonb, 'FUB lead sources that never get a first-call check'),
 ('exclude_stages',             '["Past Client","Sphere","Trash","Closed"]'::jsonb, 'FUB stages that never get a first-call check'),
 ('exclude_tags',               '[]'::jsonb, 'FUB tags that never get a first-call check'),
 ('exclude_call_user_ids',      '[]'::jsonb, 'FUB user IDs whose calls do NOT count (e.g. an AI caller)'),
 ('fub_person_url',             '"https://app.followupboss.com/2/people/view/"'::jsonb, 'Deep link prefix to a FUB person (set your subdomain)'),
 ('done_url',                   '"https://jasonaguirregroup.company/done.html?t="'::jsonb, 'One-tap Done page'),
 ('watchdog_url',               '""'::jsonb, 'n8n Watchdog webhook URL (set after the workflow is published)')
on conflict (key) do nothing;

insert into ops.team (name, role, language, first_ping_for_own, is_default_first_ping, escalation_level) values
 ('Jason Aguirre',       'lead',    'es', false, false, 2),
 ('Katherine Fernandez', 'backup',  'es', true,  false, 1),
 ('Veronica Valdez',     'isa',     'es', false, true,  null),
 ('Mónica Martínez',     'showing', 'es', true,  false, null)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Migration: ops_phase1_logic
-- Webhook handlers, escalation logic, Done link, Deals tab reader
-- ---------------------------------------------------------------------
-- ---------- settings helpers ----------
create or replace function ops.s(p_key text) returns jsonb language sql stable set search_path = '' as $$
  select value from ops.settings where key = p_key $$;
create or replace function ops.s_text(p_key text) returns text language sql stable set search_path = '' as $$
  select value #>> '{}' from ops.settings where key = p_key $$;
create or replace function ops.s_int(p_key text) returns int language sql stable set search_path = '' as $$
  select (value #>> '{}')::int from ops.settings where key = p_key $$;
create or replace function ops.s_bool(p_key text) returns boolean language sql stable set search_path = '' as $$
  select coalesce((select (value #>> '{}')::boolean from ops.settings where key = p_key), false) $$;

-- next moment inside business hours (returns p_ts itself if already inside)
create or replace function ops.next_business_time(p_ts timestamptz) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_tz text := ops.s_text('tz');
  v_st time := ops.s_text('business_start')::time;
  v_en time := ops.s_text('business_end')::time;
  v_days jsonb := ops.s('business_days');
  v_local timestamp := p_ts at time zone v_tz;
  v_d date;
  i int;
begin
  for i in 0..8 loop
    v_d := v_local::date + i;
    if v_days @> to_jsonb(extract(dow from v_d)::int) then
      if i = 0 then
        if v_local::time < v_st then return (v_d + v_st) at time zone v_tz; end if;
        if v_local::time < v_en then return p_ts; end if;
      else
        return (v_d + v_st) at time zone v_tz;
      end if;
    end if;
  end loop;
  return p_ts;
end $$;

create or replace function ops.person_label(p jsonb) returns text language sql immutable set search_path = '' as $$
  select coalesce(initcap(nullif(trim(p->>'firstName'),'')), 'Lead') ||
         case when coalesce(trim(p->>'lastName'),'') <> '' then ' ' || upper(left(trim(p->>'lastName'),1)) || '.' else '' end $$;

create or replace function ops.label_from_name(p_name text) returns text language sql immutable set search_path = '' as $$
  select case when coalesce(trim(p_name),'') = '' then 'Lead'
              when position(' ' in trim(p_name)) = 0 then initcap(trim(p_name))
              else initcap(split_part(trim(p_name),' ',1)) || ' ' || upper(left(regexp_replace(trim(p_name), '^.*\s', ''),1)) || '.' end $$;

create or replace function ops.as_array(p jsonb, p_key text) returns jsonb language sql immutable set search_path = '' as $$
  select case when p is null then '[]'::jsonb
              when jsonb_typeof(p) = 'object' and p ? p_key then coalesce(p->p_key, '[]'::jsonb)
              when jsonb_typeof(p) = 'array' then p
              else jsonb_build_array(p) end $$;

-- does a call by this FUB user count as "the team called"?
create or replace function ops.is_team_user(p_user_id bigint) returns boolean language sql stable set search_path = '' as $$
  select case
    when p_user_id is null then false
    when ops.s('exclude_call_user_ids') @> to_jsonb(p_user_id) then false
    when exists (select 1 from ops.team where fub_user_id is not null and active)
      then exists (select 1 from ops.team where fub_user_id = p_user_id and active)
    else true end $$;

-- who gets the first ping: the assigned agent if they take their own, else the ISA, else Jason
create or replace function ops.first_ping_member(p_user_id bigint) returns int language sql stable set search_path = '' as $$
  select coalesce(
    (select id from ops.team where active and first_ping_for_own and fub_user_id = p_user_id limit 1),
    (select id from ops.team where active and is_default_first_ping order by id limit 1),
    (select id from ops.team where active and escalation_level = 2 order by id limit 1)) $$;

-- ---------- intake ----------
create or replace function public.ops_ingest_event(p_event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id text := coalesce(nullif(p_event->>'eventId',''), md5(p_event::text));
begin
  insert into ops.fub_events (event_id, event, resource_ids, uri, payload)
  values (v_id, coalesce(p_event->>'event','unknown'), p_event->'resourceIds', p_event->>'uri', p_event)
  on conflict (event_id) do nothing;
  return jsonb_build_object('new', found, 'event_id', v_id, 'event', p_event->>'event',
                            'uri', p_event->>'uri', 'resource_ids', p_event->'resourceIds');
end $$;

create or replace function public.ops_handle_people(p_payload jsonb, p_event_id text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; v_created timestamptz; v_due timestamptz; v_new int := 0; v_skip int := 0;
begin
  for r in select value from jsonb_array_elements(ops.as_array(p_payload, 'people')) loop
    if nullif(r->>'id','') is null then continue; end if;
    v_created := coalesce(nullif(r->>'created','')::timestamptz, now());
    if v_created < now() - make_interval(hours => ops.s_int('lead_max_age_hours'))
       or ops.s('exclude_stages')  @> to_jsonb(coalesce(r->>'stage',''))
       or ops.s('exclude_sources') @> to_jsonb(coalesce(r->>'source',''))
       or exists (select 1 from jsonb_array_elements_text(coalesce(r->'tags','[]'::jsonb)) t
                  where ops.s('exclude_tags') @> to_jsonb(t.value)) then
      v_skip := v_skip + 1; continue;
    end if;
    v_due := ops.next_business_time(v_created + make_interval(mins => ops.s_int('first_call_minutes')));
    insert into ops.checks (check_type, dedupe_key, person_id, person_label, first_ping_member_id, window_start, due_at, next_action_at)
    values ('first_call', 'first_call:' || (r->>'id'), (r->>'id')::bigint, ops.person_label(r),
            ops.first_ping_member(nullif(r->>'assignedUserId','')::bigint),
            v_created - interval '1 minute', v_due, v_due)
    on conflict (dedupe_key) do nothing;
    if found then v_new := v_new + 1; end if;
  end loop;
  if p_event_id is not null then
    update ops.fub_events set processed_at = now(), result = format('people: %s new checks, %s skipped', v_new, v_skip) where event_id = p_event_id;
  end if;
  return jsonb_build_object('created', v_new, 'skipped', v_skip);
end $$;

create or replace function public.ops_handle_appointments(p_payload jsonb, p_event_id text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a jsonb; inv jsonb; v_start timestamptz; v_appt bigint; v_agent bigint; v_person bigint; v_due timestamptz;
        v_new int := 0; v_cancel int := 0; v_n int;
begin
  for a in select value from jsonb_array_elements(ops.as_array(p_payload, 'appointments')) loop
    v_appt := nullif(a->>'id','')::bigint;
    v_start := nullif(a->>'start','')::timestamptz;
    if v_appt is null or v_start is null or coalesce((a->>'allDay')::boolean, false) then continue; end if;
    -- appointment moved: retire open checks tied to the old time
    update ops.checks set status = 'cancelled', satisfied_by = 'rescheduled', next_action_at = null, updated_at = now()
     where appointment_id = v_appt and status in ('pending','alerting') and appointment_start is distinct from v_start;
    get diagnostics v_n = row_count; v_cancel := v_cancel + v_n;
    if v_start < now() - interval '1 hour' then continue; end if;
    v_agent := null;
    select nullif(x->>'userId','')::bigint into v_agent
      from jsonb_array_elements(coalesce(a->'invitees','[]'::jsonb)) x
     where nullif(x->>'userId','') is not null limit 1;
    for inv in select value from jsonb_array_elements(coalesce(a->'invitees','[]'::jsonb)) loop
      v_person := nullif(inv->>'personId','')::bigint;
      if v_person is null then continue; end if;
      v_due := v_start + make_interval(mins => ops.s_int('appt_check_after_minutes'));
      insert into ops.checks (check_type, dedupe_key, person_id, person_label, appointment_id, appointment_start,
                              first_ping_member_id, window_start, due_at, next_action_at)
      values ('appt_call', 'appt_call:' || v_appt || ':' || v_person || ':' || extract(epoch from v_start)::bigint,
              v_person, ops.label_from_name(inv->>'name'), v_appt, v_start, ops.first_ping_member(v_agent),
              v_start - make_interval(mins => ops.s_int('appt_window_before_minutes')), v_due, v_due)
      on conflict (dedupe_key) do nothing;
      if found then v_new := v_new + 1; end if;
    end loop;
  end loop;
  if p_event_id is not null then
    update ops.fub_events set processed_at = now(), result = format('appointments: %s new checks, %s retired', v_new, v_cancel) where event_id = p_event_id;
  end if;
  return jsonb_build_object('created', v_new, 'cancelled', v_cancel);
end $$;

create or replace function public.ops_handle_appointments_deleted(p_ids jsonb, p_event_id text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  update ops.checks set status = 'cancelled', satisfied_by = 'appointment deleted', next_action_at = null, updated_at = now()
   where status in ('pending','alerting')
     and appointment_id in (select (t.value)::bigint from jsonb_array_elements_text(coalesce(p_ids,'[]'::jsonb)) t);
  get diagnostics v_n = row_count;
  if p_event_id is not null then
    update ops.fub_events set processed_at = now(), result = format('appointments deleted: %s checks cancelled', v_n) where event_id = p_event_id;
  end if;
  return jsonb_build_object('cancelled', v_n);
end $$;

create or replace function public.ops_handle_calls(p_payload jsonb, p_event_id text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c jsonb; v_n int; v_total int := 0;
begin
  for c in select value from jsonb_array_elements(ops.as_array(p_payload, 'calls')) loop
    if not ops.is_team_user(nullif(c->>'userId','')::bigint) or nullif(c->>'personId','') is null then continue; end if;
    update ops.checks
       set status = 'satisfied', satisfied_at = now(), satisfied_by = 'call:' || (c->>'userId'),
           next_action_at = null, claimed_at = null, updated_at = now()
     where person_id = (c->>'personId')::bigint
       and status in ('pending','alerting','escalated')
       and window_start <= coalesce(nullif(c->>'created','')::timestamptz, now());
    get diagnostics v_n = row_count; v_total := v_total + v_n;
  end loop;
  if p_event_id is not null then
    update ops.fub_events set processed_at = now(), result = format('calls: %s checks satisfied', v_total) where event_id = p_event_id;
  end if;
  return jsonb_build_object('satisfied', v_total);
end $$;

-- ---------- watchdog ----------
create or replace function ops.overflow_due() returns boolean language sql stable set search_path = '' as $$
  select ops.next_business_time(now()) = now()
     and (select count(*) from ops.checks
           where check_type = 'first_call' and not is_test and status in ('pending','alerting','escalated')
             and created_at < now() - make_interval(hours => ops.s_int('overflow_age_hours'))) > ops.s_int('overflow_threshold')
     and not exists (select 1 from ops.alerts where kind = 'overflow' and created_at > now() - interval '20 hours') $$;

create or replace function ops.overflow_alerts() returns jsonb language plpgsql set search_path = '' as $$
declare v_count int; v_lead ops.team; v_body text; v_id bigint; v_hours int := ops.s_int('overflow_age_hours');
begin
  if not ops.overflow_due() then return '[]'::jsonb; end if;
  select count(*) into v_count from ops.checks
   where check_type = 'first_call' and not is_test and status in ('pending','alerting','escalated')
     and created_at < now() - make_interval(hours => v_hours);
  select * into v_lead from ops.team where active and escalation_level = 2 order by id limit 1;
  if v_lead.id is null then return '[]'::jsonb; end if;
  v_body := format(E'JAG: %s leads sin llamada por más de %s h. En vez de pausar anuncios, etiquétalos starling_engage para nurture.\n%s leads uncalled for %s+ h. Tag them starling_engage for nurture instead of pausing ads.',
                   v_count, v_hours, v_count, v_hours);
  insert into ops.alerts (kind, member_id, level, channel, body, status, error)
  values ('overflow', v_lead.id, 2, 'sms', v_body,
          case when v_lead.mobile_e164 is null then 'skipped' else 'pending' end,
          case when v_lead.mobile_e164 is null then 'no mobile on file' end)
  returning id into v_id;
  if v_lead.mobile_e164 is null then return '[]'::jsonb; end if;
  return jsonb_build_array(jsonb_build_object('alert_id', v_id, 'channel', 'sms', 'mobile', v_lead.mobile_e164, 'body', v_body));
end $$;

create or replace function public.ops_claim_due(p_limit int default 25) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_checks jsonb;
begin
  if not ops.s_bool('enabled') then
    return jsonb_build_object('enabled', false, 'checks', '[]'::jsonb, 'alerts', '[]'::jsonb);
  end if;
  update ops.checks set status = 'expired', next_action_at = null, updated_at = now()
   where status in ('pending','alerting','escalated') and created_at < now() - interval '7 days';
  with due as (
    select id from ops.checks
     where status in ('pending','alerting') and next_action_at <= now()
       and (claimed_at is null or claimed_at < now() - interval '5 minutes')
     order by next_action_at
     limit greatest(1, least(p_limit, 50))
     for update skip locked
  ), upd as (
    update ops.checks c set claimed_at = now()
      from due where c.id = due.id
    returning c.id as check_id, c.person_id, c.check_type, c.window_start, c.escalation_level
  )
  select coalesce(jsonb_agg(to_jsonb(upd)), '[]'::jsonb) into v_checks from upd;
  return jsonb_build_object('enabled', true, 'checks', v_checks, 'alerts', ops.overflow_alerts());
end $$;

-- decide what to do with one claimed check, given the person's recent FUB calls
create or replace function public.ops_decide(p_check_id bigint, p_calls jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c ops.checks; v_call jsonb; v_level int; v_member ops.team; v_alerts jsonb := '[]'::jsonb;
  v_body text; v_task text; v_status text; v_id bigint; v_sent int; v_mins int; v_next timestamptz;
  v_link text; v_done text; v_time text; v_esc_es text := ''; v_esc_en text := '';
  v_tz text := ops.s_text('tz');
begin
  select * into c from ops.checks where id = p_check_id for update;
  if not found or c.status not in ('pending','alerting') then
    return jsonb_build_object('action', 'none');
  end if;

  -- a team call we never got a webhook for still closes the check
  select x.value into v_call from jsonb_array_elements(ops.as_array(p_calls, 'calls')) x
   where ops.is_team_user(nullif(x.value->>'userId','')::bigint)
     and nullif(x.value->>'personId','')::bigint = c.person_id
     and coalesce(nullif(x.value->>'created','')::timestamptz, now()) >= c.window_start
   limit 1;
  if v_call is not null then
    update ops.checks set status = 'satisfied', satisfied_at = now(), satisfied_by = 'call:' || coalesce(v_call->>'userId','?'),
           next_action_at = null, claimed_at = null, updated_at = now() where id = c.id;
    return jsonb_build_object('action', 'satisfied');
  end if;

  -- next person up the ladder, skipping anyone already pinged on this check
  v_level := c.escalation_level + 1;
  loop
    exit when v_level > 2;
    if v_level = 0 then
      select * into v_member from ops.team where id = c.first_ping_member_id;
    else
      select * into v_member from ops.team where active and escalation_level = v_level order by id limit 1;
    end if;
    exit when v_member.id is not null
          and not exists (select 1 from ops.alerts a where a.check_id = c.id and a.member_id = v_member.id);
    v_level := v_level + 1;
  end loop;

  if v_level > 2 then
    update ops.checks set status = 'escalated', next_action_at = null, claimed_at = null, updated_at = now() where id = c.id;
    return jsonb_build_object('action', 'exhausted');
  end if;

  v_link := ops.s_text('fub_person_url') || c.person_id;
  v_done := ops.s_text('done_url') || c.done_token;
  if v_level > 0 then v_esc_es := 'ESCALADO. '; v_esc_en := 'ESCALATED. '; end if;
  if c.check_type = 'first_call' then
    v_mins := greatest(0, floor(extract(epoch from (now() - (c.window_start + interval '1 minute'))) / 60))::int;
    v_body := format(E'%sJAG: Lead nuevo sin llamada: %s (hace %s min). Llama ya: %s\n%sNew lead %s, no call in %s min. Listo/Done: %s',
                     v_esc_es, c.person_label, v_mins, v_link, v_esc_en, c.person_label, v_mins, v_done);
    v_task := 'Llamar ahora / Call now: lead nuevo ' || c.person_label;
  else
    v_time := trim(to_char(c.appointment_start at time zone v_tz, 'FMHH12:MI AM'));
    v_body := format(E'%sJAG: Cita de las %s con %s y nadie ha llamado. Llama ya: %s\n%s%s appt with %s, no call logged. Listo/Done: %s',
                     v_esc_es, v_time, c.person_label, v_link, v_esc_en, v_time, c.person_label, v_done);
    v_task := 'Llamar ahora / Call now: cita ' || v_time || ' ' || c.person_label;
  end if;

  select count(*) into v_sent from ops.alerts
   where member_id = v_member.id and channel = 'sms' and status = 'sent' and sent_at > now() - interval '1 hour';
  v_status := case when v_member.mobile_e164 is null then 'skipped'
                   when v_sent >= ops.s_int('max_pings_per_hour') then 'capped'
                   else 'pending' end;
  insert into ops.alerts (check_id, kind, member_id, level, channel, body, status, error)
  values (c.id, 'check', v_member.id, v_level, 'sms', v_body, v_status,
          case v_status when 'skipped' then 'no mobile on file' when 'capped' then 'hourly cap reached; held for digest' end)
  returning id into v_id;
  if v_status = 'pending' then
    v_alerts := v_alerts || jsonb_build_object('alert_id', v_id, 'channel', 'sms', 'mobile', v_member.mobile_e164, 'body', v_body);
  end if;

  if v_level = 0 and ops.s_bool('create_fub_tasks') and v_member.fub_user_id is not null then
    insert into ops.alerts (check_id, kind, member_id, level, channel, body, status)
    values (c.id, 'check', v_member.id, 0, 'fub_task', v_task, 'pending') returning id into v_id;
    v_alerts := v_alerts || jsonb_build_object('alert_id', v_id, 'channel', 'fub_task', 'person_id', c.person_id,
                  'assigned_user_id', v_member.fub_user_id, 'name', v_task,
                  'due_date', to_char(now() at time zone v_tz, 'YYYY-MM-DD'));
  end if;

  v_next := case v_level
              when 0 then c.due_at + make_interval(mins => ops.s_int('escalate_backup_minutes'))
              when 1 then c.due_at + make_interval(mins => ops.s_int('escalate_lead_minutes'))
              else null end;
  if v_next is not null then
    v_next := ops.next_business_time(greatest(v_next, now() + interval '2 minutes'));
  end if;
  update ops.checks
     set escalation_level = v_level,
         status = case when v_next is null then 'escalated' else 'alerting' end,
         next_action_at = v_next, claimed_at = null, updated_at = now()
   where id = c.id;

  return jsonb_build_object('action', 'alert', 'level', v_level, 'to', v_member.name, 'alerts', v_alerts);
end $$;

create or replace function public.ops_alert_result(p_alert_id bigint, p_status text, p_provider_id text default null, p_error text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('sent','failed') then raise exception 'status must be sent or failed'; end if;
  update ops.alerts set status = p_status, provider_id = p_provider_id, error = left(p_error, 500),
         sent_at = case when p_status = 'sent' then now() end
   where id = p_alert_id;
  return jsonb_build_object('ok', found);
end $$;

-- ---------- one-tap Done (token is the only key) ----------
create or replace function public.ops_done_peek(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c ops.checks;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return jsonb_build_object('ok', false); end if;
  select * into c from ops.checks where done_token = p_token;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'label', c.person_label, 'type', c.check_type,
                            'open', c.status in ('pending','alerting','escalated'));
end $$;

create or replace function public.ops_mark_done(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_label text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return jsonb_build_object('ok', false); end if;
  update ops.checks set status = 'satisfied', satisfied_at = now(), satisfied_by = 'done_link',
         next_action_at = null, claimed_at = null, updated_at = now()
   where done_token = p_token and status in ('pending','alerting','escalated')
  returning person_label into v_label;
  if found then return jsonb_build_object('ok', true, 'label', v_label); end if;
  select person_label into v_label from ops.checks where done_token = p_token;
  if found then return jsonb_build_object('ok', true, 'label', v_label, 'already', true); end if;
  return jsonb_build_object('ok', false);
end $$;

-- ---------- Deals tab in admin.html (signed-in team only) ----------
create or replace function public.jag_tc_deals() returns json
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return json_build_object('ok', false, 'reason', 'not_allowed'); end if;
  return json_build_object(
    'ok', true,
    'deals', coalesce((select json_agg(row_to_json(d) order by (d.status in ('closed','terminated')), d.closing_date nulls last, d.property)
                         from tc.deals_current d), '[]'::json),
    'last_activity', (select max(created_at) from tc.log));
end $$;

-- ---------- permissions ----------
revoke execute on all functions in schema ops from public, anon, authenticated;
revoke execute on function public.ops_ingest_event(jsonb), public.ops_handle_people(jsonb, text),
  public.ops_handle_appointments(jsonb, text), public.ops_handle_appointments_deleted(jsonb, text),
  public.ops_handle_calls(jsonb, text), public.ops_claim_due(int), public.ops_decide(bigint, jsonb),
  public.ops_alert_result(bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.ops_ingest_event(jsonb), public.ops_handle_people(jsonb, text),
  public.ops_handle_appointments(jsonb, text), public.ops_handle_appointments_deleted(jsonb, text),
  public.ops_handle_calls(jsonb, text), public.ops_claim_due(int), public.ops_decide(bigint, jsonb),
  public.ops_alert_result(bigint, text, text, text)
  to service_role;
revoke execute on function public.ops_done_peek(text), public.ops_mark_done(text) from public;
grant execute on function public.ops_done_peek(text), public.ops_mark_done(text) to anon, authenticated;
revoke execute on function public.jag_tc_deals() from public, anon;
grant execute on function public.jag_tc_deals() to authenticated;

-- ---------------------------------------------------------------------
-- Migration: ops_phase1_wait_text
-- Wait shown as "45 min" or "7 h" in alerts
-- ---------------------------------------------------------------------
create or replace function ops.wait_text(p_minutes int) returns text language sql immutable set search_path = '' as $$
  select case when p_minutes < 90 then p_minutes || ' min'
              else round(p_minutes / 60.0)::int || ' h' end $$;
revoke execute on function ops.wait_text(int) from public, anon, authenticated;

create or replace function public.ops_decide(p_check_id bigint, p_calls jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c ops.checks; v_call jsonb; v_level int; v_member ops.team; v_alerts jsonb := '[]'::jsonb;
  v_body text; v_task text; v_status text; v_id bigint; v_sent int; v_wait text; v_next timestamptz;
  v_link text; v_done text; v_time text; v_esc_es text := ''; v_esc_en text := '';
  v_tz text := ops.s_text('tz');
begin
  select * into c from ops.checks where id = p_check_id for update;
  if not found or c.status not in ('pending','alerting') then
    return jsonb_build_object('action', 'none');
  end if;

  select x.value into v_call from jsonb_array_elements(ops.as_array(p_calls, 'calls')) x
   where ops.is_team_user(nullif(x.value->>'userId','')::bigint)
     and nullif(x.value->>'personId','')::bigint = c.person_id
     and coalesce(nullif(x.value->>'created','')::timestamptz, now()) >= c.window_start
   limit 1;
  if v_call is not null then
    update ops.checks set status = 'satisfied', satisfied_at = now(), satisfied_by = 'call:' || coalesce(v_call->>'userId','?'),
           next_action_at = null, claimed_at = null, updated_at = now() where id = c.id;
    return jsonb_build_object('action', 'satisfied');
  end if;

  v_level := c.escalation_level + 1;
  loop
    exit when v_level > 2;
    if v_level = 0 then
      select * into v_member from ops.team where id = c.first_ping_member_id;
    else
      select * into v_member from ops.team where active and escalation_level = v_level order by id limit 1;
    end if;
    exit when v_member.id is not null
          and not exists (select 1 from ops.alerts a where a.check_id = c.id and a.member_id = v_member.id);
    v_level := v_level + 1;
  end loop;

  if v_level > 2 then
    update ops.checks set status = 'escalated', next_action_at = null, claimed_at = null, updated_at = now() where id = c.id;
    return jsonb_build_object('action', 'exhausted');
  end if;

  v_link := ops.s_text('fub_person_url') || c.person_id;
  v_done := ops.s_text('done_url') || c.done_token;
  if v_level > 0 then v_esc_es := 'ESCALADO. '; v_esc_en := 'ESCALATED. '; end if;
  if c.check_type = 'first_call' then
    v_wait := ops.wait_text(greatest(0, floor(extract(epoch from (now() - (c.window_start + interval '1 minute'))) / 60))::int);
    v_body := format(E'%sJAG: Lead nuevo sin llamada: %s (hace %s). Llama ya: %s\n%sNew lead %s, no call in %s. Listo/Done: %s',
                     v_esc_es, c.person_label, v_wait, v_link, v_esc_en, c.person_label, v_wait, v_done);
    v_task := 'Llamar ahora / Call now: lead nuevo ' || c.person_label;
  else
    v_time := trim(to_char(c.appointment_start at time zone v_tz, 'FMHH12:MI AM'));
    v_body := format(E'%sJAG: Cita de las %s con %s y nadie ha llamado. Llama ya: %s\n%s%s appt with %s, no call logged. Listo/Done: %s',
                     v_esc_es, v_time, c.person_label, v_link, v_esc_en, v_time, c.person_label, v_done);
    v_task := 'Llamar ahora / Call now: cita ' || v_time || ' ' || c.person_label;
  end if;

  select count(*) into v_sent from ops.alerts
   where member_id = v_member.id and channel = 'sms' and status = 'sent' and sent_at > now() - interval '1 hour';
  v_status := case when v_member.mobile_e164 is null then 'skipped'
                   when v_sent >= ops.s_int('max_pings_per_hour') then 'capped'
                   else 'pending' end;
  insert into ops.alerts (check_id, kind, member_id, level, channel, body, status, error)
  values (c.id, 'check', v_member.id, v_level, 'sms', v_body, v_status,
          case v_status when 'skipped' then 'no mobile on file' when 'capped' then 'hourly cap reached; held for digest' end)
  returning id into v_id;
  if v_status = 'pending' then
    v_alerts := v_alerts || jsonb_build_object('alert_id', v_id, 'channel', 'sms', 'mobile', v_member.mobile_e164, 'body', v_body);
  end if;

  if v_level = 0 and ops.s_bool('create_fub_tasks') and v_member.fub_user_id is not null then
    insert into ops.alerts (check_id, kind, member_id, level, channel, body, status)
    values (c.id, 'check', v_member.id, 0, 'fub_task', v_task, 'pending') returning id into v_id;
    v_alerts := v_alerts || jsonb_build_object('alert_id', v_id, 'channel', 'fub_task', 'person_id', c.person_id,
                  'assigned_user_id', v_member.fub_user_id, 'name', v_task,
                  'due_date', to_char(now() at time zone v_tz, 'YYYY-MM-DD'));
  end if;

  v_next := case v_level
              when 0 then c.due_at + make_interval(mins => ops.s_int('escalate_backup_minutes'))
              when 1 then c.due_at + make_interval(mins => ops.s_int('escalate_lead_minutes'))
              else null end;
  if v_next is not null then
    v_next := ops.next_business_time(greatest(v_next, now() + interval '2 minutes'));
  end if;
  update ops.checks
     set escalation_level = v_level,
         status = case when v_next is null then 'escalated' else 'alerting' end,
         next_action_at = v_next, claimed_at = null, updated_at = now()
   where id = c.id;

  return jsonb_build_object('action', 'alert', 'level', v_level, 'to', v_member.name, 'alerts', v_alerts);
end $$;
revoke execute on function public.ops_decide(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.ops_decide(bigint, jsonb) to service_role;

-- =====================================================================
-- SELF-CHECKS  (read-only; run any time in the SQL Editor)
-- =====================================================================

-- 1. Switched on?  (expect false until go-live)
select value as enabled from ops.settings where key = 'enabled';

-- 2. Team roster: everyone who can be pinged needs a mobile (+1XXXXXXXXXX) and a FUB user ID
select name, role, escalation_level, is_default_first_ping, first_ping_for_own,
       fub_user_id is not null as has_fub_id, mobile_e164 is not null as has_mobile, active
  from ops.team order by escalation_level nulls last, name;

-- 3. Nobody outside the server can read the ops tables (expect zero rows)
select grantee, table_name, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'ops' and grantee in ('anon','authenticated','PUBLIC');

-- 4. Which public functions anon / authenticated may call
--    (expect only ops_done_peek, ops_mark_done for anon; plus jag_tc_deals for authenticated)
select routine_name, grantee
  from information_schema.routine_privileges
 where routine_schema = 'public' and grantee in ('anon','authenticated')
   and (routine_name like 'ops\_%' or routine_name = 'jag_tc_deals')
 order by routine_name, grantee;

-- 5. Open checks right now
select id, check_type, person_label, status, escalation_level, due_at, next_action_at, is_test
  from ops.checks where status in ('pending','alerting','escalated') order by next_action_at;

-- 6. Alerts in the last 24 hours, by result
select status, channel, count(*) from ops.alerts
 where created_at > now() - interval '24 hours' group by 1, 2 order by 1, 2;

-- 7. Webhook events received in the last 24 hours, by type
select event, count(*), max(received_at) as last_seen from ops.fub_events
 where received_at > now() - interval '24 hours' group by 1 order by 1;

-- 8. Timer heartbeat (after supabase-ops-timer.sql): last calls to n8n
select created_at, request_id from ops.kicks order by created_at desc limit 5;
