-- ============================================================
-- Appointments in one place (Agent Hub "Appointments" + the client's profile), synced both ways with Follow Up Boss.
--   jag_appointments     every appointment with a client in FUB (last 60 days + next 60), plus ones booked from the hub
--                        · follow: what the team did after it (calls, texts, notes) — filled by edge fn jag-appointments
--                        · outcome: FUB's appointment outcome (No show / Working with buyers / Listing obtained / Application Submitted)
--   Lola's read          jag_lola_stage(contact): where the client is (new → screened → applied → pre-approved → touring →
--                        offers → under contract), hot or not, why, and the next step. Computed live from the site + FUB.
-- Team RPCs: jag_appts_list(view, days, mine), jag_appts_for_contact(contact), jag_lola_stage(contact)
-- Edge fn jag-appointments: sync (cron, x-jag-token) · outcome / create / refresh (team login) → FUB + this table.
-- Reminders: the existing FUB intake (ops.appointments / ops.checks) keeps texting the owner on booking, 1 h and 15 min
-- before, and checks for a call after. New here: the client's own reminder (email; text only with consent) and
-- Lola's nudge when an appointment has no outcome / no follow-up (jag_appts_nudge, run by the sync).
-- ============================================================
create table if not exists public.jag_appointments (
  id bigint generated always as identity primary key,
  fub_id bigint unique,
  title text,
  description text,
  start_at timestamptz not null,
  end_at timestamptz,
  all_day boolean not null default false,
  location text,
  type text,
  outcome text,
  outcome_id int,
  outcome_at timestamptz,
  outcome_by text,
  fub_person_id bigint,
  person_name text,
  extra_person_ids bigint[] not null default '{}',
  user_ids bigint[] not null default '{}',
  owner_user_id bigint,
  created_by_id bigint,
  source text not null default 'fub',
  fub_created timestamptz,
  fub_updated timestamptz,
  follow jsonb,
  note text,
  client_reminded jsonb not null default '{}'::jsonb,
  nudged jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jag_appointments_start on public.jag_appointments (start_at desc);
create index if not exists jag_appointments_person on public.jag_appointments (fub_person_id);
alter table public.jag_appointments enable row level security;
alter table public.jag_appointments add column if not exists lola jsonb;        -- Lola's read, refreshed every 30 min by the sync
alter table public.jag_appointments add column if not exists lola_at timestamptz;

-- ---------- Lola's read: where is this client in the process? ----------
create or replace function public.jag_lola_stage(p_contact uuid)
returns json language plpgsql stable security definer set search_path to '' as $$
declare c public.jag_contacts; j json; st text; hot boolean := false; why text[] := '{}'; nxt text; fs text;
        v_app timestamptz; v_last timestamptz; v_views int; v_saved int; v_loan text; v_amt numeric; v_score int;
begin
  select * into c from public.jag_contacts where id = p_contact;
  if c.id is null then return null; end if;
  j := public.jag_contact_journey(p_contact);
  fs := coalesce(c.stage, '');
  v_app := nullif(j->'app'->>'at', '')::timestamptz;
  v_last := nullif(j->'looking'->>'last', '')::timestamptz;
  v_views := coalesce((j->'looking'->>'views')::int, 0);
  v_saved := coalesce((j->'looking'->>'saved')::int, 0);
  v_loan := j->'loan'->>'stage';
  if c.user_id is not null then
    begin v_amt := nullif(public.jag_preapproval(c.user_id)->>'amount', '')::numeric; exception when others then v_amt := null; end;
  end if;
  select s.score into v_score from public.jag_client_scores s where s.user_id = c.user_id;

  if fs in ('Closed', 'Past Client') then st := 'closed';
  elsif fs in ('Under contract', 'Pending') then st := 'contract';
  elsif fs in ('Listing agreement', 'Active listing') then st := 'listing';
  elsif coalesce((j->'offer'->>'n')::int, 0) > 0 or fs = 'Submitting offers' then st := 'offer';
  elsif coalesce((j->'show'->>'tours')::int, 0) + coalesce((j->'show'->>'req')::int, 0) > 0 or fs = 'Showing homes' then st := 'touring';
  elsif v_loan = 'done' or j->>'proof' is not null or fs = 'Loan Approved' then st := 'approved';
  elsif v_app is not null or fs = 'Applied' then st := 'applied';
  elsif j->'screen' is not null then st := 'screened';
  elsif v_views >= 3 or v_saved > 0 then st := 'browsing';
  else st := 'new';
  end if;

  if v_app is not null then why := why || ('Loan app ' || to_char(v_app at time zone 'America/Chicago', 'Mon DD')); end if;
  if v_loan = 'done' then why := why || ('Pre-approved' || coalesce(' up to $' || to_char(round(v_amt / 1000), 'FM999,999') || 'K', ''));
  elsif v_loan is not null then why := why || ('Loan: ' || v_loan); end if;
  if j->'screen' is not null then why := why || ('Screened' || case when (j->'screen'->>'hot')::boolean then ' (hot)' else '' end); end if;
  if v_last is not null and v_last > now() - interval '14 days' then
    why := why || ('On the app ' || case when v_last > now() - interval '1 day' then 'today' else to_char(v_last at time zone 'America/Chicago', 'Mon DD') end
                    || ' · ' || v_views || ' views' || case when v_saved > 0 then ', ' || v_saved || ' saved' else '' end);
  end if;
  if coalesce((j->'show'->>'req')::int, 0) > 0 then why := why || ((j->'show'->>'req') || ' showing request(s)'); end if;
  if coalesce((j->'offer'->>'n')::int, 0) > 0 then why := why || ((j->'offer'->>'n') || ' offer(s), last: ' || coalesce(j->'offer'->>'last', '?')); end if;
  if fs <> '' then why := why || ('FUB stage: ' || fs); end if;

  hot := st in ('offer', 'touring', 'approved', 'contract')
      or (v_app is not null and v_app > now() - interval '90 days')
      or (v_last is not null and v_last > now() - interval '7 days')
      or coalesce((j->'screen'->>'hot')::boolean, false)
      or coalesce(v_score, 0) >= 70
      or fs in ('Hot Prospect', 'Active Client');

  nxt := case st
    when 'new' then 'Call and do the evaluation (JAG Home App)'
    when 'browsing' then 'Call now: they are looking at homes in the app'
    when 'screened' then 'Send the loan application and help them finish it'
    when 'applied' then 'Follow up on the pre-approval with the lender'
    when 'approved' then 'Send homes and book showings'
    when 'touring' then 'Ask which homes they liked; get an offer ready'
    when 'offer' then 'Follow the offer; keep sending options'
    when 'contract' then 'Keep the closing on track'
    when 'listing' then 'Keep the listing moving; check showings and feedback'
    else 'Stay in touch (past client)' end;

  return json_build_object('stage', st,
    'label', case st when 'new' then 'New' when 'browsing' then 'Browsing homes' when 'screened' then 'Screened'
      when 'applied' then 'Applied' when 'approved' then 'Pre-approved' when 'touring' then 'Touring homes'
      when 'offer' then 'Making offers' when 'contract' then 'Under contract' when 'listing' then 'Seller / listing' else 'Closed' end,
    'step', case st when 'new' then 1 when 'browsing' then 1 when 'screened' then 2 when 'applied' then 3 when 'approved' then 4
      when 'touring' then 5 when 'offer' then 6 when 'contract' then 7 when 'listing' then 6 else 8 end,
    'hot', hot, 'why', to_json(why), 'next', nxt, 'score', v_score);
end $$;

-- status of one appointment
create or replace function public.jag_appt_status(a public.jag_appointments)
returns text language sql stable set search_path to '' as $$
  select case
    when a.start_at > now() then 'upcoming'
    when a.outcome = 'No show' then 'no_show'
    when a.outcome is not null then 'done'
    when (a.follow->>'last_at') is not null then 'followed'
    when a.start_at < now() - interval '24 hours' then 'no_followup'
    else 'needs_outcome' end;
$$;

-- (jag_appt_row reads the stored a.lola; see supabase-appointments-lola.sql for jag_appts_stage_refresh)
create or replace function public.jag_appt_row(a public.jag_appointments, p_stage boolean default true)
returns json language sql stable security definer set search_path to '' as $$
  select json_build_object(
    'id', a.id, 'fub_id', a.fub_id, 'title', a.title, 'start_at', a.start_at, 'end_at', a.end_at, 'all_day', a.all_day,
    'location', a.location, 'type', a.type, 'outcome', a.outcome, 'outcome_id', a.outcome_id, 'outcome_at', a.outcome_at, 'outcome_by', a.outcome_by,
    'status', public.jag_appt_status(a), 'source', a.source, 'note', a.note, 'description', a.description,
    'follow', a.follow, 'fub_person_id', a.fub_person_id, 'person_name', coalesce(k.name, a.person_name),
    'contact_id', k.id, 'phone', k.phone, 'email', k.email, 'lang', k.lang, 'fub_stage', k.stage,
    'owner', (select json_build_object('fub_user_id', t.fub_user_id, 'name', t.name, 'first', split_part(t.name, ' ', 1)) from ops.team t where t.fub_user_id = a.owner_user_id limit 1),
    'team', (select coalesce(json_agg(split_part(t.name, ' ', 1) order by t.id), '[]'::json) from ops.team t where t.fub_user_id = any(a.user_ids)),
    'brief', (select o.brief from ops.appointments o where o.appointment_id = a.fub_id),
    'reminded', a.client_reminded,
    'lola', case when p_stage then a.lola end)
  from (select 1) one left join public.jag_contacts k on k.fub_id = a.fub_person_id and not k.deleted;
$$;

-- the list: upcoming + the last p_days, hot clients and missing follow-up first
create or replace function public.jag_appts_list(p_view text default 'all', p_days int default 60, p_mine boolean default false)
returns json language plpgsql stable security definer set search_path to '' as $$
declare v_me bigint;
begin
  if not coalesce(public.jag_is_team(), false) then return json_build_object('ok', false); end if;
  select g.fub_user_id into v_me from public.jag_agents g where g.user_id = auth.uid() and g.active limit 1;
  return json_build_object('ok', true, 'me', v_me, 'rows', coalesce((
    select json_agg(r order by (r->>'start_at')::timestamptz desc) from (
      select public.jag_appt_row(a) r from public.jag_appointments a
       where not a.deleted
         and a.start_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 60), 120)))
         and a.start_at < now() + interval '45 days'
         and (not p_mine or v_me is null or a.owner_user_id = v_me or v_me = any(a.user_ids))
         and (coalesce(p_view, 'all') = 'all'
              or (p_view = 'upcoming' and a.start_at > now())
              or (p_view = 'attention' and a.start_at <= now() and a.outcome is null))
       order by a.start_at desc limit 400) x), '[]'::json));
