-- JAG screener: who sees what, and the loan-app link back to the screening.
-- Applied by Claude on 2026-10-20. Kept here as a record.

-- 1) Admin access is controlled by the owner (Jason). Access is switched on/off (active), never deleted.
alter table public.jag_staff add column if not exists role text not null default 'staff';
alter table public.jag_staff add column if not exists active boolean not null default true;
update public.jag_staff set role = 'owner' where lower(email) = 'jason.aguirre@jasonhoustonrealty.com';
create table if not exists public.jag_staff_invites (email text primary key check (email = lower(email)), granted_by text,
  created_at timestamptz not null default now(), active boolean not null default true);
alter table public.jag_staff_invites enable row level security;
-- jag_is_staff(): active jag_staff row for auth.uid(), or an active invite for the signed-in email.
-- jag_is_owner(), jag_team_access(), jag_set_access(email, on): see the live database (applied 2026-10-20).

-- 2) Screenings: agents see their own; admin-access people see everyone's.
alter table public.jag_screenings add column if not exists app_lead_id uuid, add column if not exists app_at timestamptz;
alter policy "screenings: team reads" on public.jag_screenings
  using (public.jag_is_staff() or (created_by = auth.uid() and public.jag_is_team()));
alter policy "screenings: team updates" on public.jag_screenings
  using (public.jag_is_staff() or (created_by = auth.uid() and public.jag_is_team()))
  with check (public.jag_is_staff() or (created_by = auth.uid() and public.jag_is_team()));
alter policy "screenings: team adds" on public.jag_screenings
  with check (public.jag_is_team() and created_by = auth.uid());

-- 3) When a Home Loan application arrives, link it to the latest screening of the same client (90 days),
--    note who screened them on the application, and tell n8n so Lola can notify that agent.
create or replace function public.jag_link_app_to_screening() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_phone text; v_email text; s public.jag_screenings; v_agent public.jag_agents; v_secret text;
begin
  if new.type is distinct from 'Mortgage Application' then return new; end if;
  begin
    v_phone := right(regexp_replace(coalesce(new.phone, ''), '\D', '', 'g'), 10);
    v_email := lower(trim(coalesce(new.email, '')));
    select * into s from public.jag_screenings x
     where x.created_at > now() - interval '90 days' and x.app_lead_id is null
       and ((length(v_phone) = 10 and right(regexp_replace(coalesce(x.phone, ''), '\D', '', 'g'), 10) = v_phone)
         or (v_email like '%@%' and lower(trim(coalesce(x.email, ''))) = v_email))
     order by x.created_at desc limit 1;
    if s.id is null then return new; end if;
    update public.jag_screenings set app_lead_id = new.id, app_at = now() where id = s.id;
    new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object(
      'Screened By', coalesce(nullif(s.screener, ''), 'Team'),
      'Screening', 'https://jasonaguirregroup.company/screener.html#s=' || s.id,
      'Screening Readiness', coalesce(s.score::text || '%', ''));
    select * into v_agent from public.jag_agents where user_id = s.created_by limit 1;
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'jag_ops_watchdog_secret' limit 1;
    if v_secret is not null then
      perform net.http_post(
        url := 'https://toomuchtaco.app.n8n.cloud/webhook/jag-screener-app',
        headers := jsonb_build_object('Content-Type', 'application/json', 'X-JAG-Ops-Secret', v_secret),
        body := jsonb_build_object('screening_id', s.id, 'lead_id', new.id, 'client', new.name, 'screener', s.screener,
          'screened_at', s.created_at, 'score', s.score, 'hot', s.hot, 'fub_person_id', s.fub_person_id,
          'agent_name', v_agent.name, 'agent_first', v_agent.first_name, 'agent_phone', v_agent.phone, 'agent_fub_user_id', v_agent.fub_user_id),
        timeout_milliseconds := 5000);
    end if;
  exception when others then
    raise warning 'jag_link_app_to_screening: %', sqlerrm;   -- never block an application
  end;
  return new;
end $$;
create or replace trigger jag_leads_link_screening before insert on public.jag_leads
  for each row execute function public.jag_link_app_to_screening();

select 'screenings access ready' as done;
