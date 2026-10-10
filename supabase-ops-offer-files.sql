-- JAG offer drafts: keep the PDFs of every sent offer for the admin Deals tab.
-- Run once in Supabase (jag-crm) → SQL Editor → New query → paste → Run. Safe to run again.
--
-- What it does:
--   1. A PRIVATE storage bucket "offer-files" (PDFs only, 15 MB max each). Nothing in it is public.
--   2. The offer draft page can add PDFs only inside its own offer's folder (offer-files/<offer token>/...),
--      and only while that offer's link is valid. It cannot read, list, change or delete anything.
--   3. Signed-in team logins (the admin page) can open the files through short-lived signed links.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('offer-files', 'offer-files', false, 15728640, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "offer files: upload with offer token" on storage.objects;
create policy "offer files: upload with offer token" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'offer-files'
              and public.ops_offer_token_ok((storage.foldername(name))[1])
              and lower(storage.extension(name)) = 'pdf');

drop policy if exists "offer files: team can read" on storage.objects;
create policy "offer files: team can read" on storage.objects
  for select to authenticated
  using (bucket_id = 'offer-files');

-- Check: should return 1 bucket and 2 policies.
select (select count(*) from storage.buckets where id = 'offer-files' and not public) as private_bucket,
       (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
          and policyname like 'offer files:%') as policies;
