begin;

do $$
declare
  target_function record;
begin
  for target_function in
    select p.oid::regprocedure::text as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
  loop
    execute 'revoke execute on function ' || target_function.signature || ' from public, anon, authenticated';
    execute 'grant execute on function ' || target_function.signature || ' to service_role';
  end loop;
end
$$;

commit;
