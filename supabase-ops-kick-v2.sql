-- JAG Ops: wake the watchdog for new JAG Loans applications too.
-- Run once in Supabase (jag-crm) → SQL Editor → New query → paste → Run.
-- Safe to run again. No secrets in this file: the watchdog secret stays in Vault.
--
-- Before: Supabase only pinged n8n when a Speed-to-Lead check or overflow alert was due.
-- After:  it also pings when a Mortgage Application is waiting (business hours only),
--         so the "who last worked this client" text goes out within a minute.

create or replace function ops.kick() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text := ops.s_text('watchdog_url'); v_secret text; v_req bigint;
begin
  if not ops.s_bool('enabled') or coalesce(v_url, '') = '' then return; end if;
  if exists (select 1 from ops.kicks where created_at > now() - interval '50 seconds') then return; end if;
  if not exists (select 1 from ops.checks
                  where status in ('pending','alerting') and next_action_at <= now()
                    and (claimed_at is null or claimed_at < now() - interval '5 minutes'))
     and not ops.overflow_due() and not ops.apps_due() then
    return;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'jag_ops_watchdog_secret';
  select net.http_post(url := v_url, body := jsonb_build_object('source', 'jag-ops-kick', 'at', now()),
           headers := jsonb_build_object('Content-Type', 'application/json', 'X-JAG-Ops-Secret', v_secret),
           timeout_milliseconds := 5000) into v_req;
  insert into ops.kicks (request_id) values (v_req);
  delete from ops.kicks where created_at < now() - interval '3 days';
end $$;

revoke execute on function ops.kick() from public, anon, authenticated;

-- Check: should return true.
select position('apps_due' in pg_get_functiondef('ops.kick()'::regprocedure)) > 0 as kick_includes_applications;
