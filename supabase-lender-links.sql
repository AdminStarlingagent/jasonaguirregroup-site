-- ============================================================
-- JAG CRM — Secure lender links          (safe to run more than once)
-- Run in: Supabase → SQL Editor → New query → paste → Run
--
-- What it adds
--   • jag_lender_shares      one row per link the team creates
--   • jag_lender_access_log  who opened what, when (audit trail)
--   • jag_create_lender_share()  team only  → makes link + 6-digit PIN
--   • jag_lender_view()          lender     → the file, tax ID masked
--   • jag_lender_reveal()        lender     → full SSN/ITIN, PIN required,
--                                             locks after 5 wrong PINs
-- The full number is still never stored in the clear and never
-- travels by email — it is only decrypted on a correct PIN.
-- ============================================================

create table if not exists public.jag_lender_shares (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references public.jag_leads(id) on delete cascade,
  token            text not null unique,
  pin              text not null,
  lender_email     text,
  note             text,
  created_by       text,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  view_count       integer not null default 0,
  last_viewed_at   timestamptz,
  reveal_count     integer not null default 0,
  last_revealed_at timestamptz,
  failed_pins      integer not null default 0
);
create index if not exists jag_lender_shares_lead_idx
  on public.jag_lender_shares (lead_id, created_at desc);

create table if not exists public.jag_lender_access_log (
  id        bigint generated always as identity primary key,
  share_id  uuid not null references public.jag_lender_shares(id) on delete cascade,
  at        timestamptz not null default now(),
  event     text not null,            -- view | reveal | bad_pin | locked
  ip        text,
  ua        text
);
create index if not exists jag_lender_access_log_share_idx
  on public.jag_lender_access_log (share_id, at desc);

alter table public.jag_lender_shares     enable row level security;
alter table public.jag_lender_access_log enable row level security;

-- Signed-in team: read links + revoke them. The public website key: nothing.
drop policy if exists "team reads lender shares"   on public.jag_lender_shares;
create policy "team reads lender shares"   on public.jag_lender_shares
  for select to authenticated using (true);

drop policy if exists "team updates lender shares" on public.jag_lender_shares;
create policy "team updates lender shares" on public.jag_lender_shares
  for update to authenticated using (true) with check (true);

drop policy if exists "team reads lender access log" on public.jag_lender_access_log;
create policy "team reads lender access log" on public.jag_lender_access_log
  for select to authenticated using (true);

revoke all on public.jag_lender_shares     from anon;
revoke all on public.jag_lender_access_log from anon;
revoke insert, delete, truncate on public.jag_lender_shares     from authenticated;
revoke insert, update, delete, truncate on public.jag_lender_access_log from authenticated;