end $$;

create or replace function public.jag_appts_for_contact(p_contact uuid)
returns json language plpgsql stable security definer set search_path to '' as $$
declare v_fub bigint;
begin
  if not coalesce(public.jag_is_team(), false) then return '[]'::json; end if;
  select fub_id into v_fub from public.jag_contacts where id = p_contact;
  if v_fub is null then return '[]'::json; end if;
  return coalesce((select json_agg(public.jag_appt_row(a, false) order by a.start_at desc)
                     from public.jag_appointments a where not a.deleted and (a.fub_person_id = v_fub or v_fub = any(a.extra_person_ids))), '[]'::json);
end $$;

create or replace function public.jag_lola_stage_team(p_contact uuid)
returns json language sql stable security definer set search_path to '' as $$
  select case when coalesce(public.jag_is_team(), false) then public.jag_lola_stage(p_contact) end;
$$;

revoke all on function public.jag_lola_stage(uuid), public.jag_appt_row(public.jag_appointments, boolean) from public, anon, authenticated;
grant execute on function public.jag_lola_stage(uuid), public.jag_appt_row(public.jag_appointments, boolean) to service_role;
revoke all on function public.jag_appts_list(text, int, boolean), public.jag_appts_for_contact(uuid), public.jag_lola_stage_team(uuid) from public, anon;
grant execute on function public.jag_appts_list(text, int, boolean), public.jag_appts_for_contact(uuid), public.jag_lola_stage_team(uuid) to authenticated;
