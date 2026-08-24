# Netlify Usage Dashboard

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/netlify-labs/netlify-usage-dashboard)

A self-hostable dashboard and API guide for your **Netlify Usage API**, the private,
read-only service Netlify runs for you that serves your organization's usage and billing
data. This repo gives you two things:

1. **A dashboard** (charts, tables, CSV export) you deploy as a Netlify site. The API
   base URL and your API key live in the site's environment variables; every page load
   makes fresh, key-authenticated API requests server-side. Nothing is cached and the
   key never reaches the browser.
2. **This README**, a complete guide to calling the API directly from your own scripts,
   BI tools, or finance pipelines.

You need two values from Netlify to use either: your **API base URL** (an opaque
`https://xxxx.netlify.app` address) and your **`CUSTOMER_API_KEY`** (a bearer token).
Contact your Netlify **Account Executive** or the **Customer Success team** to get
these values, rotate a key, or add one.

---

## TL;DR

- Every request: `Authorization: Bearer <CUSTOMER_API_KEY>` against your base URL.
- `GET /v1/usage?start=YYYY-MM-DD&end=YYYY-MM-DD&granularity=month|day` returns all usage,
  members, geo, functions, and credits data as JSON.
- `GET /v1/allocation?start=&end=&format=csv|json` returns the finance driver table
  (month x host x country x product feature, with credits and dollars).
- Always read `meta.coverage` and `meta.warnings` before trusting numbers: the response
  tells you which part came from live sources vs stored snapshots, and what degraded.
- To run the dashboard: click **Deploy to Netlify** above and enter your API base URL
  and API key when prompted. Done.

---

## The API

### Authentication

All data endpoints require a bearer token:

```
Authorization: Bearer <CUSTOMER_API_KEY>
```

- Keys are compared timing-safely on the server. There is no session, cookie, or OAuth
  flow; the key is the credential.
- More than one key can be active at once, so you can rotate keys without downtime. Ask
  Netlify to add a new key, migrate your callers, then ask for the old one to be revoked.
- The key proves *who you are*. *What data you can see* is fixed server-side to your
  organization's Netlify accounts and cannot be widened by any request parameter. A leaked
  key exposes only your own data, but treat it like a password and store it in a secret
  manager, never in code or a URL.
- A missing or wrong key returns `401 {"error":{"status":401,"message":"Unauthorized"}}`.

### Endpoints at a glance

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/usage` | Bearer | All usage, members, geo, functions, and credits data (JSON) |
| GET | `/v1/allocation` | Bearer | Finance driver table with per-host credits and dollars (CSV or JSON) |
| GET | `/v1/health` | none | Liveness probe |
| GET + POST | `/report` | key in form | Server-rendered HTML report, no tooling needed |

Rate limits are modest (roughly 20 to 30 requests per minute per endpoint). These are
reporting endpoints; poll daily or hourly, not per second.

---

### GET /v1/usage

The main endpoint. One call returns everything the service knows for a date range.

**Query parameters** (unknown or duplicated parameters are rejected):

| Param | Required | Format | Notes |
|---|---|---|---|
| `start` | yes | `YYYY-MM-DD` | Inclusive |
| `end` | yes | `YYYY-MM-DD` | **Exclusive.** For "all of July" use `start=2026-07-01&end=2026-08-01` |
| `granularity` | no | `month` (default) or `day` | Bucket size for the `by_period` series |

Max span is about 5 years. Dates must be real calendar dates from 2020 onward.

**Example:**

```bash
curl -s \
  -H "Authorization: Bearer $CUSTOMER_API_KEY" \
  "$USAGE_API_URL/v1/usage?start=2026-01-01&end=2026-07-01&granularity=month"
