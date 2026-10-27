-- The phone clients see for an agent comes from their Follow Up Boss profile (jag_agents_sync, every morning).
-- phone_override keeps a different public number (e.g. the office line) that the sync never replaces.
alter table public.jag_agents add column if not exists phone_override text;
-- jag_agents_sync: on conflict ... phone = coalesce(public.jag_agents.phone_override, excluded.phone)
update public.jag_agents set phone_override = '(832) 702-3574', phone = '(832) 702-3574' where code = 'jason';
