-- Website chat: one row per visitor conversation + its messages. Only n8n (service role) and staff read them.
create table if not exists public.jag_chat_sessions (
  session_id text primary key check (char_length(session_id) <= 80),
  name text, phone text, lang text, page text, listing jsonb, agent_code text,
  lead_type text, call_requested boolean not null default false, preferred_time text, summary text,
  turns int not null default 0, fub_person_id bigint,
  team_alerted_at timestamptz, call_alerted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.jag_chat_messages (
  id bigserial primary key,
  session_id text not null references public.jag_chat_sessions(session_id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists jag_chat_messages_session_idx on public.jag_chat_messages(session_id, id);
alter table public.jag_chat_sessions enable row level security;
alter table public.jag_chat_messages enable row level security;
drop policy if exists "staff read chat sessions" on public.jag_chat_sessions;
create policy "staff read chat sessions" on public.jag_chat_sessions for select to authenticated using (public.jag_is_staff());
drop policy if exists "staff read chat messages" on public.jag_chat_messages;
create policy "staff read chat messages" on public.jag_chat_messages for select to authenticated using (public.jag_is_staff());

-- start of a turn: upsert the session, store the visitor's message, return history (oldest first)
create or replace function public.jag_chat_turn(p jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare v_id text := left(p->>'sessionId', 80); s public.jag_chat_sessions;
begin
  if v_id is null or v_id = '' then return json_build_object('ok', false, 'reason', 'no_session'); end if;
  insert into public.jag_chat_sessions (session_id, name, phone, lang, page, listing, agent_code)
  values (v_id, left(p->>'name', 120), left(p->>'phone', 20), left(p->>'lang', 5), left(p->>'page', 300),
          case when jsonb_typeof(p->'listing') = 'object' then p->'listing' end, left(p->>'agent_code', 30))
  on conflict (session_id) do update set
    name = coalesce(excluded.name, jag_chat_sessions.name), phone = coalesce(excluded.phone, jag_chat_sessions.phone),
    lang = coalesce(excluded.lang, jag_chat_sessions.lang), page = coalesce(excluded.page, jag_chat_sessions.page),
    listing = coalesce(excluded.listing, jag_chat_sessions.listing), agent_code = coalesce(jag_chat_sessions.agent_code, excluded.agent_code),
    turns = jag_chat_sessions.turns + 1, updated_at = now()
  returning * into s;
  return json_build_object('ok', true, 'session', row_to_json(s),
    'history', coalesce((select json_agg(json_build_object('role', m.role, 'text', m.text) order by m.id) from (select id, role, text from public.jag_chat_messages
       where session_id = v_id order by id desc limit 24) m), '[]'::json));
end $$;

-- end of a turn: store both messages and what the AI learned
create or replace function public.jag_chat_save(p jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare v_id text := left(p->>'sessionId', 80);
begin
  insert into public.jag_chat_messages (session_id, role, text) values (v_id, 'user', left(p->>'message', 2000));
  if coalesce(p->>'reply', '') <> '' then
    insert into public.jag_chat_messages (session_id, role, text) values (v_id, 'assistant', left(p->>'reply', 4000));
  end if;
  update public.jag_chat_sessions set
    lead_type = coalesce(nullif(p->>'lead_type', ''), lead_type),
    call_requested = call_requested or coalesce((p->>'call_requested')::boolean, false),
    preferred_time = coalesce(nullif(p->>'preferred_time', ''), preferred_time),
    summary = coalesce(nullif(p->>'summary', ''), summary),
    fub_person_id = coalesce((nullif(p->>'fub_person_id', ''))::bigint, fub_person_id),
    team_alerted_at = case when coalesce((p->>'team_alerted')::boolean, false) then coalesce(team_alerted_at, now()) else team_alerted_at end,
    call_alerted_at = case when coalesce((p->>'call_alerted')::boolean, false) then coalesce(call_alerted_at, now()) else call_alerted_at end,
    updated_at = now()
  where session_id = v_id;
  return json_build_object('ok', true);
end $$;

revoke all on function public.jag_chat_turn(jsonb) from public, anon, authenticated;
revoke all on function public.jag_chat_save(jsonb) from public, anon, authenticated;
grant execute on function public.jag_chat_turn(jsonb), public.jag_chat_save(jsonb) to service_role;
