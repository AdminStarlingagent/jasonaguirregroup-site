-- ============================================================
-- JAG CRM — run this ONCE in Supabase → SQL Editor → New query
-- Creates the leads table + locks it down:
--   • the public website can only INSERT (log a lead)
--   • only signed-in admins can READ and UPDATE
-- ============================================================

create table if not exists public.jag_leads (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  type        text not null,                 -- Mortgage Application | Buyer Offer | Seller Listing | Home Value
  name        text,
  email       text,
  phone       text,
  lang        text,
  source      text,
  status      text not null default 'New',   -- New | Contacted | Working | Won | Lost
  notes       text,
  payload     jsonb not null default '{}'::jsonb
);

create index if not exists jag_leads_created_idx on public.jag_leads (created_at desc);
create index if not exists jag_leads_type_idx    on public.jag_leads (type);
create index if not exists jag_leads_status_idx  on public.jag_leads (status);

alter table public.jag_leads enable row level security;

drop policy if exists "site can insert leads"   on public.jag_leads;
create policy "site can insert leads"   on public.jag_leads for insert to anon           with check (true);

drop policy if exists "admins can read leads"   on public.jag_leads;
create policy "admins can read leads"   on public.jag_leads for select to authenticated  using (true);

drop policy if exists "admins can update leads" on public.jag_leads;
create policy "admins can update leads" on public.jag_leads for update to authenticated  using (true);

-- Then create your login: Supabase → Authentication → Users → Add user
-- (email + password — that's what you'll sign in with on /admin.html)
