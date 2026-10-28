-- ============================================================
-- "Tell Lola about an offer" (Agent Hub → Offers). The showing agent answers Lola's questions (the same ones
-- as "Begin offer"), Lola pulls the listing from HAR, and the hand-off email goes to Katherine and the TC
-- (closings@) with the listing, the offer, SkySlope steps and a ready-to-send email to the listing agent
-- asking for the title company and seller names. (applied as migration jag_lola_offer, 2026-10-27)
-- ============================================================

-- who gets offer hand-off emails (the agent who sent it is copied)
insert into ops.settings (key, value, note)
values ('tc_emails', '["closings@jasonhoustonrealty.com","kat@jasonhoustonrealty.com"]'::jsonb,
        'Who gets offer hand-off emails (Lola offer intake and Send to TC). The agent who sent it is copied.')
on conflict (key) do nothing;

-- one call from the Agent Hub: create the offer draft + hand it to Katherine and the TC
-- p: { address, mls, client, terms:{…TREC keys…}, note }
create or replace function public.jag_lola_offer(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r jsonb; s jsonb; v_member int;
begin
  if not coalesce(public.jag_is_team(), false) then return jsonb_build_object('ok', false, 'reason', 'not_team'); end if;
  r := public.jag_offer_start(p);
  if not coalesce((r->>'ok')::boolean, false) then return r; end if;
  v_member := coalesce(ops.team_member_me(), (select id from ops.team where role = 'lead' and active order by id limit 1));
  s := ops.tc_queue(v_member, (r->>'offer_request_id')::bigint, null, null, null, left(nullif(btrim(coalesce(p->>'note', '')), ''), 4000), 'lola');
  return r || jsonb_build_object('tc_ok', coalesce((s->>'ok')::boolean, false),
    'to', (select coalesce(jsonb_agg(coalesce((select coalesce(a.first_name, a.name) from public.jag_agents a where lower(a.email) = lower(e) limit 1), 'the TC')), '[]'::jsonb)
             from jsonb_array_elements_text(coalesce((select value from ops.settings where key = 'tc_emails'), '[]'::jsonb)) e));
end $function$;
revoke all on function public.jag_lola_offer(jsonb) from public, anon;
grant execute on function public.jag_lola_offer(jsonb) to authenticated;

-- the offers this agent handed to the TC (Agent Hub → Offers → "Sent to the TC")
create or replace function public.jag_tc_mine()
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_member int; v jsonb;
begin
  if not coalesce(public.jag_is_team(), false) then return jsonb_build_object('ok', false); end if;
  v_member := ops.team_member_me();
  select coalesce(jsonb_agg(x order by (x->>'id')::bigint desc), '[]'::jsonb) into v from (
    select jsonb_build_object('id', r.id, 'created_at', r.created_at, 'sent_at', r.sent_at, 'failed', r.sent_at is null and r.tries > 0,
      'property', o.property, 'mls', o.mls, 'client', coalesce(r.client_label, o.client_label), 'price', o.terms->>'sales_price',
      'link', ops.offer_link(o), 'missing', ops.offer_missing(o.terms)) as x
    from ops.tc_requests r join ops.offer_requests o on o.id = r.offer_request_id
    where r.member_id = v_member order by r.id desc limit 15) s;
  return jsonb_build_object('ok', true, 'rows', v);
end $function$;
revoke all on function public.jag_tc_mine() from public, anon;
grant execute on function public.jag_tc_mine() to authenticated;

-- edge function jag-offer-tc: who the offer email goes to
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
    'tc_to', (select coalesce(jsonb_agg(jsonb_build_object('email', lower(e),
                'first', (select coalesce(a.first_name, a.name) from public.jag_agents a where lower(a.email) = lower(e) limit 1))), '[]'::jsonb)
              from jsonb_array_elements_text(coalesce((select value from ops.settings where key = 'tc_emails'), '[]'::jsonb)) e),
    'offer', case when o.id is null then null else jsonb_build_object('id', o.id, 'property', o.property, 'mls', o.mls, 'client', o.client_label,
                    'fub_person_id', o.fub_person_id, 'link', ops.offer_link(o), 'missing', ops.offer_missing(o.terms),
                    'terms', (select value from ops.settings where key = 'offer_defaults') || o.terms) end)
  from ops.tc_requests r left join ops.offer_requests o on o.id = r.offer_request_id
  where r.id = p_id;
$$;
