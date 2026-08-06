alter table public.report_daily_snapshots
  alter column cargado_hoy drop not null;

comment on column public.report_daily_snapshots.cargado_hoy is
  'Daily amount reported by the platform or derived from consecutive monthly snapshots. Null means the baseline is unavailable.';
