# OpenVibe.Report

> Every number on OpenVibe, honest.

**Live site:** https://openvibe.report · **API docs:** https://openvibe.services · **For AI:** https://openvibe.report/llms.txt
**Run it:** `npm ci && npm run dev` (Node 22 or newer) · **Tests:** `npm test`

**Status:** v0.1.0 service, now with its own analytics database and a shadow of Network's numbers (REP-2, plan
2026-10-28 §4.8 and §5.4). The pages still read where they read today; `REPORT_SOURCE=report` switches the numbers
when the cutover is approved.
**Domain:** `openvibe.report` · **Port:** 5080 · **Service id:** `report` · **Env prefix:** `OV_` / `REPORT_`
**License:** AGPL-3.0 (same as every OpenVibe service).

The Report room of the OpenVibe network: the open numbers every site publishes, The Rundown of what streamers talked
about, and each stream's after-show report.

## Purpose

OpenVibe.Report is the analytics authority in shadow:

- It **ingests** the analytics OpenVibe.Network records — `live.stream.ended` for creator analytics and the shared
  navbar's anonymous frame beacon — and Network's open-stats answer (`GET /api/v1/stats?days=7|30|90`) into its own
  PostgreSQL tables (migrations/).
- It **computes** the same numbers Network answers, site-wide, per site and per channel, by UTC day.
- It **quotes money from OpenVibe.Billing** through Billing's read API; it never derives a price, fee or amount.
- It **shadows the AI Exchange** behind `REPORT_AI_EXCHANGE` (off): Billing's `billing.credit.settled@1`
  settlements are summed by UTC day, resolved exact model id and provider access. The raw settlement is not stored,
  and Report never sets a rate, a price or a balance.
- It **shadows**: a job compares the same window from Network and from Report's tables and records every difference
  in `report_shadow_diffs`.

The pages and `GET /api/v1/stats` answer from `REPORT_SOURCE`, which defaults to `network`: today's behaviour. Setting
`REPORT_SOURCE=report` makes them answer from Report's tables. The Rundown and after-show reports still come from
OpenVibe.Live in both modes.

| Source | Read | Used for |
|---|---|---|
| **OpenVibe.Network** | `GET /api/v1/stats?days=7\|30\|90` | `/`, `/stats`, `GET /api/v1/stats` while `REPORT_SOURCE=network`; also the ingest source |
| **Report's tables** | `report_metric_days`, `report_metric_windows`, `report_streams` | the same routes while `REPORT_SOURCE=report` |
| **OpenVibe.Live** — The Rundown | `GET /api/rundown/`, `/api/rundown/topics`, `/api/rundown/t/:slug`, `/api/rundown/e/:streamId`, `/api/rundown/s/:username` | `/rundown`, `/rundown/t/:slug`, `/rundown/e/:streamId`, `/rundown/s/:username` |
| **OpenVibe.Live** — after-show reports | `GET /api/recap/:streamId`, `GET /api/recap/channel/:username` | `/after-show/:streamId`, `/c/:username` |
| **OpenVibe.Bench** | `GET /api/v1/kinds`, `/api/v1/boards/:kind?type=elo\|pareto\|cost`, `/api/v1/benchmarks`, `/api/v1/rankings`, `/api/v1/runs`, `/api/v1/overview`, `/api/v1/models/:model`, `/api/v1/models/:model/summary` | `/ai`, `/ai/:kind`, `/ai/<benchmark>`, `/ai/models/:model`, `/ai/compare`, `/ai/method`, `/ai/feed.xml`, `GET /api/v1/ai/results` |
| **OpenVibe.AI** | `GET /api/v1/exchange/catalog` | `GET /api/v1/ai/leaderboard`, `/api/v1/ai/models/:id`, `/api/v1/ai/providers`, `/api/v1/ai/compare?models=`, `/api/v1/ai/picks` |
| **OpenVibe.Billing** | `GET /api/v1/stats`, `GET /api/v1/transactions?subject=…` | the revenue read for a channel; network money counts |
| **OpenVibe.Billing** — settlements, through Events | `billing.credit.settled@1` on `POST /internal/events` (only with `REPORT_AI_EXCHANGE=1`) | the AI Exchange aggregates and the staff page/API |

A source that does not answer is null, after one short log line; the page (or API route) becomes a 404. The service
never invents a zero and never throws a source error at the reader.