```

**Response shape** (values illustrative):

```jsonc
{
  "meta": { /* see "Reading meta" below - read this first */ },
  "usage": {
    "by_period":    [{ "period": "2026-06-01", "bandwidth_tb": 12.345, "web_requests": 987654321 }],
    "by_account":   [{ "account_id": "61f9...", "account_slug": "my-team", "bandwidth_tb": 9.87, "web_requests": 123 }],
    "by_site":      [{ "host": "www.example.com", "account_id": "61f9...", "accounting": "web-core",
                       "owner": "team@example.com", "bandwidth_tb": 4.2, "web_requests": 456 }],
    "by_accounting":[{ "key": "web-core", "bandwidth_tb": 6.1, "web_requests": 789, "sites": 14 }],
    "by_owner":     [{ "key": "team@example.com", "bandwidth_tb": 3.3, "web_requests": 321, "sites": 6 }]
  },
  "members": {
    "by_role": [{ "role": "Developer", "count": 42 }],
    "billable": 55,
    "git_contributors": 61
  },
  "geo": {
    "note": "full requested range, from daily snapshots",
    "by_country":       [{ "country": "US", "bandwidth_gb": 812.4 }],
    "by_server_region": [{ "cdn_region": "us-east-1", "bandwidth_gb": 500.1, "requests": 123456 }]
  },
  "functions": {
    "note": "full requested range, from daily snapshots (p95 is the worst day in range - percentiles do not sum)",
    "serverless": [{ "name": "api-handler", "invocations": 1200000, "avg_ms": 45, "p95_ms": 210 }],
    "edge":       [{ "name": "geo-router", "invocations": 9000000 }]
  },
  "credits": {
    "consumed": 125000,
    "invoiced_usd": 21000,
    "by_category": [{ "category": "Bandwidth", "credits": 90000 }],
    "included_vs_overage": { "granted": 500000, "consumed": 125000, "remaining": 375000, "overage": 0 },
    "rate_card": [{ "name": "Bandwidth", "rate": 10, "unit": "gigabytes" }]
  },
  "product_crosswalk": { "status": "...", "mapping": [ /* maps contract line items to usage meters */ ] }
}
```

Field notes:

- `usage.by_site` is capped to the **top 25 sites** by bandwidth over the range. For the
  full per-host detail use `/v1/allocation`.
- `usage.by_accounting` and `usage.by_owner` group sites by the `accounting:` and `owner:`
  labels set on each site in Netlify. Unlabeled sites roll up under `(unlabeled)`; keeping
  labels current is what makes these views (and cost allocation) useful.
- `members` is a point-in-time count (the latest within the range), not a time series.
- `geo` and `functions` carry a `note` field telling you what window the data actually
  covers. Their upstream sources only retain 1 to 4 days, so historical coverage comes
  from daily snapshots that accumulate going forward from when the service was set up.
- `credits` can be `null` if the billing source did not answer; a warning will say so.
- `p95_ms` for a multi-day range is the worst single day, because percentiles cannot be
  averaged or summed.

### Reading `meta` (do this before trusting any number)

Every `/v1/usage` response is wrapped in an envelope that makes data provenance explicit:

```jsonc
"meta": {
  "org": "your-org-id",
  "generated_at": "2026-08-24T17:00:00.000Z",
  "period": { "start": "2026-01-01", "end": "2026-07-01", "granularity": "month" },
  "freshness": {
    "usage_note": "live usage is near-real-time...; older periods are served from monthly snapshots",
    "credits_lag_hours": 48,
    "current_period_provisional": true
  },
  "coverage": {
    "store": "netlify-db",
    "history": { "start": "2026-01-01", "end": "2026-05-01" },
    "live":    { "start": "2026-05-01", "end": "2026-07-01" },
    "source_cutoff": "2026-05-01"
  },
  "sources": { "usage": "clickhouse", "credits": "orb", "history": "netlify-db (neon)" },
  "warnings": ["credits.served_from_history"]
}
```

- **`coverage`**: live sources retain roughly the last 90 days; everything older is served
  from monthly snapshots kept for you indefinitely. `history` and `live` show exactly
  where the seam fell. The two halves never overlap and never leave a gap.
- **`freshness`**: usage is near real time; **credits lag about 48 hours**; the current
  billing period is always provisional and will move until it closes.
- **`warnings`**: sections that degraded. The response still succeeds; the named section
  may be empty or served from a fallback. Common values: `credits` (billing source did not
  answer), `credits.served_from_history`, `history.not_configured`, and section labels
  like `usage.by_period` or `geo.by_country` when a live source failed. An empty section
  with a warning means "unavailable", not "zero".

### GET /v1/allocation

The finance export: a driver table with one row per **month x host x country x product
feature**, carrying usage, credits, and dollars, plus which internal cost group each
hostname belongs to. CSV by default (opens directly in Excel or Google Sheets).

**Query parameters:**

| Param | Required | Format | Notes |
|---|---|---|---|
| `start` | yes | `YYYY-MM-DD` | Snapped back to the start of its month |
| `end` | yes | `YYYY-MM-DD` | Must be after `start`; max 24 months per request |
| `format` | no | `csv` (default) or `json` | |

**Examples:**

```bash
# CSV for finance (the Content-Disposition filename carries the range)
curl -s -H "Authorization: Bearer $CUSTOMER_API_KEY" \
  "$USAGE_API_URL/v1/allocation?start=2026-01-01&end=2026-07-01" \
  -o netlify-allocation.csv

