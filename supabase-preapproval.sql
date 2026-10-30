-- ============================================================
-- Pre-approval, set by the team, used everywhere.
--   · Agents (not only admins) set loan progress from the contact profile (Loan card): jag_contact_loan_get / _set.
--     Same data as admin → Loan progress (jag_clients.loan_stage / loan_detail, whole household), plus down_payment.
--   · The offer form fills in from it (jag_offer_prefill): loan, loan type, lender, down payment, "Yes, I have it",
--     and the pre-approved amount (the form warns when an offer goes above it).
--   · jag_my_plan returns 'preapproved' so the site stops asking pre-approved clients to apply / get evaluated.
-- ============================================================

-- the household's pre-approval, if the team marked it (or the loan app was marked Won)
create or replace function public.jag_preapproval(p_user uuid)
returns json language plpgsql stable security definer set search_path to '' as $$
declare l json := public.jag_loan_state(p_user); d jsonb; v_type text; v_down text;
begin
  if l is null or coalesce(l->>'stage', '') <> 'done' then return null; end if;
  d := coalesce((l->'detail')::jsonb, '{}'::jsonb);
  v_type := lower(coalesce(d->>'loan_type', ''));
  v_down := coalesce(nullif(d->>'down_payment', ''), case v_type when 'fha' then '3.5%' when 'va' then '0%' when 'usda' then '0%' end);
  if d->>'expires' ~ '^\d{4}-\d{2}-\d{2}$' and (d->>'expires')::date < current_date then
    return json_build_object('ok', true, 'expired', true, 'expires', d->>'expires', 'amount', d->'amount', 'loan_type', nullif(v_type, ''), 'lender', d->>'lender');
  end if;
  return json_build_object('ok', true, 'expired', false, 'amount', d->'amount', 'loan_type', nullif(v_type, ''), 'lender', d->>'lender',
    'down_payment', v_down, 'expires', d->>'expires', 'manual', coalesce((l->>'manual')::boolean, false));
end $$;
revoke all on function public.jag_preapproval(uuid) from public, anon, authenticated;

create or replace function public.jag_my_plan()
returns json language plpgsql stable security definer set search_path = '' as $function$
begin
  if auth.uid() is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  if not exists (select 1 from public.jag_clients where user_id = auth.uid()) then return json_build_object('ok', false, 'reason', 'no_account'); end if;
  return json_build_object('ok', true, 'app', public.jag_loan_state(auth.uid()), 'preapproved', public.jag_preapproval(auth.uid()));
end $function$;

-- offer form prefill: the pre-approval wins over what they typed on an older offer
create or replace function public.jag_offer_prefill()
returns json language plpgsql stable security definer set search_path to '' as $function$
declare v_uid uuid := auth.uid(); c public.jag_clients; o public.jag_offers; v_proof text; v_pending text; pa json; v_pa boolean; v_type text;
begin
  if v_uid is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  select * into c from public.jag_clients where user_id = v_uid;
  select * into o from public.jag_offers where user_id = v_uid or (user_id is null and lower(email) = lower(coalesce(auth.jwt()->>'email', '')))
   order by created_at desc limit 1;
  select kind into v_proof from public.jag_client_proof where user_id in (select public.jag_household(v_uid)) and status = 'verified' order by uploaded_at desc limit 1;
  select kind into v_pending from public.jag_client_proof where user_id in (select public.jag_household(v_uid)) and status = 'pending' order by uploaded_at desc limit 1;
  pa := public.jag_preapproval(v_uid);
  v_pa := pa is not null and not coalesce((pa->>'expired')::boolean, false);
  v_type := case when v_pa then pa->>'loan_type' end;
  return json_build_object('ok', true,
    'name', coalesce(nullif(c.name, ''), o.name), 'email', coalesce(nullif(c.email, ''), auth.jwt()->>'email'),
    'phone', coalesce(nullif(c.phone, ''), o.phone), 'lang', c.lang,
    'co_buyer', coalesce((select string_agg(coalesce(nullif(m.name, ''), m.email), ', ' order by m.created_at)
                            from public.jag_clients m where m.user_id in (select public.jag_household(v_uid)) and m.user_id <> v_uid), nullif(o.co_buyer, '')),
    'financing', case when v_pa then case when v_type = 'cash' then 'cash' else 'financed' end else o.financing end,
    'loan_type', case when v_pa and v_type is not null and v_type <> 'cash' then v_type else o.loan_type end,
    'down_payment', case when v_pa and pa->>'down_payment' is not null then pa->>'down_payment' else o.down_payment end,
    'lender', case when v_pa and pa->>'lender' is not null then pa->>'lender' else o.lender end,
    'proof_verified', coalesce(v_proof, case when v_pa then case when v_type = 'cash' then 'pof' else 'preapproval' end end),
    'proof_pending', v_pending, 'proof_last', o.proof,
    'preapproved', case when v_pa then pa end);
end $function$;

-- the profile's Loan card (any team member who can see the contact)
create or replace function public.jag_contact_loan_get(p_contact uuid)
returns json language plpgsql stable security definer set search_path to '' as $$
declare c public.jag_contacts; k public.jag_clients; a public.jag_leads;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_contacts where id = public.jag_cid(p_contact);
  if c.id is null or not public.jag_contact_visible(c.id) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  if c.user_id is null then return json_build_object('ok', true, 'account', false); end if;
  select * into k from public.jag_clients where user_id = c.user_id;
  select * into a from public.jag_client_app(c.user_id);
  return json_build_object('ok', true, 'account', true, 'stage', k.loan_stage, 'detail', k.loan_detail, 'set_at', k.loan_set_at, 'set_by', k.loan_set_by,
    'shows', public.jag_loan_state(c.user_id), 'preapproved', public.jag_preapproval(c.user_id),
    'app', case when a.id is null then null else json_build_object('id', a.id, 'at', a.created_at, 'status', a.status,
      'estimate', a.payload->>'Estimate Shown to Client') end);
