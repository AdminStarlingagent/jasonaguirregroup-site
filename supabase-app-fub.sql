-- Home Loan application → Follow Up Boss stage "Applied" (edge function jag-app-fub). (applied as migration jag_app_fub, 2026-10-27)
-- Early-stage clients move to Applied; clients already Applied or further along keep their stage. New clients are created in
-- the Calls pond, stage Applied, #starling_stop. Catch-up of older applications: { backfill: true } in batches.
alter table public.jag_leads add column if not exists fub_app_at timestamptz;
alter table public.jag_leads add column if not exists fub_app_result text;

create or replace function public.jag_app_to_fub()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_tok text;
begin
  if new.type = 'Mortgage Application' and coalesce(new.status, '') <> 'Merged' then
    select decrypted_secret into v_tok from vault.decrypted_secrets where name = 'jag_alerts_token';
    perform net.http_post(url := 'https://nyaxywghbpphjhwcmspd.supabase.co/functions/v1/jag-app-fub',
      body := jsonb_build_object('id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-jag-token', v_tok), timeout_milliseconds := 30000);
  end if;
  return null;
exception when others then return null;  -- never block an application
end $function$;

create or replace trigger jag_leads_app_to_fub after insert on public.jag_leads
  for each row execute function public.jag_app_to_fub();
