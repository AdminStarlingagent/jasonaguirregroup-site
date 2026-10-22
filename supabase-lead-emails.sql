-- ============================================================
-- Home emails for screened leads (no website account needed).
-- The screener enrolls a lead after the client agrees on the call. The lead-emails function (hourly)
-- sends matching HAR homes on the standard pace: a welcome right away, up to 2 a week for the first
-- 30 days, then weekly through day 90. It stops on unsubscribe, when the agent stops it, or when the
-- client creates a website account (their account alerts take over with the same search).
-- Only security-definer RPCs and the service role touch the table (RLS on, no policies).
-- ============================================================
create table if not exists public.jag_lead_drips (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  screening_id uuid,
  agent_code text,
  name text,
  email text not null,
  phone text,
  lang text not null default 'es',
  area text,
  beds int,
  maxp int,
  status text not null default 'active'
    check (status in ('active', 'stopped', 'unsubscribed', 'account', 'done', 'no_homes')),
  stop_reason text,
  consent_at timestamptz not null default now(),
  next_at timestamptz not null default now(),
  sent_count int not null default 0,
  last_sent_at timestamptz,
  sent_mls text[] not null default '{}',
  last_error text
);
create unique index if not exists jag_lead_drips_one_active on public.jag_lead_drips (lower(email)) where status = 'active';
create index if not exists jag_lead_drips_due on public.jag_lead_drips (next_at) where status = 'active';
alter table public.jag_lead_drips enable row level security;

-- Start (or update) a lead's home emails. Team only; the agent must confirm the client agreed.
create or replace function public.jag_drip_start(p_email text, p_name text default null, p_phone text default null,
  p_lang text default 'es', p_area text default null, p_beds int default null, p_maxp int default null,
  p_screening uuid default null, p_consent boolean default false)
returns json language plpgsql security definer set search_path = '' as $$
declare v_em text := lower(trim(coalesce(p_email, ''))); v_id uuid; v_code text := public.jag_agent_code_me();
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  if v_em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return json_build_object('ok', false, 'reason', 'email'); end if;
  if p_consent is not true then return json_build_object('ok', false, 'reason', 'consent'); end if;
  if exists (select 1 from public.jag_clients c where lower(c.email) = v_em) then
    return json_build_object('ok', false, 'reason', 'has_account');
  end if;
  update public.jag_lead_drips set name = coalesce(nullif(trim(p_name), ''), name), phone = coalesce(nullif(p_phone, ''), phone),
         lang = case when p_lang in ('es', 'en') then p_lang else lang end,
         area = nullif(trim(p_area), ''), beds = p_beds, maxp = p_maxp, screening_id = coalesce(p_screening, screening_id),
         agent_code = coalesce(v_code, agent_code)
   where lower(email) = v_em and status = 'active' returning id into v_id;
  if v_id is null then
    insert into public.jag_lead_drips (email, name, phone, lang, area, beds, maxp, screening_id, agent_code)
    values (v_em, nullif(trim(p_name), ''), nullif(p_phone, ''), case when p_lang in ('es', 'en') then p_lang else 'es' end,
            nullif(trim(p_area), ''), p_beds, p_maxp, p_screening, v_code)
    returning id into v_id;
  end if;
  return json_build_object('ok', true, 'id', v_id);
end $$;

-- Latest campaign for an email, for the screener panel.
create or replace function public.jag_drip_status(p_email text)
returns json language plpgsql stable security definer set search_path = '' as $$
declare d public.jag_lead_drips;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into d from public.jag_lead_drips where lower(email) = lower(trim(coalesce(p_email, ''))) order by created_at desc limit 1;
  if not found then return json_build_object('ok', true, 'found', false,
    'has_account', exists (select 1 from public.jag_clients c where lower(c.email) = lower(trim(coalesce(p_email, ''))))); end if;
  return json_build_object('ok', true, 'found', true, 'id', d.id, 'status', d.status, 'created_at', d.created_at,
    'sent_count', d.sent_count, 'last_sent_at', d.last_sent_at, 'next_at', d.next_at, 'area', d.area, 'beds', d.beds,
    'maxp', d.maxp, 'lang', d.lang, 'last_error', d.last_error,
    'agent_name', (select a.name from public.jag_agents a where a.code = d.agent_code));
end $$;

-- Stop a campaign (the client replied, asked to stop, or is no longer a fit).
create or replace function public.jag_drip_stop(p_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  update public.jag_lead_drips set status = 'stopped', stop_reason = 'agent' where id = p_id and status = 'active';
  return json_build_object('ok', true);
end $$;

revoke all on function public.jag_drip_start(text, text, text, text, text, int, int, uuid, boolean) from public, anon;
revoke all on function public.jag_drip_status(text) from public, anon;
revoke all on function public.jag_drip_stop(uuid) from public, anon;
grant execute on function public.jag_drip_start(text, text, text, text, text, int, int, uuid, boolean),
                          public.jag_drip_status(text), public.jag_drip_stop(uuid) to authenticated;
