begin;

with ranked_links as (
  select
    id,
    row_number() over (
      partition by mastercrm_user_id
      order by updated_at desc, created_at desc, id desc
    ) as row_number
  from public.mastercrm_user_owner_links
)
delete from public.mastercrm_user_owner_links links
using ranked_links ranked
where links.id = ranked.id
  and ranked.row_number > 1;

create unique index if not exists uq_mastercrm_user_owner_links_single_owner
  on public.mastercrm_user_owner_links (mastercrm_user_id);

commit;
