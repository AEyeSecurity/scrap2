\set ON_ERROR_STOP on

insert into public.mastercrm_users(username, routing_key, password_hash, nombre)
select
  format('qa_dualcrm_pre_%s', to_char(i, 'FM00')),
  format('qa_dualcrm_pre_%s', to_char(i, 'FM00')),
  'qa-isolated-only',
  format('QA Dual CRM %s', i)
from generate_series(1, 10) i;

insert into public.owners(pagina, owner_key, owner_label)
select
  case when i % 2 = 0 then 'ASN' else 'RdA' end,
  format('qa_dualcrm_owner_%s', to_char(i, 'FM00')),
  format('QA Dual CRM Owner %s', i)
from generate_series(1, 14) i;

insert into public.mastercrm_user_owner_links(mastercrm_user_id, owner_id, pagina)
select users.id, owners.id, owners.pagina
from generate_series(1, 10) i
join public.mastercrm_users users
  on users.username = format('qa_dualcrm_pre_%s', to_char(i, 'FM00'))
join public.owners owners
  on owners.owner_key = format('qa_dualcrm_owner_%s', to_char(i, 'FM00'));
