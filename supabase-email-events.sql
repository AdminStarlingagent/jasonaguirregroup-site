-- ============================================================
-- Email bounces and spam complaints (Resend webhook → edge function resend-events → jag_email_event).
--   jag_email_events     every delivery event we get (audit; delivered / bounced / complained / delayed …)
--   jag_email_suppress   addresses we never email again: hard bounces and spam complaints
-- On a bounce or complaint:
--   · Lola's weekly emails stop for that person (jag_lead_alerts → 'bounced' / 'unsub'), so the pilot's 5% safety stop sees it
--   · screened-lead home emails stop (jag_lead_drips → stopped / unsubscribed)
--   · a complaint also turns off their account's home alerts (jag_clients)
--   · their profile timeline gets a note, and Follow Up Boss gets the same note (fub-sync)
-- Lola's claim and enrollment skip suppressed addresses.
-- ============================================================
create table if not exists public.jag_email_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  type text not null,
  email text,
  resend_id text,
  subject text,
  data jsonb not null default '{}'::jsonb
);
create index if not exists jag_email_events_email on public.jag_email_events (lower(email), at desc);
create index if not exists jag_email_events_type on public.jag_email_events (type, at desc);
alter table public.jag_email_events enable row level security;

create table if not exists public.jag_email_suppress (
  email text primary key,
  reason text not null check (reason in ('bounce', 'complaint')),
  detail text,
  at timestamptz not null default now()
);
alter table public.jag_email_suppress enable row level security;

create or replace function public.jag_email_suppressed(p_email text)
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.jag_email_suppress s where s.email = lower(btrim(coalesce(p_email, ''))));
$$;

-- p: { type, email, resend_id, subject, bounce_type, detail, data }
create or replace function public.jag_email_event(p jsonb)
returns json language plpgsql security definer set search_path to '' as $$
declare v_type text := lower(coalesce(p->>'type', '')); v_email text := lower(btrim(coalesce(p->>'email', '')));
        v_reason text; v_hard boolean; c record; n int := 0;
begin
  insert into public.jag_email_events (type, email, resend_id, subject, data)
  values (v_type, nullif(v_email, ''), p->>'resend_id', left(p->>'subject', 300), coalesce(p->'data', '{}'::jsonb));
  if v_email = '' then return json_build_object('ok', true); end if;
  -- soft bounces (mailbox full, temporary) don't suppress; Resend retries those
  v_hard := v_type = 'email.bounced' and coalesce(lower(p->>'bounce_type'), 'permanent') not in ('transient', 'temporary', 'soft');
  v_reason := case when v_type = 'email.complained' then 'complaint' when v_hard then 'bounce' end;
  if v_reason is null then return json_build_object('ok', true, 'action', 'logged'); end if;

  insert into public.jag_email_suppress (email, reason, detail) values (v_email, v_reason, left(p->>'detail', 300))
  on conflict (email) do update set reason = case when excluded.reason = 'complaint' then 'complaint' else public.jag_email_suppress.reason end,
                                    detail = coalesce(excluded.detail, public.jag_email_suppress.detail), at = now();

  update public.jag_lead_alerts a set status = case when v_reason = 'complaint' then 'unsub' else 'bounced' end,
         unsub_at = case when v_reason = 'complaint' then now() else a.unsub_at end, last_error = left('Resend: ' || v_reason || coalesce(' · ' || (p->>'detail'), ''), 300), updated_at = now()
   from public.jag_contacts k where k.id = a.contact_id and lower(k.email) = v_email and a.status in ('pilot', 'active', 'paused');
  update public.jag_lead_drips set status = case when v_reason = 'complaint' then 'unsubscribed' else 'stopped' end,
         stop_reason = 'Resend ' || v_reason
   where lower(email) = v_email and status = 'active';
  if v_reason = 'complaint' then
    update public.jag_clients set alert_freq = 'off', notify = coalesce(notify, '{}'::jsonb) || '{"new":"off","price":"off","status":"off"}'::jsonb
     where lower(email) = v_email;
  end if;

  for c in select id, user_id, fub_id, assigned_code from public.jag_contacts where lower(email) = v_email and not deleted limit 3 loop
    n := n + 1;
    insert into public.jag_contact_notes (contact_id, user_id, agent_code, author_name, kind, subject, meta)
    values (c.id, c.user_id, c.assigned_code, 'Email system', 'system',
            case when v_reason = 'complaint' then '🚫 Marked our email as spam (' || v_email || '). All automatic emails stopped. Call or text instead.'
                 else '📭 Email bounced (' || v_email || ' doesn''t work). Automatic emails stopped. Get a new email on your next call.' end,
            jsonb_build_object('email_event', v_reason));
    if c.fub_id is not null then
      insert into public.jag_fub_out (contact_id, fub_id, kind, by_code, payload)
      values (c.id, c.fub_id, 'note', null, jsonb_build_object('who', 'JAG email system', 'body',
        case when v_reason = 'complaint' then 'Marked a JAG email as spam (' || v_email || '). Automatic emails stopped. Call or text instead.'
             else 'Email bounced: ' || v_email || ' does not work. Automatic emails stopped. Ask for a new email on the next call.' end));
    end if;
  end loop;
  if n > 0 then perform public.jag_fub_kick(); end if;
  return json_build_object('ok', true, 'action', v_reason, 'contacts', n);
end $$;

revoke all on function public.jag_email_event(jsonb), public.jag_email_suppressed(text) from public, anon, authenticated;
grant execute on function public.jag_email_event(jsonb), public.jag_email_suppressed(text) to service_role;

-- Lola's weekly emails: never claim a suppressed address
create or replace function public.jag_lead_alerts_claim(p_limit int default 50) returns json language plpgsql security definer set search_path = '' as $function$
declare v json;
begin
  if coalesce((select (v->>'paused')::boolean from public.jag_kv where k = 'lola_listings'), false) then return '[]'::json; end if;
  with due as (
    select a.contact_id from public.jag_lead_alerts a join public.jag_contacts c on c.id = a.contact_id
     where a.status in ('pilot', 'active') and not c.deleted and c.email is not null
       and not exists (select 1 from public.jag_email_suppress s where s.email = lower(btrim(c.email)))
       and coalesce(c.stage, '') not in ('Under contract', 'Pending', 'Closed', 'Past Client', 'Trash')
       and (a.last_sent_at is null or a.last_sent_at < now() - interval '6 days 20 hours')
       and (a.claimed_at is null or a.claimed_at < now() - interval '20 minutes')
     order by a.last_sent_at nulls first, a.created_at
     limit least(greatest(p_limit, 1), 100)
     for update of a skip locked
  ), cl as (
    update public.jag_lead_alerts a set claimed_at = now() from due where a.contact_id = due.contact_id returning a.*
  )
  select coalesce(json_agg(json_build_object('contact_id', cl.contact_id, 'token', cl.token, 'criteria', cl.criteria, 'sent_mls', cl.sent_mls,
           'lang', cl.lang, 'first', cl.sent_count = 0, 'name', c.name, 'first_name', c.first_name, 'email', c.email,
           'agent', (select json_build_object('code', g.code, 'name', g.name, 'first_name', g.first_name, 'email', g.email,
                       'phone', coalesce(g.phone_override, g.phone), 'photo_url', g.photo_url)
                       from public.jag_agents g where g.code = coalesce((select x.code from public.jag_agents x where x.code = c.assigned_code and x.active), 'jason')))), '[]'::json)
    into v from cl join public.jag_contacts c on c.id = cl.contact_id;
  return v;
end $function$;