end $$;

-- p: { stage, amount, loan_type, lender, down_payment, expires, docs:[…], note, check_back }   stage 'auto' = back to automatic
create or replace function public.jag_contact_loan_set(p_contact uuid, p jsonb)
returns json language plpgsql security definer set search_path to '' as $$
declare c public.jag_contacts; v_stage text := lower(coalesce(p->>'stage', '')); v_d jsonb; v_by text; v_me text := public.jag_agent_code_me(); v_sum text;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_contacts where id = public.jag_cid(p_contact);
  if c.id is null or not public.jag_contact_visible(c.id) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  if c.user_id is null or not exists (select 1 from public.jag_clients where user_id = c.user_id) then return json_build_object('ok', false, 'reason', 'no_account'); end if;
  if v_stage not in ('auto', 'none', 'received', 'review', 'docs', 'preapproved', 'credit', 'paused') then return json_build_object('ok', false, 'reason', 'stage'); end if;
  v_by := coalesce((select coalesce(first_name, name) from public.jag_agents where user_id = auth.uid() limit 1), auth.jwt()->>'email', 'JAG');
  v_d := jsonb_strip_nulls(jsonb_build_object(
    'amount', case when v_stage = 'preapproved' then nullif(regexp_replace(coalesce(p->>'amount', ''), '[^0-9.]', '', 'g'), '')::numeric end,
    'loan_type', case when v_stage = 'preapproved' and lower(p->>'loan_type') in ('fha', 'conventional', 'va', 'usda', 'itin', 'cash', 'other') then lower(p->>'loan_type') end,
    'lender', case when v_stage = 'preapproved' then left(nullif(btrim(p->>'lender'), ''), 80) end,
    'down_payment', case when v_stage = 'preapproved' then left(nullif(btrim(p->>'down_payment'), ''), 40) end,
    'expires', case when v_stage = 'preapproved' and (p->>'expires') ~ '^\d{4}-\d{2}-\d{2}$' then p->>'expires' end,
    'docs', case when v_stage = 'docs' then (select jsonb_agg(left(btrim(x), 80)) from jsonb_array_elements_text(coalesce(p->'docs', '[]'::jsonb)) x where btrim(x) <> '') end,
    'check_back', case when v_stage in ('credit', 'paused') and (p->>'check_back') ~ '^\d{4}-\d{2}-\d{2}$' then p->>'check_back' end,
    'note', left(nullif(btrim(p->>'note'), ''), 600)));
  update public.jag_clients set loan_stage = case when v_stage = 'auto' then null else v_stage end,
         loan_detail = case when v_stage = 'auto' then '{}'::jsonb else v_d end,
         loan_set_at = case when v_stage = 'auto' then null else now() end, loan_set_by = v_by
   where user_id in (select public.jag_household(c.user_id));
  v_sum := case v_stage
    when 'preapproved' then 'Loan: pre-approved' || coalesce(' up to $' || to_char((v_d->>'amount')::numeric, 'FM999,999,999'), '')
         || coalesce(' · ' || upper(v_d->>'loan_type'), '') || coalesce(' · ' || (v_d->>'lender'), '') || coalesce(' · expires ' || (v_d->>'expires'), '')
    when 'docs' then 'Loan: needs documents' when 'review' then 'Loan: in review' when 'received' then 'Loan: application received'
    when 'credit' then 'Loan: working on credit' when 'paused' then 'Loan: paused' when 'none' then 'Loan: hidden from the client'
    else 'Loan: back to automatic' end;
  insert into public.jag_contact_notes (contact_id, user_id, agent_code, author_name, kind, subject, meta)
  values (c.id, c.user_id, v_me, v_by, 'system', v_sum, jsonb_build_object('loan', v_stage));
  return public.jag_contact_loan_get(c.id);
end $$;

revoke all on function public.jag_contact_loan_get(uuid), public.jag_contact_loan_set(uuid, jsonb) from public, anon;
grant execute on function public.jag_contact_loan_get(uuid), public.jag_contact_loan_set(uuid, jsonb) to authenticated;

-- the profile's Offers card: every term the client chose, the household's pre-approval for comparison
create or replace function public.jag_contact_offers(p_contact uuid)
returns json language plpgsql stable security definer set search_path to '' as $$
declare c public.jag_contacts;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_contacts where id = public.jag_cid(p_contact);
  if c.id is null or not public.jag_contact_visible(c.id) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  return json_build_object('ok', true,
    'preapproved', case when c.user_id is not null then public.jag_preapproval(c.user_id) end,
    'offers', coalesce((select json_agg(x order by x.created_at desc) from (
       select o.*, public.jag_offer_can_edit(o.agent_code, o.user_id) as can_edit
         from public.jag_offers o
        where (c.user_id is not null and o.user_id = c.user_id)
           or (o.user_id is null and ((c.email is not null and lower(o.email) = lower(c.email))
                or (length(right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10)) = 10
                    and right(regexp_replace(coalesce(o.phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(c.phone, '\D', '', 'g'), 10))))
        order by o.created_at desc limit 20) x), '[]'::json));
end $$;
revoke all on function public.jag_contact_offers(uuid) from public, anon;
grant execute on function public.jag_contact_offers(uuid) to authenticated;
