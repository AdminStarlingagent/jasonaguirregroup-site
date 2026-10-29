-- ============================================================
-- Loan progress the team sets by hand (admin → client profile → "Loan progress").
-- For clients who didn't apply through the app (an agent called them, screened them, the lender took the
-- application) or whose result came back. What the client sees in Mi plan → "Conozca su presupuesto".
--   loan_stage: received · review · docs · preapproved · credit · paused · none   (null = automatic from their app)
--   loan_detail: { amount, loan_type, lender, expires, docs:[…], note (client-facing), check_back (date) }
-- A newer Home Loan application than the team's update takes over again (they tried again → "Application sent").
-- Shared with co-buyers in the same household.
-- ============================================================
alter table public.jag_clients add column if not exists loan_stage text;
alter table public.jag_clients add column if not exists loan_detail jsonb not null default '{}'::jsonb;
alter table public.jag_clients add column if not exists loan_set_at timestamptz;
alter table public.jag_clients add column if not exists loan_set_by text;

-- the latest Home Loan application for this client (email or phone)
create or replace function public.jag_client_app(p_user uuid)
returns public.jag_leads language sql stable security definer set search_path = '' as $$
  select l.* from public.jag_clients c, public.jag_leads l
   where c.user_id = p_user and l.type = 'Mortgage Application' and coalesce(l.status, '') <> 'Merged' and l.created_at > now() - interval '18 months'
     and ((lower(trim(coalesce(c.email, ''))) like '%@%' and lower(trim(coalesce(l.email, ''))) = lower(trim(c.email)))
       or (length(right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10)) = 10
           and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10)))
   order by l.created_at desc limit 1;
$$;

-- what the client sees: the team's update, unless they sent a newer application since
create or replace function public.jag_loan_state(p_user uuid)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare a public.jag_leads; m public.jag_clients; v_auto text;
begin
  select * into a from public.jag_client_app(p_user);
  -- the household's latest team update
  select c.* into m from public.jag_clients c where c.user_id in (select public.jag_household(p_user)) and c.loan_set_at is not null and c.loan_stage is not null
   order by c.loan_set_at desc limit 1;
  v_auto := case when a.id is null then null else case a.status when 'New' then 'received' when 'Contacted' then 'review' when 'Working' then 'review'
                 when 'Credit' then 'credit' when 'Won' then 'done' when 'Lost' then 'paused' else 'received' end end;
  if m.user_id is not null and (a.id is null or a.created_at <= m.loan_set_at) then
    if m.loan_stage = 'none' then return null; end if;
    return json_build_object('at', coalesce(a.created_at, m.loan_set_at), 'stage', case m.loan_stage when 'preapproved' then 'done' else m.loan_stage end,
      'manual', true, 'set_at', m.loan_set_at, 'detail', m.loan_detail);
  end if;
  if a.id is null then return null; end if;
  return json_build_object('at', a.created_at, 'stage', v_auto, 'manual', false);
end $function$;

create or replace function public.jag_my_plan()
returns json language plpgsql stable security definer set search_path = '' as $function$
begin
  if auth.uid() is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  if not exists (select 1 from public.jag_clients where user_id = auth.uid()) then return json_build_object('ok', false, 'reason', 'no_account'); end if;
  return json_build_object('ok', true, 'app', public.jag_loan_state(auth.uid()));
end $function$;

