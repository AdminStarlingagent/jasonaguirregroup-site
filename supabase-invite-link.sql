-- ============================================================
-- Each agent's own invite link: https://jasonaguirregroup.company/join?a=<agent code>
--   Same link every time, no name to fill in. Forward it to one person or fifty, paste it in any chat.
--   The client types their own name, email and cell on /join, gets an email code, and their account is tied to
--   that agent (unless they already belong to another agent: the existing owner keeps them).
--   The agent gets the same bell notification + Lola text as a personal invite, and the client shows up in Contacts
--   with "Invite from <agent>" (a joined jag_invites row with channel 'link').
-- Anon:   jag_link_public(code, count)  → the agent's public card for /join; counts an open (not for team browsers)
-- Client: jag_link_join(code)           → ties the new account to the agent, notifies them
-- Agent:  jag_my_invite_link()          → their link + opens / joins
-- ============================================================
create table if not exists public.jag_invite_links (
  agent_code text primary key references public.jag_agents(code) on update cascade on delete cascade,
  opens int not null default 0,
  joins int not null default 0,
  last_open_at timestamptz,
  last_join_at timestamptz
);
alter table public.jag_invite_links enable row level security;

create or replace function public.jag_link_public(p_code text, p_count boolean default true)
returns json language plpgsql security definer set search_path to '' as $$
declare a public.jag_agents;
begin
  select * into a from public.jag_agents where active and code = lower(btrim(coalesce(p_code, '')));
  if a.code is null then return json_build_object('ok', false); end if;
  if p_count then
    insert into public.jag_invite_links (agent_code, opens, last_open_at) values (a.code, 1, now())
    on conflict (agent_code) do update set opens = public.jag_invite_links.opens + 1, last_open_at = now();
  end if;
  return json_build_object('ok', true, 'agent', json_build_object('code', a.code, 'name', a.name, 'first_name', a.first_name,
    'phone', coalesce(a.phone_override, a.phone), 'photo_url', a.photo_url));
end $$;

create or replace function public.jag_link_join(p_code text)
returns json language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := auth.uid(); c public.jag_clients; a public.jag_agents; g public.jag_agents; v_inv uuid; v_name text;
begin
  if v_uid is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  select * into a from public.jag_agents where active and code = lower(btrim(coalesce(p_code, '')));
  if a.code is null then return json_build_object('ok', false, 'reason', 'agent'); end if;
  select * into c from public.jag_clients where user_id = v_uid;
  if c.user_id is null then return json_build_object('ok', false, 'reason', 'no_account'); end if;

  -- no agent yet → this link's agent. Already someone's client → they stay with that agent.
  if c.agent_code is null then
    update public.jag_clients set agent_code = a.code, agent_set_at = now() where user_id = v_uid returning * into c;
  end if;
  select * into g from public.jag_agents where code = coalesce(c.agent_code, a.code);

  -- first time only (a personal invite may already have matched them)
  if c.agent_code = a.code and not exists (select 1 from public.jag_invites where user_id = v_uid) then
    insert into public.jag_invites (agent_code, created_by, name, email, phone, lang, note, channel, status, user_id, joined_at)
    values (a.code, null, c.name, c.email, c.phone, coalesce(c.lang, 'es'), 'Joined from the invite link', 'link', 'joined', v_uid, now())
    returning id into v_inv;
    insert into public.jag_invite_links (agent_code, joins, last_join_at) values (a.code, 1, now())
    on conflict (agent_code) do update set joins = public.jag_invite_links.joins + 1, last_join_at = now();
    v_name := coalesce(c.name, c.email, 'A new client');
    perform public.jag_notify_agent(a.code, 'joined', v_name || ' joined from your invite link 🎉',
      'They are in your Contacts now. Next step: screen them or send homes.', v_uid, v_inv,
      '🎉 ' || v_name || ' just created their JAG account from your invite link. They''re in your Contacts. Strike while it''s hot: https://jasonaguirregroup.company/workspace#hub');
  end if;

  return json_build_object('ok', true, 'agent', json_build_object('code', g.code, 'name', g.name, 'first_name', g.first_name,
    'phone', coalesce(g.phone_override, g.phone), 'photo_url', g.photo_url));
end $$;

create or replace function public.jag_my_invite_link()
returns json language plpgsql stable security definer set search_path to '' as $$
declare v_code text := public.jag_agent_code_me(); s public.jag_invite_links;
begin
  if v_code is null or not exists (select 1 from public.jag_agents where code = v_code and active) then return json_build_object('ok', false); end if;
  select * into s from public.jag_invite_links where agent_code = v_code;
  return json_build_object('ok', true, 'code', v_code, 'url', 'https://jasonaguirregroup.company/join?a=' || v_code,
    'opens', coalesce(s.opens, 0), 'joins', coalesce(s.joins, 0), 'last_join_at', s.last_join_at);
end $$;

revoke all on function public.jag_link_public(text, boolean), public.jag_link_join(text), public.jag_my_invite_link() from public;
grant execute on function public.jag_link_public(text, boolean) to anon, authenticated;
grant execute on function public.jag_link_join(text), public.jag_my_invite_link() to authenticated;