# JSON for programmatic use
curl -s -H "Authorization: Bearer $CUSTOMER_API_KEY" \
  "$USAGE_API_URL/v1/allocation?start=2026-01-01&end=2026-07-01&format=json"
```

**CSV columns / JSON row fields:** `month, host, site_id, customer, country,
product_feature, bandwidth_bytes, web_requests, credits, usd`.

**How the numbers are derived.** This endpoint computes credits from stored usage at your
contracted rates; it does not restate your invoice. Four rules govern it:

1. **Contracted rates win.** Rates come from your rate card. If a meter is missing from
   it, Netlify's published rate is used as a fallback and the month's reconciliation
   names the meter in `rates_fell_back_to`.
2. **Only per-host meters are allocated.** Bandwidth and web requests carry a site
   dimension, so they can be attributed to hosts. Compute, deploys, forms, and AI cannot;
   they appear as an explicit **unallocated remainder** in the reconciliation rather than
   being spread across hosts (spreading would invent attribution).
3. **Location splits usage, it does not create it.** A host's credits are apportioned
   across countries by that host's own traffic mix. A host with no geo data gets a single
   `(unknown)` country row.
4. **Dollars are blended.** `usd` is the host's share of consumed credits times invoiced
   dollars for the month: an effective rate, not a line-item price.

**Reconciliation block** (JSON format, one per month; check it before using totals):

```jsonc
{
  "month": "2026-06",
  "allocated_credits": 98000,
  "allocated_bandwidth_credits": 90000,
  "allocated_request_credits": 8000,
  "unallocated_credits": 27000,      // consumed credits with no host attribution
  "consumed_credits": 125000,
  "invoiced_usd": 21000,
  "rates_fell_back_to": [],          // empty is the good case
  "location_unavailable": false      // true = every row is country "(unknown)"
}
```

If the history store behind this endpoint is not ready you get
`409 {"status":"unavailable","reason":"..."}` rather than a silently empty file.

### GET /v1/health

No auth. Returns liveness and whether the service is configured (booleans only, no data).
Suitable for uptime monitors.

### /report (no tooling required)

Open `$USAGE_API_URL/report` in a browser, enter a date range and your API key in the
form, and get a server-rendered HTML report over the same data, including the allocation
table for ranges up to 6 months. The key is sent in the POST body, never in the URL.

### Errors

All errors share one JSON shape and never leak internals:

```json
{ "error": { "status": 400, "message": "Validation failed",
             "details": [{ "field": "end", "message": "must be after start" }] } }
