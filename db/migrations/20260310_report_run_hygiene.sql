begin;

update public.report_runs
set contrasena_agente = '[redacted]'
where status in ('completed', 'completed_with_errors', 'failed', 'cancelled')
  and contrasena_agente <> '[redacted]';

update public.report_outbox ro
set status = 'consumed',
    consumed_at = coalesce(ro.consumed_at, now())
where ro.kind = 'asn_report_run_completed'
  and ro.status = 'pending'
  and exists (
    select 1
    from public.report_runs rr
    where rr.id = ro.run_id
      and rr.status in ('completed', 'completed_with_errors', 'failed', 'cancelled')
  );

commit;
