-- ============================================================
-- René's offer checklist + Lola texts for it. (applied as migration jag_tc_checklist, 2026-10-28)
--  * Every offer handed to the TC gets a secret checklist link (jasonaguirregroup.company/tc#<token>).
--  * Lola texts René the link right away (team texts wait until 8 AM if it's after 9 PM).
--  * René checks off steps on his phone. "Sent for signatures" and "Sent to the listing agent" text the agent who sent
--    the offer + Katherine (+ Jason when it's out). "I'm stuck" texts Jason and the agent.
--  * Not opened after 30 minutes → Lola nudges René once.
--  Team texts go out through n8n "JAG Ops · Team texts" (webhook jag-team-texts) from the Lola line.
-- ============================================================

insert into ops.settings (key, value, note) values
  ('tc_page_url', '"https://jasonaguirregroup.company/tc#"'::jsonb, 'René''s offer checklist page (token appended).'),
  ('tc_notify_codes', '["katherine"]'::jsonb, 'Agent codes texted when the TC sends an offer for signatures / to the listing agent (besides the agent who sent it).'),
  ('team_texts_url', '"https://toomuchtaco.app.n8n.cloud/webhook/jag-team-texts"'::jsonb, 'n8n webhook that sends queued team texts from the Lola line.')
on conflict (key) do nothing;

-- ---------- team text queue ----------
create table if not exists ops.team_texts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  member_id int,
  to_e164 text not null,
  body text not null,
  kind text,
  ref bigint,
  send_after timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  sid text,
  error text,
  tries int not null default 0
);
alter table ops.team_texts enable row level security;
create index if not exists team_texts_due on ops.team_texts (send_after) where sent_at is null;

-- now during 8 AM-9 PM Central, otherwise the next 8 AM
create or replace function ops.team_text_time()
returns timestamptz language sql stable set search_path = '' as $$
  select case when extract(hour from now() at time zone 'America/Chicago') between 8 and 20 then now()
    else ((date_trunc('day', now() at time zone 'America/Chicago')
           + case when extract(hour from now() at time zone 'America/Chicago') >= 21 then interval '1 day' else interval '0' end
           + interval '8 hours') at time zone 'America/Chicago') end;
$$;

create or replace function ops.kick_team_texts()
returns text language plpgsql security definer set search_path = '' as $function$
declare v_secret text; v_rows jsonb; v_url text := ops.s_text('team_texts_url');
begin
  perform ops.tc_nudge();
  with due as (
    select id from ops.team_texts
     where sent_at is null and tries < 3 and send_after <= now()
       and (claimed_at is null or claimed_at < now() - interval '10 minutes')
     order by id limit 20 for update skip locked
  ), claimed as (
    update ops.team_texts t set claimed_at = now() from due where t.id = due.id returning t.id, t.to_e164, t.body
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'to', to_e164, 'body', body) order by id), '[]'::jsonb) into v_rows from claimed;
  if jsonb_array_length(v_rows) = 0 or coalesce(v_url, '') = '' then return 'idle'; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'jag_ops_watchdog_secret';
  perform net.http_post(url := v_url, body := jsonb_build_object('texts', v_rows),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-JAG-Ops-Secret', v_secret), timeout_milliseconds := 15000);
  return 'kicked ' || jsonb_array_length(v_rows);
end $function$;

-- queue a Lola text to a team member (ops.team id). p_now = send even at night.
create or replace function ops.lola_text(p_member_id int, p_body text, p_kind text default null, p_ref bigint default null, p_now boolean default false)
returns bigint language plpgsql security definer set search_path = '' as $function$
declare v_to text; v_id bigint;
begin
  select mobile_e164 into v_to from ops.team where id = p_member_id and active;
  if coalesce(v_to, '') = '' or coalesce(btrim(p_body), '') = '' then return null; end if;
  insert into ops.team_texts (member_id, to_e164, body, kind, ref, send_after)
  values (p_member_id, v_to, left(p_body, 1500), p_kind, p_ref, case when p_now then now() else ops.team_text_time() end)
  returning id into v_id;
  return v_id;
end $function$;

-- n8n marks each text after Twilio
create or replace function public.ops_team_text_mark(p_id bigint, p_sid text default null, p_error text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare t ops.team_texts;
begin
  update ops.team_texts set sent_at = case when p_error is null then now() else sent_at end, sid = coalesce(p_sid, sid),
         error = left(p_error, 300), tries = tries + 1, claimed_at = case when p_error is null then claimed_at else null end
   where id = p_id returning * into t;
  if t.id is not null and p_error is null then
    insert into ops.text_log (member_id, direction, body, twilio_sid) values (t.member_id, 'out', t.body, p_sid) on conflict (twilio_sid) do nothing;
  end if;
  return jsonb_build_object('ok', t.id is not null);
end $function$;
revoke all on function public.ops_team_text_mark(bigint, text, text) from public, anon, authenticated;
grant execute on function public.ops_team_text_mark(bigint, text, text) to service_role;

-- ---------- the checklist ----------
alter table ops.tc_requests add column if not exists token text default encode(extensions.gen_random_bytes(12), 'hex');
alter table ops.tc_requests add column if not exists opened_at timestamptz;
alter table ops.tc_requests add column if not exists progress jsonb not null default '{}'::jsonb;
alter table ops.tc_requests add column if not exists done_at timestamptz;
alter table ops.tc_requests add column if not exists nudged_at timestamptz;
alter table ops.tc_requests add column if not exists stuck_at timestamptz;
update ops.tc_requests set token = encode(extensions.gen_random_bytes(12), 'hex') where token is null;
create unique index if not exists tc_requests_token on ops.tc_requests (token);

create or replace function ops.tc_member()
returns int language sql stable security definer set search_path = '' as $$
  select t.id from public.jag_agents a join ops.team t on t.fub_user_id = a.fub_user_id and t.active
   where a.code = coalesce(ops.s_text('tc_agent_code'), 'rene') limit 1;
$$;
create or replace function ops.member_by_code(p_code text)
returns int language sql stable security definer set search_path = '' as $$
  select t.id from public.jag_agents a join ops.team t on t.fub_user_id = a.fub_user_id and t.active where a.code = p_code limit 1;
$$;

-- "23022 Earlmist Dr · Maria Lopez" / "$280,000 FHA, 3.5% down, $8,400 closing costs"
create or replace function ops.tc_offer_line(o ops.offer_requests)
returns text language sql stable set search_path = '' as $$
  select concat_ws(', ',
    case when nullif(o.terms->>'sales_price', '') is not null then '$' || to_char((o.terms->>'sales_price')::numeric, 'FM999,999,999') end,
    nullif(concat_ws(' ', case lower(coalesce(o.terms->>'loan_type', '')) when 'fha' then 'FHA' when 'va' then 'VA' when 'usda' then 'USDA'
      when 'conventional' then 'Conventional' when 'cash' then 'Cash' else nullif(o.terms->>'loan_type', '') end,
      case when lower(coalesce(o.terms->>'loan_type', '')) <> 'cash' and nullif(o.terms->>'down_payment', '') is not null then (o.terms->>'down_payment') || ' down' end), ''),
    case when coalesce(nullif(regexp_replace(coalesce(o.terms->>'seller_concession', ''), '[^0-9.]', '', 'g'), ''), '0')::numeric > 0
      then '$' || to_char(regexp_replace(o.terms->>'seller_concession', '[^0-9.]', '', 'g')::numeric, 'FM999,999,999') || ' closing costs' end);
$$;

create or replace function ops.tc_text_rene(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $function$
declare r ops.tc_requests; o ops.offer_requests; v_by text; v_tc int := ops.tc_member(); v_body text;
begin
  select * into r from ops.tc_requests where id = p_id;
  if r.id is null or r.offer_request_id is null or v_tc is null then return; end if;
  select * into o from ops.offer_requests where id = r.offer_request_id;
  select split_part(name, ' ', 1) into v_by from ops.team where id = r.member_id;
  v_body := '📝 New offer to prepare' || coalesce(' (from ' || v_by || ')', '') || E'\n'
    || o.property || coalesce(' · ' || nullif(coalesce(r.client_label, o.client_label), ''), '') || E'\n'
    || coalesce(nullif(ops.tc_offer_line(o), '') || E'\n', '')
    || 'Your step-by-step: ' || ops.s_text('tc_page_url') || r.token || E'\n- Lola';
  perform ops.lola_text(v_tc, v_body, 'tc_new', r.id);
  perform ops.kick_team_texts();
end $function$;

create or replace function ops.tc_requests_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if new.offer_request_id is not null then
    begin perform ops.tc_text_rene(new.id); exception when others then null; end;
  end if;
  return null;
end $function$;
create or replace trigger tc_requests_text_rene after insert on ops.tc_requests
  for each row execute function ops.tc_requests_after_insert();

-- not opened 30 min after it was sent → one reminder (during texting hours)
create or replace function ops.tc_nudge()
returns void language plpgsql security definer set search_path = '' as $function$
declare r record; v_tc int := ops.tc_member();
begin
  if v_tc is null or extract(hour from now() at time zone 'America/Chicago') not between 8 and 20 then return; end if;
  for r in
    select q.id, q.token, o.property, coalesce(q.client_label, o.client_label) as client
      from ops.tc_requests q join ops.offer_requests o on o.id = q.offer_request_id
      join ops.team_texts tt on tt.kind = 'tc_new' and tt.ref = q.id and tt.sent_at is not null
     where q.opened_at is null and q.nudged_at is null and q.done_at is null
       and tt.sent_at < now() - interval '30 minutes' and q.created_at > now() - interval '3 days'
  loop
    update ops.tc_requests set nudged_at = now() where id = r.id;
    perform ops.lola_text(v_tc, '⏰ Reminder: the offer on ' || r.property || coalesce(' (' || r.client || ')', '')
      || ' is waiting for you. Start here: ' || ops.s_text('tc_page_url') || r.token || E'\n- Lola', 'tc_nudge', r.id);
  end loop;
end $function$;

-- ---------- the page (anon with the secret link) ----------
create or replace function public.jag_tc_view(p_token text, p_open boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r ops.tc_requests; o ops.offer_requests;
begin
  select * into r from ops.tc_requests where token = btrim(coalesce(p_token, '')) and created_at > now() - interval '60 days';
  if r.id is null or r.offer_request_id is null then return jsonb_build_object('ok', false); end if;
  select * into o from ops.offer_requests where id = r.offer_request_id;
  if p_open and r.opened_at is null then update ops.tc_requests set opened_at = now() where id = r.id; end if;
  return jsonb_build_object('ok', true, 'id', r.id, 'created_at', r.created_at, 'progress', r.progress, 'done_at', r.done_at, 'note', r.steps,
    'by', (select jsonb_build_object('name', t.name, 'first', split_part(t.name, ' ', 1), 'email', a.email)
             from ops.team t left join public.jag_agents a on a.fub_user_id = t.fub_user_id where t.id = r.member_id),
    'tc', (select coalesce(a.first_name, a.name) from public.jag_agents a where a.code = coalesce(ops.s_text('tc_agent_code'), 'rene')),
    'offer', jsonb_build_object('property', o.property, 'mls', o.mls, 'client', coalesce(r.client_label, o.client_label), 'status', o.status,
      'link', ops.offer_link(o), 'missing', ops.offer_missing(o.terms),
      'terms', (select value from ops.settings where key = 'offer_defaults') || o.terms),
    'fub_person_id', coalesce(r.fub_person_id, o.fub_person_id));
end $function$;

create or replace function ops.tc_tell(r ops.tc_requests, p_body text, p_kind text, p_with_jason boolean)
returns void language plpgsql security definer set search_path = '' as $function$
declare v_ids int[]; v_id int; c text;
begin
  v_ids := array[r.member_id];
  for c in select jsonb_array_elements_text(coalesce((select value from ops.settings where key = 'tc_notify_codes'), '[]'::jsonb)) loop
    v_ids := v_ids || ops.member_by_code(c);
  end loop;
  if p_with_jason then v_ids := v_ids || ops.member_by_code('jason'); end if;
  for v_id in select distinct x from unnest(v_ids) x where x is not null and x is distinct from ops.tc_member() loop
    perform ops.lola_text(v_id, p_body, p_kind, r.id);
  end loop;
  perform ops.kick_team_texts();
end $function$;

-- p_step: la_email | skyslope | filled | signatures | sent | fub
create or replace function public.jag_tc_check(p_token text, p_step text, p_done boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r ops.tc_requests; o ops.offer_requests; v_was boolean; v_tc text; v_all boolean; v_who text;
begin
  if p_step not in ('la_email', 'skyslope', 'filled', 'signatures', 'sent', 'fub') then return jsonb_build_object('ok', false); end if;
  select * into r from ops.tc_requests where token = btrim(coalesce(p_token, '')) and created_at > now() - interval '60 days' for update;
  if r.id is null then return jsonb_build_object('ok', false); end if;
  select * into o from ops.offer_requests where id = r.offer_request_id;
  v_was := r.progress ? p_step;
  update ops.tc_requests set progress = case when p_done then progress || jsonb_build_object(p_step, now()) else progress - p_step end,
         opened_at = coalesce(opened_at, now())
   where id = r.id returning * into r;
  v_all := (select bool_and(r.progress ? s) from unnest(array['la_email', 'skyslope', 'filled', 'signatures', 'sent', 'fub']) s);
  update ops.tc_requests set done_at = case when v_all then coalesce(done_at, now()) else null end where id = r.id returning * into r;
  if p_done and not v_was then
    select coalesce(a.first_name, a.name, 'The TC') into v_tc from public.jag_agents a where a.code = coalesce(ops.s_text('tc_agent_code'), 'rene');
    v_who := coalesce(' (' || nullif(coalesce(r.client_label, o.client_label), '') || ')', '');
    if p_step = 'signatures' then
      perform ops.tc_tell(r, '✍️ ' || v_tc || ' sent the offer on ' || o.property || v_who || ' to the client for signatures. - Lola', 'tc_sign', false);
    elsif p_step = 'sent' then
      update ops.offer_requests set status = 'sent', sent_at = coalesce(sent_at, now()), updated_at = now()
       where id = o.id and coalesce(status, '') in ('', 'new', 'drafting');
      perform ops.tc_tell(r, '🎉 The offer on ' || o.property || v_who || ' is out to the listing agent. Sent by ' || v_tc || '. - Lola', 'tc_sent', true);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'progress', r.progress, 'done_at', r.done_at);
end $function$;

-- what the listing agent sent: title company, seller names (go straight into the offer)
create or replace function public.jag_tc_fill(p_token text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r ops.tc_requests; v jsonb := '{}'::jsonb; k text;
begin
  select * into r from ops.tc_requests where token = btrim(coalesce(p_token, '')) and created_at > now() - interval '60 days';
  if r.id is null or r.offer_request_id is null then return jsonb_build_object('ok', false); end if;
  foreach k in array array['title_company', 'seller_names', 'listing_agent_email', 'listing_agent_phone'] loop
    if nullif(btrim(coalesce(p->>k, '')), '') is not null then v := v || jsonb_build_object(k, left(btrim(p->>k), 200)); end if;
  end loop;
  update ops.offer_requests set terms = terms || v, updated_at = now() where id = r.offer_request_id;
  return jsonb_build_object('ok', true, 'missing', (select ops.offer_missing(terms) from ops.offer_requests where id = r.offer_request_id));
end $function$;

create or replace function public.jag_tc_stuck(p_token text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r ops.tc_requests; o ops.offer_requests; v_tc text;
begin
  select * into r from ops.tc_requests where token = btrim(coalesce(p_token, '')) and created_at > now() - interval '60 days';
  if r.id is null then return jsonb_build_object('ok', false); end if;
  if r.stuck_at > now() - interval '10 minutes' then return jsonb_build_object('ok', true, 'again', true); end if;
  select * into o from ops.offer_requests where id = r.offer_request_id;
  update ops.tc_requests set stuck_at = now() where id = r.id;
  select coalesce(a.first_name, a.name, 'The TC') into v_tc from public.jag_agents a where a.code = coalesce(ops.s_text('tc_agent_code'), 'rene');
  -- Jason + the agent who sent it, right away (even at night)
  perform ops.lola_text(x, '🆘 ' || v_tc || ' is stuck on the offer for ' || o.property || coalesce(' (' || coalesce(r.client_label, o.client_label) || ')', '')
      || coalesce(': "' || left(nullif(btrim(p_note), ''), 300) || '"', '') || E'\nChecklist: ' || ops.s_text('tc_page_url') || r.token || E'\n- Lola', 'tc_stuck', r.id, true)
    from (select distinct x from unnest(array[ops.member_by_code('jason'), r.member_id]) x where x is not null and x is distinct from ops.tc_member()) s;
  perform ops.kick_team_texts();
  return jsonb_build_object('ok', true);
end $function$;

revoke all on function public.jag_tc_view(text, boolean), public.jag_tc_check(text, text, boolean), public.jag_tc_fill(text, jsonb), public.jag_tc_stuck(text, text) from public;
grant execute on function public.jag_tc_view(text, boolean), public.jag_tc_check(text, text, boolean), public.jag_tc_fill(text, jsonb), public.jag_tc_stuck(text, text) to anon, authenticated;
revoke all on function ops.lola_text(int, text, text, bigint, boolean), ops.kick_team_texts(), ops.tc_text_rene(bigint), ops.tc_nudge(),
  ops.tc_tell(ops.tc_requests, text, text, boolean) from public, anon, authenticated;

-- email + Agent Hub get the checklist link and progress
create or replace function public.jag_tc_mine()
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_member int; v jsonb;
begin
  if not coalesce(public.jag_is_team(), false) then return jsonb_build_object('ok', false); end if;
  v_member := ops.team_member_me();
  select coalesce(jsonb_agg(x order by (x->>'id')::bigint desc), '[]'::jsonb) into v from (
    select jsonb_build_object('id', r.id, 'created_at', r.created_at, 'sent_at', r.sent_at, 'failed', r.sent_at is null and r.tries > 0,
      'property', o.property, 'mls', o.mls, 'client', coalesce(r.client_label, o.client_label), 'price', o.terms->>'sales_price',
      'link', ops.offer_link(o), 'missing', ops.offer_missing(o.terms), 'checklist', ops.s_text('tc_page_url') || r.token,
      'opened_at', r.opened_at, 'progress', r.progress, 'done_at', r.done_at) as x
    from ops.tc_requests r join ops.offer_requests o on o.id = r.offer_request_id
    where r.member_id = v_member order by r.id desc limit 15) s;
  return jsonb_build_object('ok', true, 'rows', v);
end $function$;

create or replace function public.ops_tc_payload(p_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ok', r.id is not null, 'id', r.id, 'title', r.title, 'steps', r.steps, 'via', r.via, 'client', r.client_label,
    'fub_person_id', r.fub_person_id, 'sent_at', r.sent_at, 'checklist', ops.s_text('tc_page_url') || r.token,
    'by', (select jsonb_build_object('name', t.name, 'first', coalesce(a.first_name, split_part(t.name, ' ', 1)), 'email', a.email, 'fub_user_id', t.fub_user_id)
             from ops.team t left join public.jag_agents a on a.fub_user_id = t.fub_user_id where t.id = r.member_id),
    'tc', (select jsonb_build_object('name', a.name, 'first', coalesce(a.first_name, split_part(a.name, ' ', 1)), 'email', a.email,
                    'fub_user_id', a.fub_user_id, 'lang', coalesce(t.language, 'en'))
             from public.jag_agents a left join ops.team t on t.fub_user_id = a.fub_user_id
            where a.code = coalesce(ops.s_text('tc_agent_code'), 'rene')),
    'tc_to', (select coalesce(jsonb_agg(jsonb_build_object('email', lower(e),
                'first', (select coalesce(a.first_name, a.name) from public.jag_agents a where lower(a.email) = lower(e) limit 1))), '[]'::jsonb)
              from jsonb_array_elements_text(coalesce((select value from ops.settings where key = 'tc_emails'), '[]'::jsonb)) e),
    'offer', case when o.id is null then null else jsonb_build_object('id', o.id, 'property', o.property, 'mls', o.mls, 'client', o.client_label,
                    'fub_person_id', o.fub_person_id, 'link', ops.offer_link(o), 'missing', ops.offer_missing(o.terms),
                    'terms', (select value from ops.settings where key = 'offer_defaults') || o.terms) end)
  from ops.tc_requests r left join ops.offer_requests o on o.id = r.offer_request_id
  where r.id = p_id;
$$;

select cron.schedule('jag-team-texts', '*/2 * * * *', 'select ops.kick_team_texts()');
