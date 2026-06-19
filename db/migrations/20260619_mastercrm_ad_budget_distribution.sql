begin;

delete from public.owner_marketing_daily_budgets
where level = 'campaign';

alter table public.owner_marketing_daily_budgets
  drop constraint if exists owner_marketing_daily_budgets_level_check,
  drop constraint if exists ck_owner_marketing_daily_budgets_ad_level,
  drop constraint if exists ck_owner_marketing_daily_budgets_level_ad,
  drop constraint if exists ck_owner_marketing_daily_budgets_ad_required;

alter table public.owner_marketing_daily_budgets
  add constraint ck_owner_marketing_daily_budgets_level_ad
    check (level = 'ad'),
  add constraint ck_owner_marketing_daily_budgets_ad_required
    check (ad_key <> '');

create or replace function public.distribute_owner_marketing_ad_budgets_v1(
  p_owner_id uuid,
  p_mastercrm_user_id bigint,
  p_total_daily_budget_ars numeric,
  p_active_from date,
  p_active_to date,
  p_ads jsonb
)
returns table (
  id uuid,
  channel text,
  level text,
  campaign_key text,
  campaign_name text,
  ad_key text,
  ad_name text,
  link_url text,
  daily_budget_ars numeric,
  active_from date,
  active_to date,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ad_count integer;
  v_channel_count integer;
  v_duplicate_ads text;
  v_overlap_ads text;
  v_total_cents bigint;
  v_base_cents bigint;
  v_remainder integer;
begin
  if p_owner_id is null then
    raise exception using errcode = '22023', message = 'owner_id is required';
  end if;

  if p_mastercrm_user_id is null then
    raise exception using errcode = '22023', message = 'mastercrm_user_id is required';
  end if;

  if p_total_daily_budget_ars is null or p_total_daily_budget_ars < 0 then
    raise exception using errcode = '22023', message = 'total_daily_budget_ars must be a positive number or zero';
  end if;

  if p_active_from is null then
    raise exception using errcode = '22023', message = 'active_from is required';
  end if;

  if p_active_to is not null and p_active_to < p_active_from then
    raise exception using errcode = '22023', message = 'active_to must be after active_from';
  end if;

  if p_ads is null or jsonb_typeof(p_ads) <> 'array' then
    raise exception using errcode = '22023', message = 'ads must be an array';
  end if;

  drop table if exists pg_temp.mastercrm_distributed_ads;
  create temporary table mastercrm_distributed_ads on commit drop as
  select
    row_number() over (
      order by btrim(coalesce(ad.channel, '')), btrim(coalesce(ad.campaign_key, '')), btrim(coalesce(ad.ad_key, ''))
    )::integer as ordinal,
    btrim(coalesce(ad.channel, '')) as channel,
    btrim(coalesce(ad.campaign_key, '')) as campaign_key,
    btrim(coalesce(ad.campaign_name, '')) as campaign_name,
    btrim(coalesce(ad.ad_key, '')) as ad_key,
    nullif(btrim(coalesce(ad.ad_name, '')), '') as ad_name,
    nullif(btrim(coalesce(ad.link_url, '')), '') as link_url
  from jsonb_to_recordset(p_ads) as ad(
    channel text,
    campaign_key text,
    campaign_name text,
    ad_key text,
    ad_name text,
    link_url text
  );

  select count(*)::integer
    into v_ad_count
  from pg_temp.mastercrm_distributed_ads;

  if v_ad_count < 2 then
    raise exception using errcode = '22023', message = 'ads must include at least two ads';
  end if;

  if exists (
    select 1
    from pg_temp.mastercrm_distributed_ads ads
    where ads.channel not in ('landing', 'meta_ctwa')
      or ads.campaign_key = ''
      or ads.campaign_name = ''
      or ads.ad_key = ''
  ) then
    raise exception using errcode = '22023', message = 'each ad must include channel, campaign_key, campaign_name and ad_key';
  end if;

  select count(distinct ads.channel)::integer
    into v_channel_count
  from pg_temp.mastercrm_distributed_ads ads;

  if v_channel_count <> 1 then
    raise exception using errcode = '22023', message = 'all ads must use the same channel';
  end if;

  select string_agg(duplicate_key, ', ' order by duplicate_key)
    into v_duplicate_ads
  from (
    select ads.channel || ' / ' || ads.campaign_name || ' / ' || ads.ad_key as duplicate_key
    from pg_temp.mastercrm_distributed_ads ads
    group by ads.channel, ads.campaign_name, ads.ad_key
    having count(*) > 1
  ) duplicate_rows;

  if v_duplicate_ads is not null then
    raise exception using
      errcode = '22023',
      message = 'ads must not include duplicates: ' || v_duplicate_ads;
  end if;

  select string_agg(distinct ads.channel || ' / ' || ads.campaign_name || ' / ' || coalesce(ads.ad_name, ads.ad_key), ', ')
    into v_overlap_ads
  from public.owner_marketing_daily_budgets existing
  join pg_temp.mastercrm_distributed_ads ads
    on ads.channel = existing.channel
   and ads.campaign_key = existing.campaign_key
   and ads.ad_key = existing.ad_key
  where existing.owner_id = p_owner_id
    and existing.level = 'ad'
    and existing.active_from <= coalesce(p_active_to, date '9999-12-31')
    and coalesce(existing.active_to, date '9999-12-31') >= p_active_from;

  if v_overlap_ads is not null then
    raise exception using
      errcode = '23505',
      message = 'Budget overlaps existing ads: ' || v_overlap_ads;
  end if;

  v_total_cents := round(p_total_daily_budget_ars * 100)::bigint;
  v_base_cents := floor(v_total_cents::numeric / v_ad_count)::bigint;
  v_remainder := (v_total_cents - (v_base_cents * v_ad_count))::integer;

  return query
  with inserted as (
    insert into public.owner_marketing_daily_budgets (
      owner_id,
      channel,
      level,
      campaign_key,
      campaign_name,
      ad_key,
      ad_name,
      link_url,
      daily_budget_ars,
      active_from,
      active_to,
      updated_by_mastercrm_user_id
    )
    select
      p_owner_id,
      ads.channel,
      'ad',
      ads.campaign_key,
      ads.campaign_name,
      ads.ad_key,
      ads.ad_name,
      ads.link_url,
      ((v_base_cents + case when ads.ordinal <= v_remainder then 1 else 0 end)::numeric / 100),
      p_active_from,
      p_active_to,
      p_mastercrm_user_id
    from pg_temp.mastercrm_distributed_ads ads
    order by ads.ordinal
    returning
      owner_marketing_daily_budgets.id,
      owner_marketing_daily_budgets.channel,
      owner_marketing_daily_budgets.level,
      owner_marketing_daily_budgets.campaign_key,
      owner_marketing_daily_budgets.campaign_name,
      owner_marketing_daily_budgets.ad_key,
      owner_marketing_daily_budgets.ad_name,
      owner_marketing_daily_budgets.link_url,
      owner_marketing_daily_budgets.daily_budget_ars,
      owner_marketing_daily_budgets.active_from,
      owner_marketing_daily_budgets.active_to,
      owner_marketing_daily_budgets.updated_at
  )
  select
    inserted.id,
    inserted.channel,
    inserted.level,
    inserted.campaign_key,
    inserted.campaign_name,
    inserted.ad_key,
    inserted.ad_name,
    inserted.link_url,
    inserted.daily_budget_ars,
    inserted.active_from,
    inserted.active_to,
    inserted.updated_at
  from inserted
  order by inserted.channel, inserted.campaign_key, inserted.ad_key;
end;
$$;

revoke all on function public.distribute_owner_marketing_ad_budgets_v1(uuid, bigint, numeric, date, date, jsonb) from public;
grant execute on function public.distribute_owner_marketing_ad_budgets_v1(uuid, bigint, numeric, date, date, jsonb) to service_role;

commit;
