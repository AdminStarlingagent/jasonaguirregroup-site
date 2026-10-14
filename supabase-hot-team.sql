-- Who Lola texts about hot website buyers: active teammates with lead alerts on and a mobile.
create or replace function public.ops_lead_alert_team()
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object('member_id', t.id, 'name', t.name, 'fub_user_id', t.fub_user_id, 'mobile', t.mobile_e164) order by t.id), '[]'::json)
    from ops.team t where t.active and t.lead_alerts and t.mobile_e164 is not null;
$$;
revoke all on function public.ops_lead_alert_team() from public, anon, authenticated;
grant execute on function public.ops_lead_alert_team() to service_role;
select json_array_length(public.ops_lead_alert_team()) as teammates;