-- admin: read it (by account, or by the email/phone on a loan app)
create or replace function public.jag_staff_loan_get(p_user uuid default null, p_email text default null, p_phone text default null)
returns json language plpgsql stable security definer set search_path = '' as $function$
declare c public.jag_clients; a public.jag_leads; v_ph text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
begin
  if not coalesce(public.jag_is_staff(), false) then return json_build_object('ok', false, 'reason', 'not_staff'); end if;
  if p_user is not null then select * into c from public.jag_clients where user_id = p_user; end if;
  if c.user_id is null and lower(trim(coalesce(p_email, ''))) like '%@%' then select * into c from public.jag_clients where lower(email) = lower(trim(p_email)) limit 1; end if;
  if c.user_id is null and length(v_ph) = 10 then select * into c from public.jag_clients where right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = v_ph order by last_seen_at desc nulls last limit 1; end if;
  if c.user_id is null then return json_build_object('ok', true, 'account', false); end if;
  select * into a from public.jag_client_app(c.user_id);
  return json_build_object('ok', true, 'account', true, 'user_id', c.user_id, 'name', c.name, 'lang', coalesce(c.lang, 'es'),
    'stage', c.loan_stage, 'detail', c.loan_detail, 'set_at', c.loan_set_at, 'set_by', c.loan_set_by,
    'app', case when a.id is null then null else json_build_object('id', a.id, 'at', a.created_at, 'status', a.status) end,
    'shows', public.jag_loan_state(c.user_id),
    'household', (select count(*) from public.jag_household(c.user_id)));
end $function$;

-- admin: set it. p: { stage, amount, loan_type, lender, expires, docs:[…], note, check_back }   stage 'auto' = back to automatic
create or replace function public.jag_staff_loan_set(p_user uuid, p jsonb)
returns json language plpgsql security definer set search_path = '' as $function$
declare v_stage text := lower(coalesce(p->>'stage', '')); v_d jsonb; v_by text;
begin
  if not coalesce(public.jag_is_staff(), false) then return json_build_object('ok', false, 'reason', 'not_staff'); end if;
  if not exists (select 1 from public.jag_clients where user_id = p_user) then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_stage not in ('auto', 'none', 'received', 'review', 'docs', 'preapproved', 'credit', 'paused') then return json_build_object('ok', false, 'reason', 'stage'); end if;
  select coalesce(a.first_name, a.name, s.email) into v_by from public.jag_staff s left join public.jag_agents a on lower(a.email) = lower(s.email)
   where lower(s.email) = lower(auth.jwt()->>'email') limit 1;
  v_by := coalesce(v_by, (select coalesce(first_name, name) from public.jag_agents where user_id = auth.uid() limit 1), auth.jwt()->>'email', 'JAG');
  v_d := jsonb_strip_nulls(jsonb_build_object(
    'amount', case when v_stage = 'preapproved' then nullif(regexp_replace(coalesce(p->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric end,
    'loan_type', case when v_stage = 'preapproved' and lower(p->>'loan_type') in ('fha', 'conventional', 'va', 'usda', 'itin', 'cash', 'other') then lower(p->>'loan_type') end,
    'lender', case when v_stage = 'preapproved' then left(nullif(btrim(p->>'lender'), ''), 80) end,
    'expires', case when v_stage = 'preapproved' and (p->>'expires') ~ '^\d{4}-\d{2}-\d{2}$' then p->>'expires' end,
    'docs', case when v_stage = 'docs' then (select jsonb_agg(left(btrim(x), 80)) from jsonb_array_elements_text(coalesce(p->'docs', '[]'::jsonb)) x where btrim(x) <> '') end,
    'check_back', case when v_stage in ('credit', 'paused') and (p->>'check_back') ~ '^\d{4}-\d{2}-\d{2}$' then p->>'check_back' end,
    'note', left(nullif(btrim(p->>'note'), ''), 600)));
  -- the whole household sees the same progress
  update public.jag_clients set loan_stage = case when v_stage = 'auto' then null else v_stage end,
         loan_detail = case when v_stage = 'auto' then '{}'::jsonb else v_d end,
         loan_set_at = case when v_stage = 'auto' then null else now() end, loan_set_by = v_by
   where user_id in (select public.jag_household(p_user));
  return public.jag_staff_loan_get(p_user, null, null);
end $function$;

revoke all on function public.jag_client_app(uuid), public.jag_loan_state(uuid) from public, anon, authenticated;
revoke all on function public.jag_staff_loan_get(uuid, text, text), public.jag_staff_loan_set(uuid, jsonb) from public, anon;
grant execute on function public.jag_staff_loan_get(uuid, text, text), public.jag_staff_loan_set(uuid, jsonb) to authenticated;