-- ------------------------------------------------------------
-- internal: write one audit row (never blocks the caller)
-- ------------------------------------------------------------
create or replace function public.jag_lender_log(p_share_id uuid, p_event text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_h json;
begin
  begin
    v_h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_h := null;
  end;
  insert into public.jag_lender_access_log (share_id, event, ip, ua)
  values (
    p_share_id, p_event,
    left(split_part(coalesce(v_h->>'x-forwarded-for', ''), ',', 1), 64),
    left(coalesce(v_h->>'user-agent', ''), 300)
  );
exception when others then
  null;
end $$;

-- ------------------------------------------------------------
-- TEAM: create a link for one application
-- ------------------------------------------------------------
create or replace function public.jag_create_lender_share(
  p_lead_id      uuid,
  p_lender_email text    default null,
  p_note         text    default null,
  p_days         integer default 14
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row  public.jag_lender_shares;
  v_days integer;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'authenticated' then
    raise exception 'team sign-in required';
  end if;
  if not exists (select 1 from public.jag_leads where id = p_lead_id) then
    raise exception 'unknown lead';
  end if;
  v_days := greatest(1, least(coalesce(p_days, 14), 30));

  insert into public.jag_lender_shares (lead_id, token, pin, lender_email, note, created_by, expires_at)
  values (
    p_lead_id,
    translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_'),
    lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0'),
    nullif(btrim(coalesce(p_lender_email, '')), ''),
    nullif(btrim(coalesce(p_note, '')), ''),
    auth.jwt()->>'email',
    now() + make_interval(days => v_days)
  )
  returning * into v_row;

  return json_build_object(
    'id', v_row.id, 'token', v_row.token, 'pin', v_row.pin, 'expires_at', v_row.expires_at
  );
end $$;

-- ------------------------------------------------------------
-- LENDER: open the file (tax IDs stay masked here)
-- ------------------------------------------------------------
create or replace function public.jag_lender_view(p_token text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  s     public.jag_lender_shares;
  l     public.jag_leads;
  v_tax json;
begin
  if p_token is null or length(p_token) < 20 then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into s from public.jag_lender_shares where token = p_token;
  if not found then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;
  if s.revoked_at is not null then
    return json_build_object('ok', false, 'reason', 'revoked');
  end if;
  if s.expires_at < now() then
    return json_build_object('ok', false, 'reason', 'expired');
  end if;

  select * into l from public.jag_leads where id = s.lead_id;

  update public.jag_lender_shares
     set view_count = view_count + 1, last_viewed_at = now()
   where id = s.id;
  perform public.jag_lender_log(s.id, 'view');

  select coalesce(json_agg(which order by which), '[]'::json) into v_tax
    from public.jag_lead_secure where lead_id = s.lead_id;

  return json_build_object(
    'ok', true,
    'name', l.name,
    'type', l.type,
    'lang', l.lang,
    'submitted_at', l.created_at,
    'payload', (l.payload - 'access_key' - 'botcheck' - 'from_name' - 'subject' - '__name'),
    'note', s.note,
    'sent_by', s.created_by,
    'expires_at', s.expires_at,
    'locked', s.failed_pins >= 5,
    'tax_ids', v_tax
  );
end $$;

-- ------------------------------------------------------------
-- LENDER: reveal the full SSN / ITIN — PIN required, 5 tries
-- ------------------------------------------------------------
create or replace function public.jag_lender_reveal(
  p_token text,
  p_pin   text,
  p_which text default 'borrower'
)
returns json
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  s      public.jag_lender_shares;
  v_key  text;
  v_out  text;
  v_fail integer;
begin
  if p_token is null or length(p_token) < 20 then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;
  -- row lock: PIN guesses are checked one at a time, never in parallel
  select * into s from public.jag_lender_shares where token = p_token for update;
  if not found then
    return json_build_object('ok', false, 'reason', 'not_found');
  end if;
  if s.revoked_at is not null then
    return json_build_object('ok', false, 'reason', 'revoked');
  end if;
  if s.expires_at < now() then
    return json_build_object('ok', false, 'reason', 'expired');
  end if;
  if s.failed_pins >= 5 then
    return json_build_object('ok', false, 'reason', 'locked');
  end if;
  if p_which is null or p_which not in ('borrower', 'coborrower') then
    return json_build_object('ok', false, 'reason', 'bad_request');
  end if;

  if regexp_replace(coalesce(p_pin, ''), '[^0-9]', '', 'g') <> s.pin then
    v_fail := s.failed_pins + 1;
    update public.jag_lender_shares set failed_pins = v_fail where id = s.id;
    perform public.jag_lender_log(s.id, case when v_fail >= 5 then 'locked' else 'bad_pin' end);
    return json_build_object(
      'ok', false,
      'reason', case when v_fail >= 5 then 'locked' else 'bad_pin' end,
      'tries_left', greatest(0, 5 - v_fail)
    );
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'jag_tax_key';
  select pgp_sym_decrypt(tax_id_enc, v_key) into v_out
    from public.jag_lead_secure where lead_id = s.lead_id and which = p_which;
  if v_out is null then
    return json_build_object('ok', false, 'reason', 'no_tax_id');
  end if;

  update public.jag_lender_shares
     set reveal_count = reveal_count + 1, last_revealed_at = now(), failed_pins = 0
   where id = s.id;
  perform public.jag_lender_log(s.id, 'reveal');

  return json_build_object('ok', true, 'value', v_out);
end $$;

-- ------------------------------------------------------------
-- Permissions — Supabase grants new functions to the public web
-- key by default, so take that away explicitly first.
-- ------------------------------------------------------------
revoke all on function public.jag_lender_log(uuid, text)                          from public, anon, authenticated;
revoke all on function public.jag_create_lender_share(uuid, text, text, integer)  from public, anon;
revoke all on function public.jag_lender_view(text)                               from public;
revoke all on function public.jag_lender_reveal(text, text, text)                 from public;

grant execute on function public.jag_create_lender_share(uuid, text, text, integer) to authenticated;
grant execute on function public.jag_lender_view(text)                 to anon, authenticated;
grant execute on function public.jag_lender_reveal(text, text, text)   to anon, authenticated;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- Self-check — every row should read  ok = true
-- ------------------------------------------------------------
select * from (values
  ('website key CANNOT create links',
     not has_function_privilege('anon', 'public.jag_create_lender_share(uuid,text,text,integer)', 'execute')),
  ('website key CANNOT read the links table',
     not has_table_privilege('anon', 'public.jag_lender_shares', 'select')),
  ('website key CANNOT read the access log',
     not has_table_privilege('anon', 'public.jag_lender_access_log', 'select')),
  ('team CAN create links',
     has_function_privilege('authenticated', 'public.jag_create_lender_share(uuid,text,text,integer)', 'execute')),
  ('lender page CAN open a link',
     has_function_privilege('anon', 'public.jag_lender_view(text)', 'execute')),
  ('lender page CAN reveal with a PIN',
     has_function_privilege('anon', 'public.jag_lender_reveal(text,text,text)', 'execute')),
  ('SSN encryption key is present',
     exists (select 1 from vault.secrets where name = 'jag_tax_key'))
) as t(check_name, ok);