```

| Status | Meaning |
|---|---|
| 400 | Bad parameters (`details` says which field and why) |
| 401 | Missing or invalid bearer key |
| 404 | Unknown path |
| 409 | `/v1/allocation` only: history store not available |
| 429 | Rate limited; back off and retry |
| 500 | Server-side problem; safe to retry later |

---

## The dashboard

A single-page dashboard in the same spirit as the `/report` page but interactive: summary
cards, an overview of charts (bandwidth and request trends, credits by category, top
sites, geo split), and tabbed tables for every section of `/v1/usage`, plus an Allocation
tab with the reconciliation and a CSV download. A freshness strip surfaces
`meta.coverage` and `meta.warnings` on every load, and a JSON tab shows the raw response.

### How authentication works (and why there is a proxy)

Both halves of the credential are environment variables on the dashboard site:
`USAGE_API_URL` (where to call) and `CUSTOMER_API_KEY` (the bearer token). The browser
calls `/api/usage`, `/api/allocation`, and `/api/health` on this site; one serverless
function (`netlify/functions/usage-proxy.mts`) attaches the key server-side, forwards
only the allowlisted query parameters, and streams the response back. Every dashboard
load is a fresh authenticated API request; nothing is cached or stored, and the key
never ships to a browser. The proxy is also what makes a browser client possible at all,
since the usage API sends no CORS headers. It is read-only, GET-only.

The flip side of holding the key server-side: **anyone who can reach the dashboard URL
can read the data.** Treat the URL as private, and if it will be shared beyond the people
who should see usage data, put Netlify site protection (password or team-member access)
in front.

### Deploy (about 2 minutes)

**One click.** Use the **Deploy to Netlify** button at the top of this README. Netlify
clones the repo into your own Git account, prompts you for the two values this app needs
(they are declared in `netlify.toml` under `[template.environment]`), and deploys:

- `USAGE_API_URL`: your API base URL, the opaque `https://....netlify.app` address
  Netlify gave you
- `CUSTOMER_API_KEY`: the API key you were issued

Don't have these values? Contact your Netlify Account Executive or the Customer Success
team. Then open the site, pick a range, and click **Load Data**.

**Or manually.** Push this repo to your Git provider and create a Netlify site from it
(or run `netlify deploy --prod` with the [Netlify CLI](https://docs.netlify.com/cli/get-started/)).
There is no build step: it publishes `public/` and deploys the one function. Set the same
two environment variables on the site (see `.env.example`), marking `CUSTOMER_API_KEY`
as a secret, and redeploy so they take effect.

### Local development

```bash
npm install
cp .env.example .env   # fill in values; netlify dev picks up .env
npx netlify dev        # serves the page + proxy at http://localhost:8888
```

### Repo layout

```
public/index.html                    the dashboard (single file, Chart.js from CDN)
netlify/functions/usage-proxy.mts    server-side proxy holding CUSTOMER_API_KEY
netlify.toml                         publish dir, function dir, security headers
.env.example                         the two environment variables you set
```

---

## Practical notes and gotchas

- **`end` is exclusive everywhere.** "January through June" is
  `start=2026-01-01&end=2026-07-01`.
- **Recent months are live, older months are snapshots.** The seam is reported in
  `meta.coverage` and moves forward daily. Numbers for a closed month are stable; the
  current month moves.
- **Credits lag about 48 hours** and the current period is provisional. Do not reconcile
  finances against a month until it has been closed for a couple of days.
- **Warnings are not errors.** A section named in `meta.warnings` degraded; its data may
  be empty or from a fallback. Retry later or contact Netlify if it persists.
- **Geo and per-function history accumulate going forward** from when the service was
  provisioned; ranges before that report geo as unavailable or `(unknown)`.
- **Site labels drive attribution.** The `accounting:` and `owner:` labels on each Netlify
  site power the cost-group views and the `customer` column of the allocation. Keeping
  them current is the highest-leverage thing you can do for chargeback quality.
- **Keep ranges reasonable.** Whole months at `granularity=month` for reporting;
  `granularity=day` is best for ranges of about 90 days or less.
