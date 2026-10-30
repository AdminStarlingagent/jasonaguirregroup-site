-- ============================================================
-- Website lead emails stay inside JAG (no Web3Forms / admin@starlingagent.com).
-- jag_leads insert → ops.kick_lead_email → jag-client-email 'lead_alert' (Resend, from updates.jasonhoustonrealty.com).
-- Recipients: ops.settings 'lead_emails' = {default:[…], <lead type>:[…]} (JAG domains only; the function drops anything else).
-- Types: loan applications, home value, listing intake, intake buyer offers, home inquiries. /offer offers have their own email.
-- ============================================================
insert into ops.settings (key, value) values ('lead_emails', jsonb_build_object(
  'default', jsonb_build_array('jason.aguirre@jasonhoustonrealty.com'),
  'Mortgage Application', jsonb_build_array('jason.aguirre@jasonhoustonrealty.com', 'kat@jasonhoustonrealty.com')))
on conflict (key) do nothing;

create or replace function ops.kick_lead_email(p_id uuid, p_type text)
returns bigint language plpgsql security definer set search_path to '' as $$
declare v_tok text; v_req bigint; v_cfg jsonb; v_to jsonb;
begin
  select value into v_cfg from ops.settings where key = 'lead_emails';
  v_to := coalesce(v_cfg->p_type, v_cfg->'default', '["jason.aguirre@jasonhoustonrealty.com"]'::jsonb);
  select decrypted_secret into v_tok from vault.decrypted_secrets where name = 'jag_alerts_token';
  select net.http_post(url := 'https://nyaxywghbpphjhwcmspd.supabase.co/functions/v1/jag-client-email',
    body := jsonb_build_object('kind', 'lead_alert', 'id', p_id::text, 'to', v_to),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jag-token', v_tok), timeout_milliseconds := 8000) into v_req;
  return v_req;
end $$;
revoke all on function ops.kick_lead_email(uuid, text) from public, anon, authenticated;

create or replace function public.jag_leads_email_trg()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.type in ('Mortgage Application', 'Home Value', 'Seller Listing', 'home-search')
     or (new.type = 'Buyer Offer' and coalesce(new.source, '') !~ '^/offer(\.html)?([?#]|$)') then
    perform ops.kick_lead_email(new.id, new.type);
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists jag_leads_email on public.jag_leads;
create trigger jag_leads_email after insert on public.jag_leads for each row execute function public.jag_leads_email_trg();
