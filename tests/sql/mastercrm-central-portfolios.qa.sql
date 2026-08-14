\set ON_ERROR_STOP on

-- Run after applying 20260813220000_mastercrm_central_portfolios.sql to the
-- isolated QA fixture. Every mutation is rolled back at the end.
begin;

do $$
declare
  v_user_id bigint;
  v_owner_asn uuid;
  v_owner_asn_replacement uuid;
  v_result jsonb;
begin
  select id into strict v_user_id
  from public.mastercrm_users where username = 'qa_dualcrm_pre_01';
  select id into strict v_owner_asn
  from public.owners where owner_key = 'qa_dualcrm_owner_12';
  select id into strict v_owner_asn_replacement
  from public.owners where owner_key = 'qa_dualcrm_owner_14';

  v_result := public.mastercrm_link_platform_owner_v1(
    v_user_id, v_owner_asn, 'ASN', false, 'qa_dualcrm_sql'
  );
  if (select count(*) from public.mastercrm_user_owner_links where mastercrm_user_id = v_user_id) <> 2 then
    raise exception 'QA_ASSERT: expected exactly two platform links';
  end if;
  if not exists (
    select 1 from public.mastercrm_platform_owner_pairs pairs
    join public.mastercrm_user_owner_links rda
      on rda.owner_id = pairs.rda_owner_id and rda.mastercrm_user_id = v_user_id
    join public.mastercrm_user_owner_links asn
      on asn.owner_id = pairs.asn_owner_id and asn.mastercrm_user_id = v_user_id
    where pairs.active_to is null
  ) then
    raise exception 'QA_ASSERT: explicit ASN/RdA pair was not created';
  end if;

  begin
    perform public.mastercrm_link_platform_owner_v1(
      v_user_id, v_owner_asn_replacement, 'ASN', false, 'qa_dualcrm_sql'
    );
    raise exception 'QA_ASSERT: replacement without confirmation succeeded';
  exception when check_violation then
    if sqlerrm <> 'OWNER_REPLACEMENT_CONFIRMATION_REQUIRED' then raise; end if;
  end;

  v_result := public.mastercrm_link_platform_owner_v1(
    v_user_id, v_owner_asn_replacement, 'ASN', true, 'qa_dualcrm_sql'
  );
  if coalesce((v_result ->> 'replaced')::boolean, false) is not true then
    raise exception 'QA_ASSERT: confirmed replacement was not reported';
  end if;
  if (select owner_id from public.mastercrm_user_owner_links
      where mastercrm_user_id = v_user_id and pagina = 'ASN') <> v_owner_asn_replacement then
    raise exception 'QA_ASSERT: ASN owner was not replaced';
  end if;

  if not public.mastercrm_unlink_platform_owner_v1(v_user_id, 'ASN', 'qa_dualcrm_sql') then
    raise exception 'QA_ASSERT: unlink did not remove ASN link';
  end if;
  if (select count(*) from public.mastercrm_user_owner_links where mastercrm_user_id = v_user_id) <> 1 then
    raise exception 'QA_ASSERT: unlink altered the other platform';
  end if;
  perform public.mastercrm_link_platform_owner_v1(
    v_user_id, v_owner_asn_replacement, 'ASN', false, 'qa_dualcrm_sql'
  );
end;
$$;

do $$
declare
  v_user_id bigint;
  v_other_user_id bigint;
  v_linked_owner uuid;
  v_pair_rda uuid;
  v_pair_asn uuid;
