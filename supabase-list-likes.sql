-- ============================================================
-- Hearts on an agent's list (lista ❤️ / "want to see it") also land in the client's Liked homes (jag_client_favorites),
-- so the account, the agent profile and price/status alerts all see them. Un-hearting removes it only if it came from the list.
-- The account: the list's linked account, else the client account with the list's email, else its phone.
-- ============================================================
create or replace function public.jag_cart_account(c public.jag_carts)
returns uuid language sql stable security definer set search_path to '' as $$
  select coalesce(c.user_id,
    (select k.user_id from public.jag_clients k where c.email is not null and lower(k.email) = lower(c.email) limit 1),
    (select k.user_id from public.jag_clients k where length(right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10)) = 10
        and right(regexp_replace(coalesce(k.phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(c.phone, '\D', '', 'g'), 10)
      order by k.last_seen_at desc nulls last limit 1));
$$;
revoke all on function public.jag_cart_account(public.jag_carts) from public, anon, authenticated;

create or replace function public.jag_cart_fav_sync(c public.jag_carts, h public.jag_cart_homes)
returns void language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := public.jag_cart_account(c);
begin
  if v_uid is null then return; end if;
  if h.reaction in ('love', 'tour') then
    insert into public.jag_client_favorites (user_id, mls, snap, last_price, last_status, saved_at)
    values (v_uid, h.mls, coalesce(h.snap, '{}'::jsonb) || jsonb_build_object('via', 'list', 'cart', c.id), nullif(h.snap->>'price', '')::numeric, null, now())
    on conflict (user_id, mls) do nothing;
  else
    delete from public.jag_client_favorites f where f.user_id = v_uid and f.mls = h.mls and f.snap->>'via' = 'list';
  end if;
end $$;
revoke all on function public.jag_cart_fav_sync(public.jag_carts, public.jag_cart_homes) from public, anon, authenticated;

create or replace function public.jag_cart_react(p_token text, p_mls text, p_reaction text, p_note text DEFAULT NULL::text)
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
declare c public.jag_carts; h public.jag_cart_homes; v_member int; v_addr text; v_prev text;
begin
  if p_reaction is not null and p_reaction not in ('love', 'maybe', 'no', 'tour') then return json_build_object('ok', false); end if;
  select * into c from public.jag_carts where token = p_token and not archived;
  if not found then return json_build_object('ok', false); end if;
  select reaction into v_prev from public.jag_cart_homes where cart_id = c.id and mls = p_mls;
  update public.jag_cart_homes set reaction = p_reaction, reacted_at = now(),
         client_note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 400), ''), client_note)
   where cart_id = c.id and mls = p_mls returning * into h;
  if h.mls is null then return json_build_object('ok', false); end if;
  update public.jag_carts set updated_at = now() where id = c.id;
  perform public.jag_cart_fav_sync(c, h);   -- into their Liked homes
  if p_reaction in ('love', 'tour') and v_prev is distinct from p_reaction then
    v_addr := coalesce(nullif(h.snap->>'addr', ''), 'MLS ' || h.mls) || coalesce(' ($' || to_char((h.snap->>'price')::numeric, 'FM999,999,999') || ')', '');
    select t.id into v_member from public.jag_agents ag join ops.team t on t.fub_user_id = ag.fub_user_id and t.active where ag.code = c.agent_code;
    if v_member is not null then
      perform ops.lola_text(v_member,
        case when p_reaction = 'tour' then '🏃‍♀️ ' || c.name || ' wants to SEE ' || v_addr || '. Book the showing before someone else does!'
             else '😍 ' || c.name || ' loves ' || v_addr || '. Call while it''s hot, girl.' end
        || coalesce(' Note: "' || left(btrim(p_note), 160) || '"', '')
        || ' https://jasonaguirregroup.company/matrix#cart=' || c.id, 'cart_react', null);
      perform ops.kick_team_texts();
    end if;
  end if;
  return json_build_object('ok', true);
end $function$;

-- backfill: hearts already given on lists
do $$ declare r record; begin
  for r in select c, h from public.jag_carts c join public.jag_cart_homes h on h.cart_id = c.id where h.reaction in ('love', 'tour') loop
    perform public.jag_cart_fav_sync(r.c, r.h);
  end loop;
end $$;
