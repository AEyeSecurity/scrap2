begin;

do $$
begin
  if exists (
    select 1 from public.mastercrm_user_owner_links
    group by mastercrm_user_id having count(*) > 1
  ) then
    raise exception using errcode = '55000',
      message = 'ROLLBACK_BLOCKED_DUAL_LINKS_EXIST';
  end if;
end;
$$;

drop function if exists public.mastercrm_central_intake_v1(
  text, text, text, text, text, text, jsonb, timestamptz, integer
);
drop function if exists public.mastercrm_link_platform_owner_v1(bigint, uuid, text, boolean, text);
drop function if exists public.mastercrm_unlink_platform_owner_v1(bigint, text, text);

drop table if exists public.mastercrm_portfolio_contact_events;
drop table if exists public.mastercrm_portfolio_routes;
drop table if exists public.mastercrm_portfolio_contacts;
drop table if exists public.mastercrm_portfolio_marketing_daily_budgets;
drop table if exists public.mastercrm_portfolio_organic_qr_daily_budgets;
drop table if exists public.mastercrm_portfolio_monthly_ad_spend;
drop table if exists public.mastercrm_portfolio_financial_settings;

drop function if exists public.prevent_mastercrm_portfolio_marketing_budget_overlap_v1();
drop function if exists public.prevent_mastercrm_portfolio_organic_budget_overlap_v1();

alter table public.mastercrm_user_owner_links
  drop constraint if exists fk_mastercrm_user_owner_links_owner_pagina;
drop index if exists public.uq_mastercrm_user_owner_links_user_pagina;
drop index if exists public.uq_mastercrm_user_owner_links_owner;
alter table public.mastercrm_user_owner_links
  drop constraint if exists ck_mastercrm_user_owner_links_pagina;
alter table public.mastercrm_user_owner_links drop column if exists pagina;
create unique index if not exists uq_mastercrm_user_owner_links_single_owner
  on public.mastercrm_user_owner_links(mastercrm_user_id);

drop index if exists public.uq_owners_id_pagina;
drop index if exists public.uq_mastercrm_users_routing_key;
alter table public.mastercrm_users drop constraint if exists ck_mastercrm_users_routing_key;
alter table public.mastercrm_users drop column if exists routing_key;

commit;