begin
  select id into strict v_user_id from public.mastercrm_users where username = 'qa_dualcrm_pre_01';
  select id into strict v_other_user_id from public.mastercrm_users where username = 'qa_dualcrm_pre_03';
  select owner_id into strict v_linked_owner from public.mastercrm_user_owner_links
    where mastercrm_user_id = v_user_id and pagina = 'ASN';

  begin
    perform public.mastercrm_link_platform_owner_v1(
      v_other_user_id, v_linked_owner, 'ASN', false, 'qa_dualcrm_sql'
    );
    raise exception 'QA_ASSERT: owner linked to two CRM logins';
  exception when unique_violation then null;
  end;

  select id into strict v_pair_rda from public.owners where owner_key = 'qa_dualcrm_owner_11';
  select id into strict v_pair_asn from public.owners where owner_key = 'qa_dualcrm_owner_12';
  insert into public.mastercrm_platform_owner_pairs(rda_owner_id, asn_owner_id, edited_by)
  values (v_pair_rda, v_pair_asn, 'qa_dualcrm_sql');

  begin
    perform public.mastercrm_link_platform_owner_v1(
      v_other_user_id, v_pair_asn, 'ASN', false, 'qa_dualcrm_sql'
    );
    raise exception 'QA_ASSERT: incompatible pair was accepted';
  exception when unique_violation then
    if sqlerrm <> 'OWNER_PAIR_CONFLICT' then raise; end if;
  end;
end;
$$;

do $$
declare
  v_user_1 bigint;
  v_user_2 bigint;
  v_contact_1 uuid;
  v_contact_2 uuid;
  v_event_count integer;
begin
  select id into strict v_user_1 from public.mastercrm_users where username = 'qa_dualcrm_pre_01';
  select id into strict v_user_2 from public.mastercrm_users where username = 'qa_dualcrm_pre_02';

  select contact_id into strict v_contact_1
  from public.mastercrm_central_intake_v1(
    'qa_dualcrm_pre_01', '+5491100009001', 'whatsapp:+5491100090000',
    'QA Franco', '+5491100000001', 'QA_DUALCRM_SM_0001', '{"qa":true}'::jsonb
  );
  perform public.mastercrm_central_intake_v1(
    'qa_dualcrm_pre_01', '+5491100009001', 'whatsapp:+5491100090000',
    'QA Different Retry', '+5491100000999', 'QA_DUALCRM_SM_0001', '{"qa":true}'::jsonb
  );
  select count(*) into v_event_count from public.mastercrm_portfolio_contact_events
    where message_sid = 'QA_DUALCRM_SM_0001';
  if v_event_count <> 1 then
    raise exception 'QA_ASSERT: repeated MessageSid created % events', v_event_count;
  end if;
  if (select count(*) from public.mastercrm_portfolio_contacts
      where mastercrm_user_id = v_user_1 and phone_e164 = '+5491100009001') <> 1 then
    raise exception 'QA_ASSERT: intake duplicated central contact';
  end if;
  if not exists (
    select 1 from public.mastercrm_portfolio_routes
    where channel_key = 'whatsapp:+5491100090000'
      and phone_e164 = '+5491100009001'
      and actor_alias = 'QA Franco'
      and actor_phone = '+5491100000001'
      and expires_at > now()
  ) then
    raise exception 'QA_ASSERT: exact active destination route was not stored';
  end if;

  select contact_id into strict v_contact_2
  from public.mastercrm_central_intake_v1(
    'qa_dualcrm_pre_02', '+5491100009001', 'whatsapp:+5491100090002',
    'QA Sol', '+5491100000002', 'QA_DUALCRM_SM_0002', '{}'::jsonb
  );
  if v_contact_1 = v_contact_2 then
    raise exception 'QA_ASSERT: same phone in different portfolios shared a contact';
  end if;
  if (select count(*) from public.mastercrm_portfolio_contacts where phone_e164 = '+5491100009001') <> 2 then
    raise exception 'QA_ASSERT: same phone was not isolated by portfolio';
  end if;

  update public.mastercrm_portfolio_routes
  set assigned_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
  where channel_key = 'whatsapp:+5491100090000' and phone_e164 = '+5491100009001';
  if exists (
    select 1 from public.mastercrm_portfolio_routes
    where channel_key = 'whatsapp:+5491100090000'
      and phone_e164 = '+5491100009001' and expires_at > now()
  ) then
    raise exception 'QA_ASSERT: expired route remained resolvable';
  end if;
end;
$$;

do $$
declare
  v_user_id bigint;
  v_budget_id uuid;
