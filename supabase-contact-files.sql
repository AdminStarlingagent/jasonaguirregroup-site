-- ============================================================
-- Files on a contact's profile (Agent Hub → contact → Files card).
-- The team uploads documents for any contact (pay stubs, IDs, pre-approval letters, contracts…).
-- Private bucket "contact-files", path <contact id>/<time>-<name>. Only team members who can see the contact can
-- upload or open them (same rule as the profile: jag_contact_visible). Removing hides the file (kept for the record).
-- The client's own uploads (pre-approval / proof of funds, bucket client-proof) also show on the card.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('contact-files', 'contact-files', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

create table if not exists public.jag_contact_files (
  id          bigint generated always as identity primary key,
  contact_id  uuid not null references public.jag_contacts(id) on delete cascade,
  path        text not null unique,
  file_name   text not null,
  mime        text,
  size        bigint,
  label       text,
  uploaded_by text,
  uploaded_at timestamptz not null default now(),
  removed_at  timestamptz,
  removed_by  text
);
create index if not exists jag_contact_files_contact on public.jag_contact_files (contact_id, uploaded_at desc);
alter table public.jag_contact_files enable row level security;

-- the first folder of a storage path, as a contact id (null if it isn't one)
create or replace function public.jag_path_contact(p_name text)
returns uuid language plpgsql immutable set search_path to '' as $$
declare v text := split_part(p_name, '/', 1);
begin
  if v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return v::uuid; end if;
  return null;
end $$;

drop policy if exists "contact files: team uploads" on storage.objects;
create policy "contact files: team uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'contact-files' and public.jag_is_team() and public.jag_contact_visible(public.jag_path_contact(name)));
drop policy if exists "contact files: team reads" on storage.objects;
create policy "contact files: team reads" on storage.objects for select to authenticated
  using (bucket_id = 'contact-files' and public.jag_is_team() and public.jag_contact_visible(public.jag_path_contact(name)));

-- list: team files + the client's own uploads
create or replace function public.jag_contact_files(p_contact uuid)
returns json language plpgsql stable security definer set search_path to '' as $$
declare c public.jag_contacts;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_contacts where id = public.jag_cid(p_contact);
  if c.id is null then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  if not public.jag_contact_visible(c.id) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  return json_build_object('ok', true,
    'files', coalesce((select json_agg(f order by f.uploaded_at desc) from (
        select id, path, file_name, mime, size, label, uploaded_by, uploaded_at, 'contact-files' as bucket
          from public.jag_contact_files where contact_id = c.id and removed_at is null) f), '[]'::json),
    'client', coalesce((select json_agg(p order by p.uploaded_at desc) from (
        select id, kind, path, file_name, status, uploaded_at, 'client-proof' as bucket
          from public.jag_client_proof where c.user_id is not null and user_id = c.user_id) p), '[]'::json));
end $$;

create or replace function public.jag_contact_file_add(p_contact uuid, p_path text, p_name text, p_mime text, p_size bigint, p_label text default null)
returns json language plpgsql security definer set search_path to '' as $$
declare c public.jag_contacts; v_id bigint;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into c from public.jag_contacts where id = public.jag_cid(p_contact);
  if c.id is null or not public.jag_contact_visible(c.id) then return json_build_object('ok', false, 'reason', 'not_yours'); end if;
  if public.jag_path_contact(p_path) is distinct from c.id then return json_build_object('ok', false, 'reason', 'bad_path'); end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'contact-files' and o.name = p_path) then
    return json_build_object('ok', false, 'reason', 'not_uploaded'); end if;
  insert into public.jag_contact_files (contact_id, path, file_name, mime, size, label, uploaded_by)
  values (c.id, p_path, left(coalesce(nullif(btrim(p_name), ''), 'file'), 200), left(p_mime, 120), p_size,
          nullif(left(btrim(coalesce(p_label, '')), 80), ''), public.jag_agent_code_me())
  on conflict (path) do nothing returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.jag_contact_file_remove(p_id bigint)
returns json language plpgsql security definer set search_path to '' as $$
declare f public.jag_contact_files;
begin
  if not public.jag_is_team() then return json_build_object('ok', false, 'reason', 'not_team'); end if;
  select * into f from public.jag_contact_files where id = p_id and removed_at is null;
  if f.id is null or not public.jag_contact_visible(f.contact_id) then return json_build_object('ok', false, 'reason', 'not_found'); end if;
  update public.jag_contact_files set removed_at = now(), removed_by = public.jag_agent_code_me() where id = p_id;
  return json_build_object('ok', true);
end $$;

revoke all on function public.jag_contact_files(uuid), public.jag_contact_file_add(uuid, text, text, text, bigint, text), public.jag_contact_file_remove(bigint) from public, anon;
grant execute on function public.jag_contact_files(uuid), public.jag_contact_file_add(uuid, text, text, text, bigint, text), public.jag_contact_file_remove(bigint) to authenticated;
grant execute on function public.jag_path_contact(text) to authenticated;
