-- ============================================================
-- Team offers from the listing page + hand-off to the TC (René).
--   Listing page "Comenzar oferta" (team only) → jag_offer_start → the usual offer draft (/o#code),
--     pre-filled from HAR (legal description, county, HOA, listing agent/brokerage) and the answers.
--   "Enviar al TC" (listing page / offer) → jag_tc_send   ┐
--   Lola, when an agent texts "tell René to …"   → ops_tc_request ┘→ ops.tc_requests → edge function
--     jag-offer-tc: JAG-branded email to the TC with the step-by-step, + a Follow Up Boss task on the client.
-- The TC is ops.settings tc_agent_code (default 'rene'), so it can change without code.
-- ============================================================

alter table ops.offer_requests add column if not exists mls text;

create table if not exists ops.tc_requests (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  member_id int,                         -- who asked (ops.team)
  offer_request_id bigint references ops.offer_requests(id),
  fub_person_id bigint,
  client_label text,
  title text,                            -- what to do, one line
  steps text,                            -- step-by-step written by the agent or Lola
  via text not null default 'hub',       -- hub | text
  sent_at timestamptz,
  fub_task_id bigint,
  tries int not null default 0,
  error text
);
alter table ops.tc_requests enable row level security;

insert into ops.settings (key, value, note)
values ('tc_agent_code', '"rene"'::jsonb, 'Agent code (jag_agents) of the transaction coordinator who gets offer prep emails and FUB tasks.')
on conflict (key) do nothing;

-- the ops.team member for the signed-in team user (agent card first, then staff email); null if none
create or replace function ops.team_member_me()
returns int language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select t.id from public.jag_agents a join ops.team t on t.fub_user_id = a.fub_user_id and t.active
      where a.active and a.user_id = auth.uid() limit 1),
    (select t.id from public.jag_agents a join ops.team t on t.fub_user_id = a.fub_user_id and t.active
      where a.active and lower(a.email) = lower(coalesce(auth.jwt()->>'email', '')) limit 1));
$$;

