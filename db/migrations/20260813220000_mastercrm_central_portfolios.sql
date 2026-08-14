begin;

alter table public.mastercrm_users
  add column if not exists routing_key text;

update public.mastercrm_users
set routing_key = lower(btrim(username))
where routing_key is null or btrim(routing_key) = '';

alter table public.mastercrm_users
  alter column routing_key set not null;

create unique index if not exists uq_mastercrm_users_routing_key
  on public.mastercrm_users (routing_key);

alter table public.mastercrm_users
  drop constraint if exists ck_mastercrm_users_routing_key;
alter table public.mastercrm_users
  add constraint ck_mastercrm_users_routing_key
  check (routing_key = lower(btrim(routing_key)) and routing_key <> '');

drop index if exists public.uq_mastercrm_user_owner_links_single_owner;

alter table public.mastercrm_user_owner_links
  add column if not exists pagina text;

update public.mastercrm_user_owner_links links
set pagina = owners.pagina
from public.owners owners
where owners.id = links.owner_id
  and (links.pagina is null or links.pagina <> owners.pagina);

alter table public.mastercrm_user_owner_links
  alter column pagina set not null;

alter table public.mastercrm_user_owner_links
  drop constraint if exists ck_mastercrm_user_owner_links_pagina;
alter table public.mastercrm_user_owner_links
  add constraint ck_mastercrm_user_owner_links_pagina check (pagina in ('ASN', 'RdA'));

create unique index if not exists uq_owners_id_pagina on public.owners (id, pagina);

alter table public.mastercrm_user_owner_links
  drop constraint if exists fk_mastercrm_user_owner_links_owner_pagina;
alter table public.mastercrm_user_owner_links
  add constraint fk_mastercrm_user_owner_links_owner_pagina
  foreign key (owner_id, pagina) references public.owners(id, pagina) on delete cascade;

create unique index if not exists uq_mastercrm_user_owner_links_user_pagina
  on public.mastercrm_user_owner_links (mastercrm_user_id, pagina);

create unique index if not exists uq_mastercrm_user_owner_links_owner
  on public.mastercrm_user_owner_links (owner_id);

