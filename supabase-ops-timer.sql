-- =====================================================================
-- JAG Ops · Phase 1 timer  —  JASON RUNS THIS ONCE in Supabase SQL Editor
-- Project: jag-crm.  Safe to run more than once.
--
-- What it does:
--   * makes a random secret in Supabase Vault (jag_ops_watchdog_secret).
--     The database sends it in the X-JAG-Ops-Secret header so the n8n
--     Watchdog only answers calls from your database.
--   * every minute, checks for overdue speed-to-lead checks and, only when
--     there is work AND the system is switched on, pings the n8n Watchdog.
--     With enabled = false or no watchdog_url it does nothing at all.
--
-- After running it:
--   1. Copy the secret into the n8n Watchdog's "Check secret" node:
--        select decrypted_secret from vault.decrypted_secrets
--         where name = 'jag_ops_watchdog_secret';
--      (Paste it into n8n only. Do not put it in this repo, email or chat.)
--   2. Once the Watchdog workflow is published, save its production URL:
--        update ops.settings set value = to_jsonb('https://YOUR-N8N/webhook/jag-ops-watchdog'::text)
--         where key = 'watchdog_url';
--   3. Go-live (only after the test plan passes):
--        update ops.settings set value = 'true' where key = 'enabled';
--      Kill switch any time:
--        update ops.settings set value = 'false' where key = 'enabled';
-- =====================================================================

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'jag_ops_watchdog_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'jag_ops_watchdog_secret',
      'Header X-JAG-Ops-Secret that the database sends to the n8n Watchdog webhook');
  end if;
end $$;

create table if not exists ops.kicks (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  request_id bigint
);
alter table ops.kicks enable row level security;
revoke all on ops.kicks from public, anon, authenticated;

-- runs every minute; calls n8n only when there is work and the system is switched on
create or replace function ops.kick() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text := ops.s_text('watchdog_url'); v_secret text; v_req bigint;
begin
  if not ops.s_bool('enabled') or coalesce(v_url, '') = '' then return; end if;
  if exists (select 1 from ops.kicks where created_at > now() - interval '50 seconds') then return; end if;
  if not exists (select 1 from ops.checks
                  where status in ('pending','alerting') and next_action_at <= now()
                    and (claimed_at is null or claimed_at < now() - interval '5 minutes'))
     and not ops.overflow_due() then
    return;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'jag_ops_watchdog_secret';
  select net.http_post(
           url := v_url,
           body := jsonb_build_object('source', 'jag-ops-kick', 'at', now()),
           headers := jsonb_build_object('Content-Type', 'application/json', 'X-JAG-Ops-Secret', v_secret),
           timeout_milliseconds := 5000) into v_req;
  insert into ops.kicks (request_id) values (v_req);
  delete from ops.kicks where created_at < now() - interval '3 days';
end $$;
revoke execute on function ops.kick() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'jag-ops-kick';
select cron.schedule('jag-ops-kick', '* * * * *', 'select ops.kick()');

-- check: expect one row, schedule "* * * * *", active = true
select jobname, schedule, active from cron.job where jobname = 'jag-ops-kick';