## What Report owns now

- **The analytics tables** in `migrations/0001_initial.sql`: `report_inbox` (event ids already handled),
  `report_events`, `report_streams`, `report_frame_days`, `report_metric_days`, `report_metric_windows`,
  `report_metric_json`, `report_dimensions`, `report_shadow_runs` and `report_shadow_diffs`.
- **The AI meter** in `migrations/0002_ai_usage.sql` and `0003_ai_usage_surface.sql`: `report_ai_usage` (raw calls,
  kept 90 days) and `report_ai_usage_days`; the consumer is `server/analytics/ai-usage.js`.
- **The AI Exchange aggregates** in `migrations/0005_ai_exchange.sql`: `report_ai_exchange_days` (day, model,
  provider access, requests, sandbox requests, the four token counts, exact nano-USD retail/shortfall/supply/margin),
  `report_ai_exchange_seen` (settlement ids already counted) and `report_ai_exchange_rejected` (invalid payloads).
  The consumer is `server/analytics/ai-exchange.js`.
- **The computation** in `server/analytics/`: `ingest.js` (idempotent writes), `query.js` (Network's stats shape and
  a channel's creator analytics), `shadow.js` (the comparison), `ai-exchange.js` (the Exchange aggregates).
- **The jobs** in `server/jobs/analytics.js`: ingest every five minutes (7, 30 and 90-day windows) and shadow every
  fifteen minutes (7 days by default).

## Does not own

- **Money** — OpenVibe.Billing. Report reads it with `billing.stats.read` and `billing.balance.read`; it holds no
  ledger and computes no price.
- **The Rundown and the after-show reports** — OpenVibe.Live. Report quotes them, including their counts and text.
- **The benchmark results** — OpenVibe.Bench. Report renders its rows and never derives a score, cost or time; Bench stayed the authority when its public pages moved here (2026-11-08) and its old HTML pages answer 301 to `/ai` counterparts.
- **Identity, sessions and writes** — Report has no sign-in, no cookies and no public write route. `POST
  /internal/events` is loopback-only and HMAC-verified.
- **The Shared Frame** — `openvibe-shared` (navbar, footer, theme-loader, static files), served from this site's own
  pinned copy at `/shared/*`.

## Pages

All server-rendered in `server/views/index.js`; every dynamic value goes through `esc()`.

| Page | What it shows |
|---|---|
| `/` | the 7-day open numbers, the Rundown's counts and lead, and the trending topics |
| `/stats?days=7\|30\|90` | the network totals and a first look at every site (anything else is 30) |
| `/me?days=7\|30\|90` | **signed in only, private, noindex**: your sites and activity (Network's history), what you made, your AI and Vibes, with a switch per section to publish it (the owner, 2026-11-09) |
| `/u/:username` | a person's published stats: only the sections they turned on, with Person JSON-LD; noindex and no numbers until they publish |
| `/rundown` | on air, the lead, the latest streams and every topic; canonical is OpenVibe.Live's `/rundown` |
| `/rundown/t/:slug` | one topic, its takes and related topics; canonical is Live's `/rundown/t/:slug` |
| `/rundown/e/:streamId` | one stream as an episode, with its segments; canonical is Live's `/rundown/e/:streamId` |
| `/rundown/s/:username` | one streamer's episodes and topics; canonical is Live's `/rundown/:username` |
| `/after-show/:streamId` | one after-show report |
| `/c/:username` | one channel's latest after-show reports |
| `/ai` | the AI overview: every published benchmark with its leader, runs and last run; every task kind with its leader, quality, cost and speed; a link to the method and compare pages |
| `/ai/:kind` | one task kind: Elo rank, quality against cost, cost per solved, the verified runs on its benchmarks, and the latest runs |
| `/ai/<benchmark>` | one public Bench benchmark: verified rankings with score, cost, speed and last run, a score-against-cost SVG, and the latest runs |
| `/ai/models/:model` | a model's runs over time, its best and worst tasks, cost, per-benchmark record and recent runs |
| `/ai/compare` | two or three models on the same benchmarks, side by side |
| `/ai/method` | how a score is made, how runs are judged, verified vs submitted, and what the counts mean |
| `/ai/feed.xml` | new public runs as RSS; the same rows are `GET /api/v1/ai/results` |
| `/ai/exchange` | **staff only**, with `REPORT_AI_EXCHANGE=1`: Billing's settlements by day, model and access, a daily chart and the exact amounts. Needs a signed-in person whose staff role holds `staff.site.view` |

A bad path parameter (slug, stream id, username) or a source that answered nothing renders `views.notFound()` with
status 404. Pages are `Cache-Control: public, max-age=120`.
AI pages use a 60-second Bench read cache and serve its last good copy with the read time during an outage. Their
HTML is `no-store` so the outage notice stays current.

## API

All under `/api/v1`, CORS `*`, `Cache-Control: public, max-age=120` (the popularity pair: 300), 120 requests a minute per address:

```
GET /api/v1/stats?days=7|30|90        REPORT_SOURCE=network|report
GET /api/v1/popular?limit=5           the front door's ranked sites and tools (public, aggregate)
GET /api/v1/popular/co-usage          opt-in site pairs for "Try next", small groups omitted
GET /api/v1/rundown
GET /api/v1/rundown/topics
GET /api/v1/rundown/t/:slug
GET /api/v1/after-show/:streamId
GET /api/v1/c/:username
GET /api/v1/ai/results            the new AI runs, newest first
GET /api/v1/me/stats?days=7|30|90  the signed-in person's own numbers (private, no-store)
PUT /api/v1/me/stats/published    the five per-section switches (same-origin, JSON)
GET /api/v1/u/:name/stats         only the sections that person published (404 when none)
```

A bad parameter or a missing source answer is a 404 `application/problem+json` body built with
`openvibe-contracts` `http.sendProblem`. The API is read-only except for the person's own publish switches; other
methods get 405. `GET /api/v1/me/stats` and `PUT /api/v1/me/stats/published` answer the `report.me-stats@1` document
(the switch request is `report.me-stats-publish@1`); the public route copies only the published sections from the
person's last snapshot, so a section a source did not answer for is absent, never a zero.

`/api/v1/popular` ranks Report's own daily and window numbers: opens today (UTC, still counting) and over seven days,
the seven before that for growth, and the distinct signed-in people Network's cross-site history counts. A tool is a
destination beside a site. The answer is public and aggregate only, held five minutes. `/api/v1/popular/co-usage`
reads only people who switched their `sites` section public (`report_me_stats.published`); it returns pair counts, never
a person, username or subject, and a pair below three people is left out.

The AI Exchange JSON read is the staff exception (with `REPORT_AI_EXCHANGE=1`): a Network service token with the
same `report.ai_usage.read` capability the AI meter uses, never cached, no person or project in the answer. The
HTML page is gated by the signed-in person's staff role (`staff.site.view`) instead, like the other staff pages.

```
GET /api/v1/ai/exchange?from=YYYY-MM-DD&to=YYYY-MM-DD   the Exchange aggregates, staff only
```

### Internal (loopback only)

```
POST /internal/events                       OpenVibe.Events delivery (v2 HMAC, REPORT_EVENTS_SECRET)
GET  /internal/shadow?days=7&limit=5        the latest shadow runs and their differences
POST /internal/shadow?days=7                run a comparison now
GET  /internal/metrics?scope=&id=&days=     the flat report.metric@1 rows
GET  /internal/channels/:channel/analytics  a channel's creator analytics plus Billing revenue
```

nginx refuses `/internal/` from outside; the app also checks the socket is loopback. The flat rows are proposed as
`report.metric@1` in [docs/report.metric.v1.json](docs/report.metric.v1.json) for Contracts to own.

## Ingest and idempotency

- `live.stream.ended` → one `report_streams` row (same fields as Network's `creator_streams`) and the channel/day
  counts. A redelivered event id is a no-op; a corrected copy with a new event id replaces the stream and does not
  count it twice.
- `network.frame.hit` / `network.frame.day` → `report_frame_days` (day, host, hits).
- `GET /api/v1/stats` → `report_metric_days`, `report_metric_windows`, `report_metric_json` and site dimensions,
  keyed by the answer's content hash. Polling the same numbers again is a no-op.
- Every delivery is claimed in `report_inbox` (openvibe-sdk/events `createPgInbox`) in the same transaction as its
  writes.
- `billing.credit.settled` (with `REPORT_AI_EXCHANGE=1`) → `report_ai_exchange_days`, keyed by day, model and
  provider access, and `report_ai_exchange_seen` by settlement id. The payload is validated against
  `billing.credit.settled@1`; an invalid one is counted in `report_ai_exchange_rejected` and never aggregated.
  Replaying the same settlement under a new event id counts once. A sandbox settlement only increments
  `sandbox_requests`. The raw settlement is never stored. With the flag off, the delivery is ignored before anything
  is written.
- Billing's other money still comes from Billing's read API, never from an event.

## Configuration

Every value comes from the environment (production: `/etc/openvibe/report.env`). See [.env.example](.env.example).

| Name | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | production switches the base URL and is required for a real deploy |
| `PORT` | `5080` | the loopback port nginx proxies to |
| `HOST` | `127.0.0.1` | listen address |
| `BASE_URL` | `https://openvibe.report` in production, otherwise `http://localhost:5080` | canonical links, sitemap and llms.txt |
| `TRUST_PROXY` | `2` | Express trust proxy (the app sets no cookies, but the per-address limit uses the client address) |
| `DATABASE_URL` | unset in development | Report's PostgreSQL through PgBouncer; without it development uses PGlite |
| `DATABASE_DIRECT_URL` | unset | the owner connection migrations run on |
| `REPORT_PGLITE_DIR` | `./data/pglite` | the embedded development database |
| `REPORT_SOURCE` | `network` | `network` keeps today's behaviour; `report` answers from Report's tables |
| `OV_NETWORK_INTERNAL_URL` | `http://127.0.0.1:4000` | Network's loopback origin (its manifest's `internalOrigin`) |
| `OV_NETWORK_URL` | `https://openvibe.network` | the OAuth token endpoint's origin |
| `OV_LIVE_INTERNAL_URL` | `http://127.0.0.1:3000` | Live's loopback origin |
| `OV_BENCH_INTERNAL_URL` | `https://bench.openvibe.services` | Bench's public read origin, optionally an internal origin |
| `OV_AI_INTERNAL_URL` | `https://api.openvibe.exchange` | AI's public Exchange catalogue and measured provider offers (`/api/v1/exchange/catalog`; the ai.openvibe.services vhost does not pass it) |
| `OV_BILLING_INTERNAL_URL` | `http://127.0.0.1:4600` | Billing's loopback origin |
| `OV_OAUTH_CLIENT_ID` / `OV_OAUTH_CLIENT_SECRET` | `report` / unset | Report's client-credentials token for `openvibe.billing` |
| `REPORT_BILLING_TOKEN` | unset | an explicit Billing bearer token for an operator run |
| `REPORT_EVENTS_SECRET` | unset | the HMAC secret for `POST /internal/events` (32+ chars, comma list for rotation) |
| `REPORT_AI_EXCHANGE` | `0` | `1` consumes Billing's `billing.credit.settled` events into the AI Exchange aggregates and opens `/ai/exchange` and `GET /api/v1/ai/exchange`; off consumes nothing |
| `REPORT_JOBS` | `1` | `0` turns the ingest and shadow jobs off |
| `REPORT_JOBS_ON_BOOT` | `1` | run both jobs once shortly after boot |
| `REPORT_INGEST_INTERVAL_MS` | `300000` | how often the ingest job runs |
| `REPORT_SHADOW_INTERVAL_MS` | `900000` | how often the shadow job runs |
| `REPORT_SHADOW_WINDOW_DAYS` | `7` | the shadow window (7, 30 or 90) |
| `REPORT_API_RATE_LIMIT_PER_MIN` | `120` | per-address API requests a minute |
| `REPORT_READY_TIMEOUT_MS` | `2500` | how long a readiness probe may take |
| `RELEASE_COMMIT` | unset | `/release.json`'s release; otherwise read from git in the checkout |

## Run and test

```sh
npm install
npm start            # http://127.0.0.1:5080; development uses the embedded PGlite database
npm test             # every test/*.test.js, in its own process
```

Most tests stub both sources and pass `store: null`, so they need no database. The analytics tests use
`test/helpers/db.js` (`createTestDb` from openvibe-sdk/testing) with a migrated PGlite, or the PostgreSQL containers
with `REPORT_TEST_STORE=pg`. They cover ingest idempotency, every metric against a fixture's expected numbers, the
shadow job's difference and clean run, `GET /internal/shadow`, the source flag, the Billing revenue read with a stub,
the AI Exchange aggregation/validation/replay/BigInt/sandbox/staff-gate/flag-off cases, and the existing
pages/API/health/crawl behaviour.

`node --check` is run over `server/`, `test/` and `public/` by CI (`.github/workflows/ci.yml`, the shared
OpenVibe.Shared test workflow).

## Cutover

1. Run the ingest and shadow jobs long enough to cover a full 90-day window, and check
   `GET /internal/shadow` has zero differences (or only explained ones).
2. Create Report's first-party grants on Network: `billing.stats.read` and `billing.balance.read` for the `report`
   service (and the Network read grants when Report starts pulling creator analytics directly).
3. Set `REPORT_SOURCE=report` in `/etc/openvibe/report.env` and restart; keep the Network ingest running.
4. Leave Network writing during the dual-write window. Live's `ANALYTICS_SOURCE` can then move to Report; Network's
   `/stats` becomes a 301 to `openvibe.report/stats`.
5. After the N-1 window, a Contracts migration removes Network's analytics tables. Rollback before that is
   `REPORT_SOURCE=network` and a restart.

## Deploy

The reference files are in `deploy/`:

- `deploy/systemd/openvibe-report.service` — `User=ubuntu`, `WorkingDirectory=/opt/openvibe.report`,
  `EnvironmentFile=/etc/openvibe/report.env`, `PORT=5080`, `SIGTERM` with a 10 s drain.
- `deploy/nginx/openvibe.report.conf` — HTTP → HTTPS, `www` → apex 301, Let's Encrypt certificates under
  `/etc/letsencrypt/live/openvibe.report/`, proxy to `127.0.0.1:5080`, the same security headers as Help's vhost,
  `/api/` GET-only with a coarse rate limit, and `/internal/` refused from outside.

`/api/ready` reports `network` and `live` as optional checks: one or both down is `status: "degraded"` with HTTP 200.
When `DATABASE_URL` is configured, the database check is included and is required only after `REPORT_SOURCE=report`.

## Security

Every source text is escaped before it reaches HTML. Path parameters are checked against fixed patterns before any
request. Report's own sign-in serves `/you` and the staff page, which reads the signed-in person's staff role. Its
database has public channel facts, the AI meter and aggregate AI Exchange numbers; a raw settlement (a person, a
project, money) is never stored. `/internal/` is loopback-only, and `POST /internal/events` verifies the Events v2
HMAC. See [SECURITY.md](SECURITY.md).

<!-- versions:start -->
- openvibe-contracts: v0.406.0
- openvibe-sdk: v0.150.0
- openvibe-shared: v4.211.0
- openvibe-publishing: v1.7.0
<!-- versions:end -->

### AI market data and provenance

The AI pages and `GET /api/v1/ai/leaderboard` and `/api/v1/ai/providers` read
`https://api.openvibe.exchange/api/v1/exchange/market` alongside the routed catalog.
Report follows every market cursor and caches the complete result for 120 seconds.
An upstream failure retains the last complete market snapshot with `stale: true`;
without a snapshot, Report falls back to the routed catalog.

The market is public (`exchange.market@1`, cached 60 seconds). It accepts `limit`
(1–500, default 100), opaque `cursor`, `maker`, `open_weights=true|false`, and
`kind=chat|embedding|stt|image`. Responses contain `offers`, `total_models`,
`total_offers`, `next_cursor`, `generated_at`, and the models.dev metadata snapshot's
`source`, `checked_at`, and `stale` state. Each offer identifies `model`, `provider`,
`provider_model`, `routed`, `provider_access`, and the preset's `uncensored` flag.
Prices are USD per 1M tokens (`in`, `out`, `cached`), with `price_source` pointing
to that provider's own page and `price_checked_at`. Unknown prices remain null.
A latest observed price can differ from the price currently approved for routing.

Model fields include maker, context, max output, open weights, licence, release
date, knowledge cutoff and modalities. `field_sources` names the provider page or
`https://models.dev/api.json` for each known field. Metadata refreshes daily on
read; a failed refresh preserves the previous copy and marks it stale.

Comparison rows include every market model, rated rows first, then unrated rows.
Their first provider offer has the lowest known own-page output price, breaking
ties by input price; input/output/cached prices always come from that same offer.
Provider measurements join only routed offers. Other offers display “Not routed
here”; missing measurements on routed offers display “Not measured yet”.
