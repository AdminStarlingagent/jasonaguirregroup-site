-- Website offers: the client's details come pre-filled from their account, and the admin or the client's
-- assigned agent can clean up an offer's details before the JAG team prepares the TREC contract.
-- (applied as migration jag_offer_prefill_edit, 2026-10-27)

alter table public.jag_offers add column if not exists edited_at timestamptz;
alter table public.jag_offers add column if not exists edited_by text;

-- signed-in client: what we already know, to fill the offer worksheet
create or replace function public.jag_offer_prefill()
returns json language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); c public.jag_clients; o public.jag_offers; v_proof text; v_pending text;
begin
  if v_uid is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  select * into c from public.jag_clients where user_id = v_uid;
  select * into o from public.jag_offers where user_id = v_uid or (user_id is null and lower(email) = lower(coalesce(auth.jwt()->>'email', '')))
   order by created_at desc limit 1;
  select kind into v_proof from public.jag_client_proof where user_id in (select public.jag_household(v_uid)) and status = 'verified' order by uploaded_at desc limit 1;
  select kind into v_pending from public.jag_client_proof where user_id in (select public.jag_household(v_uid)) and status = 'pending' order by uploaded_at desc limit 1;
  return json_build_object('ok', true,
    'name', coalesce(nullif(c.name, ''), o.name), 'email', coalesce(nullif(c.email, ''), auth.jwt()->>'email'),
    'phone', coalesce(nullif(c.phone, ''), o.phone), 'lang', c.lang,
    -- people who buy with them (accepted co-buyers), else the co-buyer typed on their last offer
    'co_buyer', coalesce((select string_agg(coalesce(nullif(m.name, ''), m.email), ', ' order by m.created_at)
                            from public.jag_clients m where m.user_id in (select public.jag_household(v_uid)) and m.user_id <> v_uid), nullif(o.co_buyer, '')),
    'financing', o.financing, 'loan_type', o.loan_type, 'down_payment', o.down_payment, 'lender', o.lender,
    'proof_verified', v_proof, 'proof_pending', v_pending, 'proof_last', o.proof);
end $$;
revoke all on function public.jag_offer_prefill() from public, anon;
grant execute on function public.jag_offer_prefill() to authenticated;

-- may the caller edit this offer? admin (staff), the client's assigned agent, or any agent when nobody is assigned
create or replace function public.jag_offer_can_edit(p_agent text, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.jag_is_staff(), false) or (
    public.jag_agent_code_me() is not null and (
      coalesce(p_agent, (select c.agent_code from public.jag_clients c where c.user_id = p_user)) is null
      or public.jag_agent_code_me() = coalesce(p_agent, (select c.agent_code from public.jag_clients c where c.user_id = p_user))));
$$;
revoke all on function public.jag_offer_can_edit(text, uuid) from public, anon;

-- clean up an offer's details (buyer + terms); the client sees the corrected offer in their portal
create or replace function public.jag_offer_edit(p_id uuid, p jsonb)
returns json language plpgsql security definer set search_path = '' as $$
declare o public.jag_offers; v_by text := coalesce(public.jag_agent_code_me(), auth.jwt()->>'email');
  v_phone text := nullif(left(regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g'), 15), '');
  v_email text := nullif(lower(left(btrim(coalesce(p->>'email', '')), 160)), '');
  v_name text := nullif(left(btrim(coalesce(p->>'name', '')), 120), '');
begin
  select * into o from public.jag_offers where id = p_id;
  if o.id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if not public.jag_offer_can_edit(o.agent_code, o.user_id) then return json_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then return json_build_object('ok', false, 'reason', 'email'); end if;
  if v_phone is not null and length(v_phone) < 10 then return json_build_object('ok', false, 'reason', 'phone'); end if;
  update public.jag_offers set
    name = coalesce(v_name, name), email = coalesce(v_email, email), phone = coalesce(v_phone, phone),
    co_buyer = case when p ? 'co_buyer' then nullif(left(btrim(coalesce(p->>'co_buyer', '')), 160), '') else co_buyer end,
    address = coalesce(nullif(left(btrim(coalesce(p->>'address', '')), 200), ''), address),
    offer_price = coalesce(nullif(regexp_replace(coalesce(p->>'offer_price', ''), '[^0-9.]', '', 'g'), '')::numeric, offer_price),
    earnest = case when p ? 'earnest' then nullif(regexp_replace(coalesce(p->>'earnest', ''), '[^0-9.]', '', 'g'), '')::numeric else earnest end,
    financing = case when p->>'financing' in ('cash', 'financed') then p->>'financing' else financing end,
    loan_type = case when p ? 'loan_type' then nullif(left(btrim(coalesce(p->>'loan_type', '')), 30), '') else loan_type end,
    down_payment = case when p ? 'down_payment' then nullif(left(btrim(coalesce(p->>'down_payment', '')), 40), '') else down_payment end,
    lender = case when p ? 'lender' then nullif(left(btrim(coalesce(p->>'lender', '')), 80), '') else lender end,
    proof = case when p->>'proof' in ('yes', 'working', 'no') then p->>'proof' else proof end,
    contingencies = case when jsonb_typeof(p->'contingencies') = 'array'
      then coalesce((select array_agg(left(x, 40)) from jsonb_array_elements_text(p->'contingencies') x where btrim(x) <> ''), '{}') else contingencies end,
    option_days = case when p ? 'option_days' then nullif(regexp_replace(coalesce(p->>'option_days', ''), '\D', '', 'g'), '')::int else option_days end,
    close_date = case when p ? 'close_date' then nullif(p->>'close_date', '')::date else close_date end,
    notes = case when p ? 'notes' then left(p->>'notes', 2000) else notes end,
    edited_at = now(), edited_by = v_by, updated_at = now()
  where id = p_id returning * into o;
  -- keep the lead record in step with the cleaned-up contact details
  if o.lead_id is not null then
    update public.jag_leads set name = o.name, email = o.email, phone = o.phone, est_amount = o.offer_price where id = o.lead_id;
  end if;
  return json_build_object('ok', true, 'offer', row_to_json(o));
end $$;
revoke all on function public.jag_offer_edit(uuid, jsonb) from public, anon;
grant execute on function public.jag_offer_edit(uuid, jsonb) to authenticated;

-- team list: + can_edit per offer, + the client's account agent
create or replace function public.jag_offers_team()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  return json_build_object('ok', true, 'offers', coalesce((select json_agg(x order by x.created_at desc) from (
     select o.*, case when o.user_id is null then null else public.jag_client_priority(o.user_id) end as priority,
            coalesce(o.agent_code, (select c.agent_code from public.jag_clients c where c.user_id = o.user_id)) as assigned_agent,
            public.jag_offer_can_edit(o.agent_code, o.user_id) as can_edit
       from public.jag_offers o order by o.created_at desc limit 300) x), '[]'::json),
    'proof', coalesce((select json_agg(y order by y.uploaded_at desc) from (
     select p.id, p.user_id, p.kind, p.path, p.file_name, p.uploaded_at, p.status, p.note, p.reviewed_by, p.reviewed_at,
            c.name, c.email, c.phone
       from public.jag_client_proof p left join public.jag_clients c on c.user_id = p.user_id
      order by p.uploaded_at desc limit 300) y), '[]'::json));
end $$;
