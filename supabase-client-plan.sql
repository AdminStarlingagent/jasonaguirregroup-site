-- The signed-in client's home-buying plan (account page "Mi plan"): their latest Home Loan application status.
-- Matched by the account email or phone. Only the date and a stage; no amounts or team notes.
create or replace function public.jag_my_plan()
returns json language plpgsql stable security definer set search_path = '' as $$
declare c public.jag_clients; v_phone text; v_email text; a public.jag_leads;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'reason', 'sign_in'); end if;
  select * into c from public.jag_clients where user_id = auth.uid();
  if c.user_id is null then return json_build_object('ok', false, 'reason', 'no_account'); end if;
  v_phone := right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10);
  v_email := lower(trim(coalesce(c.email, '')));
  select * into a from public.jag_leads l
   where l.type = 'Mortgage Application' and coalesce(l.status, '') <> 'Merged' and l.created_at > now() - interval '18 months'
     and ((v_email like '%@%' and lower(trim(coalesce(l.email, ''))) = v_email)
       or (length(v_phone) = 10 and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = v_phone))
   order by l.created_at desc limit 1;
  return json_build_object('ok', true,
    'app', case when a.id is null then null else json_build_object('at', a.created_at,
      'stage', case a.status when 'New' then 'received' when 'Contacted' then 'review' when 'Working' then 'review'
                             when 'Credit' then 'credit' when 'Won' then 'done' when 'Lost' then 'paused' else 'received' end) end);
end $$;
revoke all on function public.jag_my_plan() from public, anon;
grant execute on function public.jag_my_plan() to authenticated;