-- send the queued request to the edge function (server token from the vault)
create or replace function ops.kick_tc(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $function$
declare v_tok text;
begin
  select decrypted_secret into v_tok from vault.decrypted_secrets where name = 'jag_alerts_token';
  perform net.http_post(url := 'https://nyaxywghbpphjhwcmspd.supabase.co/functions/v1/jag-offer-tc',
    body := jsonb_build_object('id', p_id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jag-token', v_tok), timeout_milliseconds := 15000);
end $function$;

create or replace function ops.tc_queue(p_member_id int, p_offer_id bigint, p_fub_person_id bigint, p_client text, p_title text, p_steps text, p_via text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_id bigint; o ops.offer_requests; v_tc text;
begin
  if p_offer_id is not null then select * into o from ops.offer_requests where id = p_offer_id; end if;
  if p_offer_id is not null and o.id is null then return jsonb_build_object('ok', false, 'reason', 'offer_not_found'); end if;
  if o.id is null and nullif(btrim(coalesce(p_title, '')), '') is null and nullif(btrim(coalesce(p_steps, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;
  insert into ops.tc_requests (member_id, offer_request_id, fub_person_id, client_label, title, steps, via)
  values (p_member_id, o.id, coalesce(p_fub_person_id, o.fub_person_id), coalesce(nullif(btrim(p_client), ''), o.client_label),
          left(nullif(btrim(coalesce(p_title, '')), ''), 200), left(nullif(btrim(coalesce(p_steps, '')), ''), 4000), coalesce(p_via, 'hub'))
  returning id into v_id;
  perform ops.kick_tc(v_id);
  select coalesce(a.first_name, a.name) into v_tc from public.jag_agents a where a.code = coalesce(ops.s_text('tc_agent_code'), 'rene');
  return jsonb_build_object('ok', true, 'id', v_id, 'tc', coalesce(v_tc, 'the TC'));
end $function$;

-- ---------- website (team JWT) ----------
-- p: { address, city, zip, mls, fub_person_id, client, terms:{…TREC keys…} }
create or replace function public.jag_offer_start(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_member int; v_addr text := btrim(coalesce(p->>'address', '')); r jsonb; v_terms jsonb;
begin
  if not coalesce(public.jag_is_team(), false) then return jsonb_build_object('ok', false, 'reason', 'not_team'); end if;
  if v_addr = '' then return jsonb_build_object('ok', false, 'reason', 'address'); end if;
  v_member := coalesce(ops.team_member_me(), (select id from ops.team where role = 'lead' and active order by id limit 1));
  v_terms := jsonb_strip_nulls(coalesce(p->'terms', '{}'::jsonb)) || jsonb_strip_nulls(jsonb_build_object('mls', nullif(p->>'mls', '')));
  r := public.ops_offer_request(v_member, v_addr, nullif(p->>'fub_person_id', '')::bigint, nullif(btrim(coalesce(p->>'client', '')), ''), v_terms);
  update ops.offer_requests set mls = nullif(p->>'mls', '') where id = (r->>'offer_request_id')::bigint;
  return r;
end $function$;

create or replace function public.jag_tc_send(p_offer_id bigint, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if not coalesce(public.jag_is_team(), false) then return jsonb_build_object('ok', false, 'reason', 'not_team'); end if;
  return ops.tc_queue(coalesce(ops.team_member_me(), (select id from ops.team where role = 'lead' and active order by id limit 1)),
                      p_offer_id, null, null, null, p_note, 'hub');
end $function$;

-- ---------- Lola (n8n, service role) ----------
create or replace function public.ops_tc_request(p_member_id int, p_title text, p_steps text, p_offer_request_id bigint default null,
                                                 p_fub_person_id bigint default null, p_client text default null)
returns jsonb language sql security definer set search_path = '' as $$
  select ops.tc_queue(p_member_id, nullif(p_offer_request_id, 0), nullif(p_fub_person_id, 0), p_client, p_title, p_steps, 'text');
$$;

-- ---------- edge function jag-offer-tc (service role) ----------
create or replace function public.ops_tc_payload(p_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ok', r.id is not null, 'id', r.id, 'title', r.title, 'steps', r.steps, 'via', r.via, 'client', r.client_label,
    'fub_person_id', r.fub_person_id, 'sent_at', r.sent_at,
    'by', (select jsonb_build_object('name', t.name, 'first', coalesce(a.first_name, split_part(t.name, ' ', 1)), 'email', a.email, 'fub_user_id', t.fub_user_id)
             from ops.team t left join public.jag_agents a on a.fub_user_id = t.fub_user_id where t.id = r.member_id),
    'tc', (select jsonb_build_object('name', a.name, 'first', coalesce(a.first_name, split_part(a.name, ' ', 1)), 'email', a.email,
                    'fub_user_id', a.fub_user_id, 'lang', coalesce(t.language, 'en'))
             from public.jag_agents a left join ops.team t on t.fub_user_id = a.fub_user_id
            where a.code = coalesce(ops.s_text('tc_agent_code'), 'rene')),
    'offer', case when o.id is null then null else jsonb_build_object('id', o.id, 'property', o.property, 'mls', o.mls, 'client', o.client_label,
                    'fub_person_id', o.fub_person_id, 'link', ops.offer_link(o), 'missing', ops.offer_missing(o.terms),
                    'terms', (select value from ops.settings where key = 'offer_defaults') || o.terms) end)
  from ops.tc_requests r left join ops.offer_requests o on o.id = r.offer_request_id
  where r.id = p_id;
$$;

create or replace function public.ops_tc_mark(p_id bigint, p_ok boolean, p_fub_person_id bigint default null, p_task_id bigint default null, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update ops.tc_requests set sent_at = case when p_ok then now() else sent_at end,
         fub_person_id = coalesce(fub_person_id, p_fub_person_id), fub_task_id = coalesce(p_task_id, fub_task_id),
         tries = tries + case when p_ok then 0 else 1 end, error = case when p_ok then null else left(p_error, 400) end
   where id = p_id;
$$;

revoke all on function ops.team_member_me(), ops.kick_tc(bigint), ops.tc_queue(int, bigint, bigint, text, text, text, text) from public, anon, authenticated;
revoke all on function public.jag_offer_start(jsonb), public.jag_tc_send(bigint, text) from public, anon;
grant execute on function public.jag_offer_start(jsonb), public.jag_tc_send(bigint, text) to authenticated;
revoke all on function public.ops_tc_request(int, text, text, bigint, bigint, text), public.ops_tc_payload(bigint),
                       public.ops_tc_mark(bigint, boolean, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.ops_tc_request(int, text, text, bigint, bigint, text), public.ops_tc_payload(bigint),
                       public.ops_tc_mark(bigint, boolean, bigint, bigint, text) to service_role;

-- the offer draft page (/o#code) is opened with its secret link; that link is enough to hand the offer to the TC
create or replace function public.ops_offer_send_tc(p_token text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare o ops.offer_requests; v_tok text := ops.offer_token_for(trim(coalesce(p_token, '')));
begin
  if v_tok is null then return jsonb_build_object('ok', false); end if;
  select * into o from ops.offer_requests where token = v_tok and token_expires_at > now() and status <> 'cancelled';
  if o.id is null then return jsonb_build_object('ok', false); end if;
  if exists (select 1 from ops.tc_requests where offer_request_id = o.id and created_at > now() - interval '2 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'just_sent');
  end if;
  return ops.tc_queue(o.member_id, o.id, null, null, null, left(p_note, 4000), 'hub');
end $function$;
revoke all on function public.ops_offer_send_tc(text, text) from public;
grant execute on function public.ops_offer_send_tc(text, text) to anon, authenticated;
