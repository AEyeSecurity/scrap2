begin;

insert into public.owners (pagina, owner_key, owner_label)
values
  ('ASN', 'asnlucas10:lucas10', 'Lucas10'),
  ('ASN', 'asnlucas10:vicky', 'Vicky'),
  ('ASN', 'asnlucas10:lucas1', 'Lucas1'),
  ('ASN', 'asnlucas10:lucas5', 'Lucas 5'),
  ('ASN', 'asnlucas10:lear', 'Lea Riqueza'),
  ('ASN', 'asnlucas10:leandro', 'LEANDRO')
on conflict (pagina, owner_key) do update
set owner_label = excluded.owner_label,
    updated_at = now();

insert into public.owner_aliases (owner_id, alias, is_active, last_seen_at)
select o.id, seed.alias, true, now()
from (
  values
    ('asnlucas10:lucas10', 'Lucas10'),
    ('asnlucas10:vicky', 'Vicky'),
    ('asnlucas10:lucas1', 'Lucas1'),
    ('asnlucas10:lucas5', 'Lucas 5'),
    ('asnlucas10:lear', 'Lea Riqueza'),
    ('asnlucas10:leandro', 'LEANDRO')
) as seed(owner_key, alias)
join public.owners o
  on o.pagina = 'ASN'
 and o.owner_key = seed.owner_key
on conflict (owner_id, alias) do update
set is_active = true,
    last_seen_at = greatest(public.owner_aliases.last_seen_at, excluded.last_seen_at),
    updated_at = now();

do $$
declare
  v_source_owner_id uuid;
  v_target_owner_id uuid;
  v_target_owner_key text;
  v_target_owner_label text;
  v_overlap_count integer;
begin
  select id, owner_key, owner_label
    into v_target_owner_id, v_target_owner_key, v_target_owner_label
  from public.owners
  where pagina = 'ASN' and owner_key = 'asnlucas10:vicky';

  if v_target_owner_id is null then
    raise exception using message = 'ASN owner merge target asnlucas10:vicky is missing';
  end if;

  select id into v_source_owner_id
  from public.owners
  where pagina = 'ASN' and owner_key = 'luqui10:vicky';

  if v_source_owner_id is null then
    return;
  end if;

  select count(*) into v_overlap_count
  from public.owner_client_links source_link
  join public.owner_client_links target_link
    on target_link.owner_id = v_target_owner_id
   and target_link.client_id = source_link.client_id
  where source_link.owner_id = v_source_owner_id;

  if v_overlap_count > 0 then
    raise exception using
      errcode = '23505',
      message = 'ASN Vicky owner merge has overlapping clients';
  end if;

  update public.owner_client_events event
  set alias_id = target_alias.id
  from public.owner_aliases source_alias
  join public.owner_aliases target_alias
    on target_alias.owner_id = v_target_owner_id
   and lower(btrim(target_alias.alias)) = lower(btrim(source_alias.alias))
  where source_alias.owner_id = v_source_owner_id
    and event.alias_id = source_alias.id;

  delete from public.owner_aliases source_alias
  using public.owner_aliases target_alias
  where source_alias.owner_id = v_source_owner_id
    and target_alias.owner_id = v_target_owner_id
    and lower(btrim(target_alias.alias)) = lower(btrim(source_alias.alias));

  update public.owner_aliases set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.owner_client_events set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.owner_client_identities set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.owner_client_monthly_facts set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.owner_new_client_monthly_facts set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.report_run_items
  set owner_id = v_target_owner_id,
      owner_key = v_target_owner_key,
      owner_label = v_target_owner_label
  where owner_id = v_source_owner_id;
  update public.report_daily_snapshots
  set owner_id = v_target_owner_id,
      owner_key = v_target_owner_key,
      owner_label = v_target_owner_label
  where owner_id = v_source_owner_id;
  update public.meta_conversion_outbox set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.owner_monthly_ad_spend set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.owner_marketing_daily_budgets set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.owner_organic_qr_daily_budgets set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.mastercrm_user_owner_links set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.mastercrm_platform_credentials
  set owner_id = v_target_owner_id,
      owner_key = v_target_owner_key
  where owner_id = v_source_owner_id;
  update public.mastercrm_rda_credentials
  set owner_id = v_target_owner_id,
      owner_key = v_target_owner_key
  where owner_id = v_source_owner_id;
  update public.mastercrm_whatsapp_qr_sessions
  set owner_id = v_target_owner_id,
      owner_key = v_target_owner_key,
      owner_label = v_target_owner_label,
      pagina = 'ASN'
  where owner_id = v_source_owner_id;
  update public.mastercrm_whatsapp_qr_messages set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.mastercrm_whatsapp_qr_messages set resolved_owner_id = v_target_owner_id where resolved_owner_id = v_source_owner_id;
  update public.mastercrm_whatsapp_qr_matches set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.mastercrm_whatsapp_qr_contacts set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.mastercrm_whatsapp_qr_recheck_queue set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.mastercrm_whatsapp_qr_ignored_phones set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.mastercrm_whatsapp_qr_backfill_runs set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.mastercrm_whatsapp_qr_session_routes set owner_id = v_target_owner_id where owner_id = v_source_owner_id;
  update public.owner_client_links set owner_id = v_target_owner_id where owner_id = v_source_owner_id;

  if exists (select 1 from public.owner_financial_settings where owner_id = v_source_owner_id)
     and exists (select 1 from public.owner_financial_settings where owner_id = v_target_owner_id) then
    raise exception using message = 'ASN Vicky owner merge has conflicting financial settings';
  end if;
  update public.owner_financial_settings set owner_id = v_target_owner_id where owner_id = v_source_owner_id;

  delete from public.owners where id = v_source_owner_id;
end;
$$;

commit;