begin
  select id into strict v_user_id from public.mastercrm_users where username = 'qa_dualcrm_pre_04';

  insert into public.mastercrm_portfolio_financial_settings(
    mastercrm_user_id, commission_pct, updated_by_mastercrm_user_id
  ) values (v_user_id, 12.5, v_user_id)
  on conflict (mastercrm_user_id) do update set commission_pct = excluded.commission_pct;
  if (select commission_pct from public.mastercrm_portfolio_financial_settings
      where mastercrm_user_id = v_user_id) <> 12.5 then
    raise exception 'QA_ASSERT: central commission was not persisted';
  end if;

  insert into public.mastercrm_portfolio_monthly_ad_spend(
    mastercrm_user_id, month_start, ad_spend_ars, updated_by_mastercrm_user_id
  ) values (v_user_id, date '2026-08-01', 1000, v_user_id)
  on conflict (mastercrm_user_id, month_start) do update set ad_spend_ars = excluded.ad_spend_ars;
  update public.mastercrm_portfolio_monthly_ad_spend
  set ad_spend_ars = 1250
  where mastercrm_user_id = v_user_id and month_start = date '2026-08-01';
  if (select ad_spend_ars from public.mastercrm_portfolio_monthly_ad_spend
      where mastercrm_user_id = v_user_id and month_start = date '2026-08-01') <> 1250 then
    raise exception 'QA_ASSERT: central monthly spend edit failed';
  end if;

  insert into public.mastercrm_portfolio_marketing_daily_budgets(
    mastercrm_user_id, channel, campaign_key, campaign_name, ad_key, ad_name,
    daily_budget_ars, active_from, active_to, updated_by_mastercrm_user_id
  ) values (
    v_user_id, 'landing', 'qa_campaign', 'QA Campaign', 'qa_ad', 'QA Ad',
    100, date '2026-08-01', date '2026-08-10', v_user_id
  ) returning id into v_budget_id;
  begin
    insert into public.mastercrm_portfolio_marketing_daily_budgets(
      mastercrm_user_id, channel, campaign_key, campaign_name, ad_key,
      daily_budget_ars, active_from, active_to, updated_by_mastercrm_user_id
    ) values (
      v_user_id, 'landing', 'qa_campaign', 'QA Campaign', 'qa_ad',
      200, date '2026-08-05', date '2026-08-12', v_user_id
    );
    raise exception 'QA_ASSERT: overlapping marketing budget was accepted';
  exception when exclusion_violation then null;
  end;
  delete from public.mastercrm_portfolio_marketing_daily_budgets
  where id = v_budget_id and mastercrm_user_id = v_user_id;
  if not found then raise exception 'QA_ASSERT: central marketing budget delete failed'; end if;

  insert into public.mastercrm_portfolio_organic_qr_daily_budgets(
    mastercrm_user_id, daily_budget_ars, active_from, active_to, updated_by_mastercrm_user_id
  ) values (v_user_id, 50, date '2026-08-01', date '2026-08-31', v_user_id)
  returning id into v_budget_id;
  begin
    insert into public.mastercrm_portfolio_organic_qr_daily_budgets(
      mastercrm_user_id, daily_budget_ars, active_from, active_to, updated_by_mastercrm_user_id
    ) values (v_user_id, 70, date '2026-08-20', null, v_user_id);
    raise exception 'QA_ASSERT: overlapping organic budget was accepted';
  exception when exclusion_violation then null;
  end;
  update public.mastercrm_portfolio_organic_qr_daily_budgets
  set daily_budget_ars = 75 where id = v_budget_id and mastercrm_user_id = v_user_id;
  if (select daily_budget_ars from public.mastercrm_portfolio_organic_qr_daily_budgets
      where id = v_budget_id) <> 75 then
    raise exception 'QA_ASSERT: central organic budget edit failed';
  end if;
  delete from public.mastercrm_portfolio_organic_qr_daily_budgets
  where id = v_budget_id and mastercrm_user_id = v_user_id;
  if not found then raise exception 'QA_ASSERT: central organic budget delete failed'; end if;
end;
$$;

select 'mastercrm-central-portfolios-qa: ok' as result;
rollback;
