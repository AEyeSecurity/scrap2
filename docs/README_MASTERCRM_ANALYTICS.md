# MasterCRM analytics and marketing budgets

## Scope

This document covers the CRM analytics model added for the executive dashboard and the deep statistics page.

Navigation:

- `Pagina Principal`: executive summary for the linked cashier.
- `Clientes`: operational client view that previously lived under statistics.
- `Estadisticas`: deep marketing analytics with filters, campaign/ad rankings, budget editor and audit panels.

The implementation does not use generated images or Docker image generation. Charts are rendered by the frontend with React/CSS/SVG.

## Database

Migration:

- `db/migrations/20260618_mastercrm_marketing_daily_budgets.sql`

New table:

- `public.owner_marketing_daily_budgets`

Main columns:

- `owner_id`: linked cashier owner.
- `channel`: `landing` or `meta_ctwa`.
- `level`: `campaign` or `ad`.
- `campaign_key`, `campaign_name`: exact values received from the acquisition source.
- `ad_key`, `ad_name`: exact values received for ad-level rows.
- `link_url`: ad or campaign link when available.
- `daily_budget_ars`: manual daily budget.
- `active_from`, `active_to`: inclusive validity window.
- `updated_by_mastercrm_user_id`: CRM user that edited the budget.

Budget spend for a query range is:

```text
daily_budget_ars * inclusive_days(overlap(active_from/active_to, date_from/date_to))
```

Campaign budgets count toward campaign and total ROI/ROAS. Ad budgets are used for ad ranking and ad ROI/ROAS. When a campaign has budget that is not distributed to ads, the UI shows it as undistributed budget.

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
- `campaigns`: campaign ranking and budget distribution.
- `ads`: ad ranking and available ad links.
- `clients`: attributable first-acquisition clients.
- `budgets`: active daily budget rows in range.
- `audit`: excluded and non-attributable data.

`POST /mastercrm-marketing-budgets`

Upserts one manual budget row.

Required fields:

- `user_id`
- `channel`
- `level`
- `campaign_key`
- `campaign_name`
- `daily_budget_ars`
- `active_from`

Optional fields:

- `id`
- `ad_key`
- `ad_name`
- `link_url`
- `active_to`

`POST /mastercrm-marketing-budgets/delete`

Payload:

```json
{
  "user_id": 16,
  "budget_id": "budget-row-id"
}
```

## Attribution and revenue rules

- Only `landing` and `meta_ctwa` are included in ROI/ROAS.
- `unknown` is excluded and counted in audit as `Sin dato`.
- `landing_unmatched` is excluded and counted separately.
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

## Operational checks

Before pushing a CRM analytics change:

1. Apply the database migration to the target Supabase project.
2. Run backend tests and build:
   - `npm test`
   - `npm run build`
3. Run frontend checks:
   - `npm run build`
   - `npm run lint`
4. Login to the local CRM with a real user and verify:
   - `Pagina Principal` loads the executive dashboard.
   - `Clientes` keeps the operational client view.
   - `Estadisticas` loads range/channel/campaign/ad filters.
   - Budget save changes ROI/ROAS and deleting the test budget returns investment to zero.
   - `Sin dato`, `Landing sin match`, reentries, missing budgets and negative adjustments appear in audit.
   - No unnecessary Docker images or generated image assets are created.