create table if not exists public.mastercrm_portfolio_contacts (
  id uuid primary key default gen_random_uuid(),
  mastercrm_user_id bigint not null references public.mastercrm_users(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_mastercrm_portfolio_contacts_user_phone unique (mastercrm_user_id, phone_e164)
);

create index if not exists ix_mastercrm_portfolio_contacts_phone
  on public.mastercrm_portfolio_contacts (phone_e164);

create table if not exists public.mastercrm_portfolio_contact_events (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.mastercrm_portfolio_contacts(id) on delete cascade,
  mastercrm_user_id bigint not null references public.mastercrm_users(id) on delete cascade,
  event_type text not null check (event_type in ('intake', 'reentry', 'platform_backfill')),
  message_sid text null,
  channel_key text null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists uq_mastercrm_portfolio_contact_events_message_sid
  on public.mastercrm_portfolio_contact_events (message_sid)
  where message_sid is not null;
create index if not exists ix_mastercrm_portfolio_contact_events_user_occurred
  on public.mastercrm_portfolio_contact_events (mastercrm_user_id, occurred_at desc);

create table if not exists public.mastercrm_portfolio_routes (
  id uuid primary key default gen_random_uuid(),
  channel_key text not null check (btrim(channel_key) <> ''),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  mastercrm_user_id bigint not null references public.mastercrm_users(id) on delete cascade,
  contact_id uuid not null references public.mastercrm_portfolio_contacts(id) on delete cascade,
  routing_key text not null,
  actor_alias text not null check (btrim(actor_alias) <> ''),
  actor_phone text not null check (actor_phone ~ '^\+[1-9][0-9]{7,14}$'),
  assigned_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_mastercrm_portfolio_routes_channel_phone unique (channel_key, phone_e164),
  constraint fk_mastercrm_portfolio_routes_routing_key foreign key (routing_key)
    references public.mastercrm_users(routing_key) on update restrict on delete cascade,
  constraint ck_mastercrm_portfolio_routes_expiry check (expires_at > assigned_at)
);

create index if not exists ix_mastercrm_portfolio_routes_expiry
  on public.mastercrm_portfolio_routes (expires_at);

create table if not exists public.mastercrm_portfolio_financial_settings (
  mastercrm_user_id bigint primary key references public.mastercrm_users(id) on delete cascade,
  commission_pct numeric null check (commission_pct between 0 and 100),
  updated_by_mastercrm_user_id bigint null references public.mastercrm_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mastercrm_portfolio_monthly_ad_spend (
  id uuid primary key default gen_random_uuid(),
  mastercrm_user_id bigint not null references public.mastercrm_users(id) on delete cascade,
  month_start date not null,
  ad_spend_ars numeric not null default 0 check (ad_spend_ars >= 0),
  updated_by_mastercrm_user_id bigint null references public.mastercrm_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_mastercrm_portfolio_monthly_ad_spend unique (mastercrm_user_id, month_start)
);

create table if not exists public.mastercrm_portfolio_marketing_daily_budgets (
  id uuid primary key default gen_random_uuid(),
  mastercrm_user_id bigint not null references public.mastercrm_users(id) on delete cascade,
  channel text not null check (channel in ('landing', 'meta_ctwa')),
  level text not null default 'ad' check (level = 'ad'),
  campaign_key text not null,
  campaign_name text not null,
  ad_key text not null default '',
  ad_name text null,
  link_url text null,
  daily_budget_ars numeric not null default 0 check (daily_budget_ars >= 0),
  active_from date not null,
  active_to date null,
  updated_by_mastercrm_user_id bigint null references public.mastercrm_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_mastercrm_portfolio_marketing_budget_window check (active_to is null or active_to >= active_from),
  constraint uq_mastercrm_portfolio_marketing_budget unique
    (mastercrm_user_id, channel, level, campaign_key, ad_key, active_from)
);

create table if not exists public.mastercrm_portfolio_organic_qr_daily_budgets (
  id uuid primary key default gen_random_uuid(),
  mastercrm_user_id bigint not null references public.mastercrm_users(id) on delete cascade,
  daily_budget_ars numeric not null default 0 check (daily_budget_ars >= 0),
  active_from date not null,
  active_to date null,
  updated_by_mastercrm_user_id bigint null references public.mastercrm_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_mastercrm_portfolio_organic_budget_window check (active_to is null or active_to >= active_from)
);

insert into public.mastercrm_portfolio_contacts (mastercrm_user_id, phone_e164, first_seen_at, last_seen_at)
select
  links.mastercrm_user_id,
  clients.phone_e164,
  min(owner_links.first_seen_at),
  max(coalesce(owner_links.last_seen_at, owner_links.updated_at, owner_links.first_seen_at))
from public.mastercrm_user_owner_links links
join public.owner_client_links owner_links on owner_links.owner_id = links.owner_id
join public.clients clients on clients.id = owner_links.client_id
where clients.phone_e164 is not null
group by links.mastercrm_user_id, clients.phone_e164
on conflict (mastercrm_user_id, phone_e164) do update
set first_seen_at = least(public.mastercrm_portfolio_contacts.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(public.mastercrm_portfolio_contacts.last_seen_at, excluded.last_seen_at),
    updated_at = now();

insert into public.mastercrm_portfolio_financial_settings (
  mastercrm_user_id, commission_pct, updated_by_mastercrm_user_id
)
select distinct on (links.mastercrm_user_id)
  links.mastercrm_user_id,
  settings.commission_pct,
  settings.updated_by_mastercrm_user_id
from public.mastercrm_user_owner_links links
join public.owner_financial_settings settings on settings.owner_id = links.owner_id
order by links.mastercrm_user_id, links.updated_at desc
on conflict (mastercrm_user_id) do nothing;

insert into public.mastercrm_portfolio_monthly_ad_spend (
  mastercrm_user_id, month_start, ad_spend_ars, updated_by_mastercrm_user_id
)
select distinct on (links.mastercrm_user_id, spend.month_start)
  links.mastercrm_user_id,
  spend.month_start,
  spend.ad_spend_ars,
  spend.updated_by_mastercrm_user_id
from public.mastercrm_user_owner_links links
join public.owner_monthly_ad_spend spend on spend.owner_id = links.owner_id
order by links.mastercrm_user_id, spend.month_start, links.updated_at desc
on conflict (mastercrm_user_id, month_start) do nothing;

insert into public.mastercrm_portfolio_marketing_daily_budgets (
  id, mastercrm_user_id, channel, level, campaign_key, campaign_name, ad_key,
  ad_name, link_url, daily_budget_ars, active_from, active_to, updated_by_mastercrm_user_id,
  created_at, updated_at
)
select
  budgets.id, links.mastercrm_user_id, budgets.channel, budgets.level, budgets.campaign_key,
  budgets.campaign_name, budgets.ad_key, budgets.ad_name, budgets.link_url,
  budgets.daily_budget_ars, budgets.active_from, budgets.active_to,
  budgets.updated_by_mastercrm_user_id, budgets.created_at, budgets.updated_at
from public.mastercrm_user_owner_links links
join public.owner_marketing_daily_budgets budgets on budgets.owner_id = links.owner_id
on conflict do nothing;

insert into public.mastercrm_portfolio_organic_qr_daily_budgets (
  id, mastercrm_user_id, daily_budget_ars, active_from, active_to,
  updated_by_mastercrm_user_id, created_at, updated_at
)
select
  budgets.id, links.mastercrm_user_id, budgets.daily_budget_ars, budgets.active_from,
  budgets.active_to, budgets.updated_by_mastercrm_user_id, budgets.created_at, budgets.updated_at
from public.mastercrm_user_owner_links links
join public.owner_organic_qr_daily_budgets budgets on budgets.owner_id = links.owner_id
on conflict do nothing;

create or replace function public.mastercrm_central_intake_v1(
  p_routing_key text,
  p_phone_e164 text,
  p_channel_key text,
  p_actor_alias text,
  p_actor_phone text,
  p_message_sid text default null,
  p_payload jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default now(),
  p_ttl_seconds integer default 86400
)
returns table (
  mastercrm_user_id bigint,
  contact_id uuid,
  event_type text,
  routing_key text,
  actor_alias text,
  actor_phone text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.mastercrm_users%rowtype;
  v_contact public.mastercrm_portfolio_contacts%rowtype;
  v_event_type text;
  v_had_contact boolean;
  v_expires_at timestamptz;
  v_existing_event public.mastercrm_portfolio_contact_events%rowtype;
  v_existing_contact public.mastercrm_portfolio_contacts%rowtype;
  v_existing_route public.mastercrm_portfolio_routes%rowtype;
  v_duplicate_message boolean := false;
begin
  select users.* into v_user
  from public.mastercrm_users users
  where users.routing_key = lower(btrim(p_routing_key)) and users.is_active = true;
  if not found then
    raise exception using errcode = 'P0002', message = 'MASTERCRM_ROUTING_KEY_NOT_FOUND';
  end if;

  if nullif(btrim(p_message_sid), '') is not null then
    select events.* into v_existing_event
    from public.mastercrm_portfolio_contact_events events
    where events.message_sid = btrim(p_message_sid);
    if found then
      select contacts.* into strict v_existing_contact
      from public.mastercrm_portfolio_contacts contacts
      where contacts.id = v_existing_event.contact_id;
      if v_existing_event.mastercrm_user_id <> v_user.id
        or v_existing_contact.phone_e164 <> p_phone_e164 then
        raise exception using errcode = '23505', message = 'MESSAGE_SID_ROUTING_CONFLICT';
      end if;
      v_duplicate_message := true;
      select routes.* into v_existing_route
      from public.mastercrm_portfolio_routes routes
      where routes.channel_key = p_channel_key and routes.phone_e164 = p_phone_e164;
      if found then
        mastercrm_user_id := v_user.id;
        contact_id := v_existing_contact.id;
        event_type := v_existing_event.event_type;
        routing_key := v_existing_route.routing_key;
        actor_alias := v_existing_route.actor_alias;
        actor_phone := v_existing_route.actor_phone;
        expires_at := v_existing_route.expires_at;
        return next;
        return;
      end if;
    end if;
  end if;

  select exists (
    select 1 from public.mastercrm_portfolio_contacts contacts
    where contacts.mastercrm_user_id = v_user.id and contacts.phone_e164 = p_phone_e164
  ) into v_had_contact;

  insert into public.mastercrm_portfolio_contacts (
    mastercrm_user_id, phone_e164, first_seen_at, last_seen_at
  ) values (
    v_user.id, p_phone_e164, p_occurred_at, p_occurred_at
  )
  on conflict on constraint uq_mastercrm_portfolio_contacts_user_phone do update
  set last_seen_at = greatest(public.mastercrm_portfolio_contacts.last_seen_at, excluded.last_seen_at),
      updated_at = now()
  returning * into v_contact;

  v_event_type := case
    when v_duplicate_message then v_existing_event.event_type
    when v_had_contact then 'reentry'
    else 'intake'
  end;
  if not v_duplicate_message then
    insert into public.mastercrm_portfolio_contact_events (
      contact_id, mastercrm_user_id, event_type, message_sid, channel_key, payload, occurred_at
    ) values (
      v_contact.id, v_user.id, v_event_type, nullif(btrim(p_message_sid), ''),
      p_channel_key, coalesce(p_payload, '{}'::jsonb), p_occurred_at
    );
  end if;

  v_expires_at := p_occurred_at + make_interval(secs => greatest(p_ttl_seconds, 1));
  insert into public.mastercrm_portfolio_routes (
    channel_key, phone_e164, mastercrm_user_id, contact_id, routing_key,
    actor_alias, actor_phone, assigned_at, expires_at
  ) values (
    p_channel_key, p_phone_e164, v_user.id, v_contact.id, v_user.routing_key,
    btrim(p_actor_alias), p_actor_phone, p_occurred_at, v_expires_at
  )
  on conflict on constraint uq_mastercrm_portfolio_routes_channel_phone do update
  set mastercrm_user_id = excluded.mastercrm_user_id,
      contact_id = excluded.contact_id,
      routing_key = excluded.routing_key,
      actor_alias = excluded.actor_alias,
      actor_phone = excluded.actor_phone,
      assigned_at = excluded.assigned_at,
      expires_at = excluded.expires_at,
      updated_at = now();

  mastercrm_user_id := v_user.id;
  contact_id := v_contact.id;
  event_type := v_event_type;
  routing_key := v_user.routing_key;
  actor_alias := btrim(p_actor_alias);
  actor_phone := p_actor_phone;
  expires_at := v_expires_at;
  return next;
end;
$$;

create or replace function public.mastercrm_link_platform_owner_v1(
  p_mastercrm_user_id bigint,
  p_owner_id uuid,
  p_pagina text,
  p_confirm_replace boolean default false,
  p_edited_by text default 'mastercrm'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner public.owners%rowtype;
  v_existing public.mastercrm_user_owner_links%rowtype;
  v_other public.mastercrm_user_owner_links%rowtype;
  v_previous_owner_key text;
  v_replaced boolean := false;
  v_rda_owner_id uuid;
  v_asn_owner_id uuid;
begin
  if p_pagina not in ('ASN', 'RdA') then
    raise exception using errcode = '22023', message = 'pagina must be ASN or RdA';
  end if;

  perform 1 from public.mastercrm_users where id = p_mastercrm_user_id and is_active for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'MasterCRM user not found';
  end if;

  select * into v_owner from public.owners where id = p_owner_id and pagina = p_pagina;
  if not found then
    raise exception using errcode = 'P0002', message = 'Cashier owner not found for platform';
  end if;

  select * into v_existing
  from public.mastercrm_user_owner_links
  where mastercrm_user_id = p_mastercrm_user_id and pagina = p_pagina
  for update;

  if found and v_existing.owner_id <> p_owner_id then
    select owner_key into v_previous_owner_key from public.owners where id = v_existing.owner_id;
    if not p_confirm_replace then
      raise exception using errcode = '23514', message = 'OWNER_REPLACEMENT_CONFIRMATION_REQUIRED';
    end if;
    v_replaced := true;
  end if;

  select * into v_other
  from public.mastercrm_user_owner_links
  where mastercrm_user_id = p_mastercrm_user_id and pagina <> p_pagina
  for update;

  if v_replaced and v_other.id is not null then
    update public.mastercrm_platform_owner_pairs
    set active_to = greatest(clock_timestamp(), active_from + interval '1 microsecond'), edited_by = p_edited_by
    where active_to is null
      and ((p_pagina = 'RdA' and rda_owner_id = v_existing.owner_id and asn_owner_id = v_other.owner_id)
        or (p_pagina = 'ASN' and asn_owner_id = v_existing.owner_id and rda_owner_id = v_other.owner_id));
  end if;

  insert into public.mastercrm_user_owner_links (mastercrm_user_id, owner_id, pagina)
  values (p_mastercrm_user_id, p_owner_id, p_pagina)
  on conflict (mastercrm_user_id, pagina) do update
  set owner_id = excluded.owner_id, updated_at = now();

  if v_other.id is not null then
    if p_pagina = 'RdA' then
      v_rda_owner_id := p_owner_id;
      v_asn_owner_id := v_other.owner_id;
    else
      v_rda_owner_id := v_other.owner_id;
      v_asn_owner_id := p_owner_id;
    end if;

    if exists (
      select 1 from public.mastercrm_platform_owner_pairs pairs
      where pairs.active_to is null
        and (pairs.rda_owner_id in (v_rda_owner_id, v_asn_owner_id)
          or pairs.asn_owner_id in (v_rda_owner_id, v_asn_owner_id))
        and not (pairs.rda_owner_id = v_rda_owner_id and pairs.asn_owner_id = v_asn_owner_id)
    ) then
      raise exception using errcode = '23505', message = 'OWNER_PAIR_CONFLICT';
    end if;

    insert into public.mastercrm_platform_owner_pairs (
      rda_owner_id, asn_owner_id, active_from, edited_by
    )
    select v_rda_owner_id, v_asn_owner_id, clock_timestamp(), p_edited_by
    where not exists (
      select 1 from public.mastercrm_platform_owner_pairs
      where rda_owner_id = v_rda_owner_id and asn_owner_id = v_asn_owner_id and active_to is null
    );
  end if;

  insert into public.mastercrm_portfolio_contacts (
    mastercrm_user_id, phone_e164, first_seen_at, last_seen_at
  )
  select
    p_mastercrm_user_id,
    clients.phone_e164,
    min(links.first_seen_at),
    max(coalesce(links.last_seen_at, links.updated_at, links.first_seen_at))
  from public.owner_client_links links
  join public.clients clients on clients.id = links.client_id
  where links.owner_id = p_owner_id
    and clients.phone_e164 is not null
  group by clients.phone_e164
  on conflict (mastercrm_user_id, phone_e164) do update
  set first_seen_at = least(public.mastercrm_portfolio_contacts.first_seen_at, excluded.first_seen_at),
      last_seen_at = greatest(public.mastercrm_portfolio_contacts.last_seen_at, excluded.last_seen_at),
      updated_at = now();

  return jsonb_build_object(
    'replaced', v_replaced,
    'previousOwnerKey', v_previous_owner_key
  );
end;
$$;

create or replace function public.mastercrm_unlink_platform_owner_v1(
  p_mastercrm_user_id bigint,
  p_pagina text,
  p_edited_by text default 'mastercrm'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.mastercrm_user_owner_links%rowtype;
  v_other public.mastercrm_user_owner_links%rowtype;
begin
  select * into v_target from public.mastercrm_user_owner_links
  where mastercrm_user_id = p_mastercrm_user_id and pagina = p_pagina
  for update;
  if not found then return false; end if;

  select * into v_other from public.mastercrm_user_owner_links
  where mastercrm_user_id = p_mastercrm_user_id and pagina <> p_pagina
  for update;
  if v_other.id is not null then
    update public.mastercrm_platform_owner_pairs
    set active_to = greatest(clock_timestamp(), active_from + interval '1 microsecond'), edited_by = p_edited_by
    where active_to is null
      and ((p_pagina = 'RdA' and rda_owner_id = v_target.owner_id and asn_owner_id = v_other.owner_id)
        or (p_pagina = 'ASN' and asn_owner_id = v_target.owner_id and rda_owner_id = v_other.owner_id));
  end if;

  delete from public.mastercrm_user_owner_links where id = v_target.id;
  return true;
end;
$$;

create or replace function public.prevent_mastercrm_portfolio_marketing_budget_overlap_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    new.mastercrm_user_id::text || ':' || new.channel || ':' || new.campaign_key || ':' || new.ad_key,
    0
  ));
  if exists (
    select 1 from public.mastercrm_portfolio_marketing_daily_budgets existing
    where existing.mastercrm_user_id = new.mastercrm_user_id
      and existing.channel = new.channel
      and existing.campaign_key = new.campaign_key
      and existing.ad_key = new.ad_key
      and existing.id <> new.id
      and existing.active_from <= coalesce(new.active_to, 'infinity'::date)
      and new.active_from <= coalesce(existing.active_to, 'infinity'::date)
  ) then
    raise exception using errcode = '23P01',
      message = 'Marketing budget overlaps an existing period';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_mastercrm_portfolio_organic_budget_overlap_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.mastercrm_user_id::text, 0));
  if exists (
    select 1 from public.mastercrm_portfolio_organic_qr_daily_budgets existing
    where existing.mastercrm_user_id = new.mastercrm_user_id
      and existing.id <> new.id
      and existing.active_from <= coalesce(new.active_to, 'infinity'::date)
      and new.active_from <= coalesce(existing.active_to, 'infinity'::date)
  ) then
    raise exception using errcode = '23P01',
      message = 'Organic QR budget overlaps an existing period';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_mastercrm_portfolio_contacts_set_updated_at on public.mastercrm_portfolio_contacts;
create trigger trg_mastercrm_portfolio_contacts_set_updated_at before update on public.mastercrm_portfolio_contacts
for each row execute function public.set_updated_at();
drop trigger if exists trg_mastercrm_portfolio_routes_set_updated_at on public.mastercrm_portfolio_routes;
create trigger trg_mastercrm_portfolio_routes_set_updated_at before update on public.mastercrm_portfolio_routes
for each row execute function public.set_updated_at();
drop trigger if exists trg_mastercrm_portfolio_financial_settings_set_updated_at on public.mastercrm_portfolio_financial_settings;
create trigger trg_mastercrm_portfolio_financial_settings_set_updated_at before update on public.mastercrm_portfolio_financial_settings
for each row execute function public.set_updated_at();
drop trigger if exists trg_mastercrm_portfolio_monthly_ad_spend_set_updated_at on public.mastercrm_portfolio_monthly_ad_spend;
create trigger trg_mastercrm_portfolio_monthly_ad_spend_set_updated_at before update on public.mastercrm_portfolio_monthly_ad_spend
for each row execute function public.set_updated_at();
drop trigger if exists trg_mastercrm_portfolio_marketing_daily_budgets_set_updated_at on public.mastercrm_portfolio_marketing_daily_budgets;
create trigger trg_mastercrm_portfolio_marketing_daily_budgets_set_updated_at before update on public.mastercrm_portfolio_marketing_daily_budgets
for each row execute function public.set_updated_at();
drop trigger if exists trg_mastercrm_portfolio_marketing_daily_budgets_no_overlap on public.mastercrm_portfolio_marketing_daily_budgets;
create trigger trg_mastercrm_portfolio_marketing_daily_budgets_no_overlap
before insert or update of mastercrm_user_id, channel, campaign_key, ad_key, active_from, active_to
on public.mastercrm_portfolio_marketing_daily_budgets
for each row execute function public.prevent_mastercrm_portfolio_marketing_budget_overlap_v1();
drop trigger if exists trg_mastercrm_portfolio_organic_qr_daily_budgets_set_updated_at on public.mastercrm_portfolio_organic_qr_daily_budgets;
create trigger trg_mastercrm_portfolio_organic_qr_daily_budgets_set_updated_at before update on public.mastercrm_portfolio_organic_qr_daily_budgets
for each row execute function public.set_updated_at();
drop trigger if exists trg_mastercrm_portfolio_organic_qr_daily_budgets_no_overlap on public.mastercrm_portfolio_organic_qr_daily_budgets;
create trigger trg_mastercrm_portfolio_organic_qr_daily_budgets_no_overlap
before insert or update of mastercrm_user_id, active_from, active_to
on public.mastercrm_portfolio_organic_qr_daily_budgets
for each row execute function public.prevent_mastercrm_portfolio_organic_budget_overlap_v1();

alter table public.mastercrm_portfolio_contacts enable row level security;
alter table public.mastercrm_portfolio_contact_events enable row level security;
alter table public.mastercrm_portfolio_routes enable row level security;
alter table public.mastercrm_portfolio_financial_settings enable row level security;
alter table public.mastercrm_portfolio_monthly_ad_spend enable row level security;
alter table public.mastercrm_portfolio_marketing_daily_budgets enable row level security;
alter table public.mastercrm_portfolio_organic_qr_daily_budgets enable row level security;

grant select, insert, update, delete on table public.mastercrm_portfolio_contacts to service_role;
grant select, insert, update, delete on table public.mastercrm_portfolio_contact_events to service_role;
grant select, insert, update, delete on table public.mastercrm_portfolio_routes to service_role;
grant select, insert, update, delete on table public.mastercrm_portfolio_financial_settings to service_role;
grant select, insert, update, delete on table public.mastercrm_portfolio_monthly_ad_spend to service_role;
grant select, insert, update, delete on table public.mastercrm_portfolio_marketing_daily_budgets to service_role;
grant select, insert, update, delete on table public.mastercrm_portfolio_organic_qr_daily_budgets to service_role;
revoke all on function public.mastercrm_central_intake_v1(text, text, text, text, text, text, jsonb, timestamptz, integer) from public;
grant execute on function public.mastercrm_central_intake_v1(text, text, text, text, text, text, jsonb, timestamptz, integer) to service_role;
revoke all on function public.mastercrm_link_platform_owner_v1(bigint, uuid, text, boolean, text) from public;
grant execute on function public.mastercrm_link_platform_owner_v1(bigint, uuid, text, boolean, text) to service_role;
revoke all on function public.mastercrm_unlink_platform_owner_v1(bigint, text, text) from public;
grant execute on function public.mastercrm_unlink_platform_owner_v1(bigint, text, text) to service_role;
revoke all on function public.prevent_mastercrm_portfolio_marketing_budget_overlap_v1() from public;
revoke all on function public.prevent_mastercrm_portfolio_organic_budget_overlap_v1() from public;

commit;
