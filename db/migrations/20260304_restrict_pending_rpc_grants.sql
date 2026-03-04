begin;

revoke execute on function public.intake_pending_cliente(text, text, text) from public;
revoke execute on function public.intake_pending_cliente(text, text, text) from anon;
revoke execute on function public.intake_pending_cliente(text, text, text) from authenticated;
grant execute on function public.intake_pending_cliente(text, text, text) to service_role;

revoke execute on function public.assign_pending_username(text, text, text, text) from public;
revoke execute on function public.assign_pending_username(text, text, text, text) from anon;
revoke execute on function public.assign_pending_username(text, text, text, text) from authenticated;
grant execute on function public.assign_pending_username(text, text, text, text) to service_role;

commit;
