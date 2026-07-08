# MasterCRM analytics and marketing budgets

## Scope

This document covers the CRM analytics model added for the executive dashboard and the deep statistics page.

Navigation:

- `Pagina Principal`: executive summary for the linked cashier.
- `Clientes`: new-client view for the selected month.
- `Estadisticas`: deep marketing analytics for new clients, with filters, campaign/ad rankings, budget editor and audit panels.

The implementation does not use generated images or Docker image generation. Charts are rendered by the frontend with React/CSS/SVG.

## Database

Migration:

- `db/migrations/20260618_mastercrm_marketing_daily_budgets.sql`
- `db/migrations/20260619_mastercrm_technical_retention.sql`
- `db/migrations/20260701_mastercrm_technical_retention_preserve_snapshots.sql`
- `db/migrations/20260619_mastercrm_ad_budget_distribution.sql`
- `db/migrations/20260708_mastercrm_new_client_monthly_facts.sql`

Tables:

- `public.owner_marketing_daily_budgets`
- `public.owner_new_client_monthly_facts`

Main columns:

- `owner_id`: linked cashier owner.
- `channel`: `landing` or `meta_ctwa`.
- `level`: always `ad`.
- `campaign_key`, `campaign_name`: exact values received from the acquisition source.
- `ad_key`, `ad_name`: exact values received for the ad.
- `link_url`: ad link when available.
- `daily_budget_ars`: manual daily budget.
- `active_from`, `active_to`: inclusive validity window.
- `updated_by_mastercrm_user_id`: CRM user that edited the budget.

Budget spend for a query range is:

```text
daily_budget_ars * inclusive_days(overlap(active_from/active_to, date_from/date_to))
```

Campaign investment is calculated as the sum of the campaign's ad budgets. Campaign-level budget rows are not supported and are deleted by `20260619_mastercrm_ad_budget_distribution.sql`.

`owner_new_client_monthly_facts` stores durable monthly facts for clients whose first intake belongs to the closed month. The retention worker refreshes these facts before technical history is purged, so closed monthly new-client KPIs survive even when old report runs are deleted.

## Backend endpoints

All endpoints require the MasterCRM bearer token and enforce the authenticated user id.

`POST /mastercrm-analytics`

Payload:

```json
{
  "user_id": 16,
  "date_from": "2026-06-01",
  "date_to": "2026-06-18",
  "channel": "all",
  "campaign_key": "",
  "ad_key": ""
}
```

Response includes:

- `summary`: ROI, ROAS, investment, revenue, estimated profit, leads, assigned, depositors, CPL, cost per depositor and conversion rates.
- `channels`: channel-level metrics.
- `campaigns`: campaign ranking; investment is summed from ad budgets.
- `ads`: ad ranking and available ad links.
- `clients`: attributable first-acquisition clients.
- `budgets`: active daily budget rows in range.
- `audit`: excluded and non-attributable data.

`POST /mastercrm-marketing-budgets`

Upserts one manual budget row.

Required fields:

- `user_id`
- `channel`
- `level` as `ad`
- `campaign_key`
- `campaign_name`
- `ad_key`
- `daily_budget_ars`
- `active_from`

Optional fields:

- `id`
- `ad_name`
- `link_url`
- `active_to`

`POST /mastercrm-marketing-budgets/distribute`

Atomically splits one total daily budget across multiple ads from one channel. The operation saves individual ad-level budget rows and fails if any selected ad has an overlapping validity window.

Payload:

```json
{
  "user_id": 16,
  "total_daily_budget_ars": 1000,
  "active_from": "2026-06-01",
  "active_to": "2026-06-19",
  "ads": [
    {
      "channel": "meta_ctwa",
      "campaign_key": "Reino Dorado",
      "campaign_name": "Reino Dorado",
      "ad_key": "120250708847350471",
      "ad_name": "120250708847350471",
      "link_url": "https://..."
    },
    {
      "channel": "meta_ctwa",
      "campaign_key": "Reino Dorado",
      "campaign_name": "Reino Dorado",
      "ad_key": "120250708847350472",
      "ad_name": "120250708847350472"
    }
  ]
}
```

Rules:

- minimum 2 ads;
- exactly one channel per operation;
- no duplicate ad keys inside the same campaign/channel;
- no overlaps with existing ad budget validity windows;
- cents are distributed deterministically so the saved rows sum exactly to `total_daily_budget_ars`.

`POST /mastercrm-marketing-budgets/delete`

Payload:

```json
{
  "user_id": 16,
  "budget_id": "budget-row-id"
}
```

## Attribution and revenue rules

- CRM visible KPIs use only new clients: the client's first chronological `intake` must be inside the selected month or range.
- Backlog, old portfolio clients and reentries are excluded from visible CRM KPIs and campaign/ad ROI.
- `unknown` and `landing_unmatched` new clients count as organic in the global summary when no campaign/ad filter is active; they do not appear in campaign/ad rankings.
- Attribution is first acquisition per cashier and client. Later intakes are counted as reentries in audit, not duplicated as new ROI leads.
- `cargado_mes` is treated as a monthly snapshot, not as a daily additive value.
- Range revenue is calculated from snapshot deltas inside each month.
- Cross-month ranges are split by month and summed.
- Negative deltas are audit adjustments and are not mixed into positive revenue.

Formulas:

```text
estimated_profit = revenue_ars * commission_pct
ROI = (estimated_profit - investment_ars) / investment_ars
ROAS = revenue_ars / investment_ars
CPL = investment_ars / leads
cost_per_depositor = investment_ars / depositors
lead_to_assigned = assigned / leads
lead_to_depositor = depositors / leads
average_revenue = revenue_ars / depositors
```

If investment is zero, ROI, ROAS, CPL and cost per depositor are returned as null and the UI shows them as no investment.

## Supabase pagination and retention

CRM reads that can exceed Supabase's default 1000-row response limit must use paginated selects with `.range(...)`.
This is required for:

- `owner_client_events`
- `report_daily_snapshots`
- `owner_client_monthly_facts`
- `owner_marketing_daily_budgets`

The retention RPC is:

```sql
select * from public.purge_mastercrm_technical_history_v1(date '2026-06-01');
```

It deletes only technical history before the cutoff month:

- `report_runs`, with cascade to `report_run_items` and `report_outbox`
- terminal `meta_conversion_outbox` rows with status `sent`, `failed` or `discarded`
- old `landing_sessions`, keeping a 48 hour safety margin before the cutoff

It never deletes business attribution records:

- `clients`
- `owner_client_links`
- `owner_client_identities`
- `owner_client_events`
- `owner_client_monthly_facts`
- `owner_marketing_daily_budgets`
- `owner_financial_settings`

Retention worker env:

```env
MASTERCRM_RETENTION_ENABLED=true
MASTERCRM_RETENTION_RUN_ON_START=true
MASTERCRM_RETENTION_POLL_MS=86400000
```

The worker calculates the cutoff as the first day of the current month in `America/Argentina/Buenos_Aires`.
Before purging, it calls:

```sql
select public.refresh_mastercrm_closed_new_client_monthly_facts_v1(date '2026-08-01');
```

That closes all new-client months from July 2026 onward before the cutoff.
If the purge fails, it logs the error and the API keeps running.

## Operational checks

Before pushing a CRM analytics change:

1. Apply the database migration to the target Supabase project.
2. Run backend tests and build:
   - `npm test`
   - `npm run build`
3. Verify `/mastercrm-clients` for `luqui10` and July 2026 returns only new clients; current expected production data is 1 new client and ARS 0 load.
4. Run frontend checks:
   - `npm run build`
   - `npm run lint`
5. Login to the local CRM with a real user and verify:
   - `Pagina Principal` loads the executive dashboard.
   - `Clientes` lists only new clients for the selected month.
   - `Estadisticas` loads range/channel/campaign/ad filters and keeps campaign/ad rows limited to attributed new clients.
   - Individual ad budget save changes ROI/ROAS and deleting the test budget returns investment to zero.
   - Selecting 2+ ads from one channel and saving a distributed budget creates individual ad budget rows whose daily sum matches the entered total.
   - `Sin dato`, `Landing sin match`, organic leads, missing budgets and negative adjustments appear in audit.
   - No unnecessary Docker images or generated image assets are created.
