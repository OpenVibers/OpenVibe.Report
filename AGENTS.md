# AGENTS.md — OpenVibe.Report

## Project Overview

OpenVibe.Report is the network's analytics room and its analytics authority in shadow: the open numbers every site
publishes, Live's Rundown and after-show reports quoted in one place, Bench's AI boards rendered here, each person's
own private stats with per-section publishing, session reports with sharing, the AI usage meter and the AI Exchange
aggregates. `REPORT_SOURCE=report` switches the pages from Network's numbers to Report's own tables when the cutover is
approved.

- **Domain:** `openvibe.report` · **Port:** 5080 · **Service id:** `report` · **Env prefix:** `REPORT_`/`OV_`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development), `openvibe-shared`
  for the frame; jobs run in-process.
- **Read first:** [README.md](README.md), [STATUS.json](STATUS.json), [.env.example](.env.example),
  [docs/report.metric.v1.json](docs/report.metric.v1.json).

**Network context:** Network supplies the open cross-site stats, the sign-in/JWKS and the wallet history; Live supplies
the Rundown and after-show reports; Bench supplies the AI rows (Report never derives a score, cost or time); Billing
supplies revenue (`billing.stats.read`, `billing.balance.read`) and the AI Exchange settlements; AI/Exchange supplies
the catalogue and offers; Design's health scan is quoted; Shared supplies the Frame. Report holds no money ledger and
computes no price.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared pinned by tag)
npm run dev                    # http://localhost:5080, PGlite under data/pglite
npm start                      # node server/index.js
npm test                       # every test/*.test.js, stubbed fetch, no network or running site
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm test -- shadow             # only test files whose name contains the word
node --check <file.js>         # syntax check (no linter configured)
```

No build step: server-rendered pages; assets under [public/css/](public/css/) (`app`, `ai-comparison`, `arena`) and
[public/js/app.js](public/js/app.js). Pages work without JavaScript.

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — listener and the analytics/AI-usage jobs; graceful stop in
  `createLifecycle()`. `REPORT_JOBS=0` turns the jobs off, `REPORT_JOBS_ON_BOOT=1` runs them once after boot.
- **App factory:** [server/app.js](server/app.js) — CSP, `/auth` (Network SSO), optional auth, `/internal/events`,
  `/shared`+static, pages, `/api/v1`, discovery, 404/error handler. Tests pass a stub `fetchImpl`.
- **Config:** [server/config.js](server/config.js) — `load(env)` is pure; production `/etc/openvibe/report.env`.
- **Sources:** [server/data/](server/data/) — `network.js`, `live.js`, `bench.js`, `billing.js`, `ai-market.js`,
  `ai-catalogue.js`, `ai-join.js`, `cache.js`, `source.js`, `design-health.js`, `network-json.js`.
- **Analytics:** [server/analytics/](server/analytics/) — `ingest.js` (idempotent), `query.js`, `shadow.js`,
  `ai-usage.js`, `ai-exchange.js`, `index.js`; jobs [server/jobs/](server/jobs/) (`analytics.js`, `ai-usage.js`).
- **Pages/views:** [server/http/pages.js](server/http/pages.js), [server/http/arena.js](server/http/arena.js),
  [server/http/discovery.js](server/http/discovery.js), [server/http/session-reports.js](server/http/session-reports.js),
  [server/http/internal.js](server/http/internal.js); [server/views/](server/views/) (`index.js`, `short.js`,
  `ai-comparison.js`, `design.js`). Search documents: [server/search-index.js](server/search-index.js).
- **People's data:** [server/me-stats.js](server/me-stats.js) (private snapshot, per-section publish switches),
  [server/session-reports.js](server/session-reports.js), [server/sharing.js](server/sharing.js),
  [server/popularity.js](server/popularity.js).
- **Auth:** [server/auth.js](server/auth.js) — service tokens for operator routes (`report.ai_usage.read`); the
  person's session is `openvibe-sdk/sso` (`report` client), and staff pages judge the Network `staff.site.view` role.
- **Database:** [server/db.js](server/db.js) and [migrations/](migrations/): `report_inbox`, `report_events`,
  `report_streams`, `report_frame_days`, `report_metric_days|windows|json`, `report_dimensions`,
  `report_shadow_runs|diffs`, `report_ai_usage[_days]`, `report_ai_exchange_days|_seen|_rejected`,
  `report_index_revisions`, `report_me_stats`, `report_sessions`, `report_session_defaults`, share tables,
  `event_outbox`, `config_keys`, `config_snapshots`.
- **Deploy:** [deploy/systemd/openvibe-report.service](deploy/systemd/openvibe-report.service) (127.0.0.1:5080,
  `/etc/openvibe/report.env`, `/opt/openvibe.report`) and [deploy/nginx/openvibe.report.conf](deploy/nginx/openvibe.report.conf)
  (TLS, www→apex, `/api/` GET-only with a coarse limit, `/internal/` refused). `sudo ovhost deploy report`; database
  `ov_report`. `/api/ready` reports Network/Live as optional checks and is `degraded` (HTTP 200) when one is down; the
  database becomes required only under `REPORT_SOURCE=report`.

## Ownership and Boundaries

Report owns its analytics tables and computation, the AI usage meter and Exchange aggregates, config snapshots,
session reports and their share rows, the `report_me_stats` snapshots and the Search sequencer/outbox. It does **not**
own money (Billing), the Rundown/after-show (Live), benchmark results (Bench), identity/sessions/roles (Network), the
frame (Shared), or event delivery (Events). Never recompute a Bench score/cost/time or a Billing amount; quote the
source and its read time. A section a source did not answer for is **absent**, never a zero.

## Auth and Capabilities

- The person's session is Network SSO (`report` client); `/me`, `/you` and `/u/:name` are private/noindex except the
  sections the person publishes from their last snapshot. Staff pages need the `staff.site.view` role claim.
- Operator routes take a Network **service token** with `report.ai_usage.read`, verified through
  `openvibe-contracts serviceAuth`; Report's own sign-in never grants that.
- Outbound: `billing.stats.read`/`billing.balance.read` (client-credentials token, audience `openvibe.billing`),
  Network's open stats/history and Live's loopback reads, Bench/Exchange/AI public reads.
- `POST /internal/events` is loopback-only, v2-HMAC (`REPORT_EVENTS_SECRET`, comma list for rotation) and idempotent
  through `report_inbox`; nginx refuses `/internal/` from outside and the app also checks the socket is loopback.
- The API is read-only except the person's own publish switches and session reports; other methods get 405.
- Errors are RFC 9457 problem+json; a bad slug/id or a source that answered nothing is a 404.

## API

Public, CORS `*`, `Cache-Control: public, max-age=120` (popularity 300), 120 requests a minute per address:
`GET /api/v1/stats?days=7|30|90`, `/popular`, `/popular/co-usage`, `/rundown`, `/rundown/topics`,
`/rundown/t/:slug`, `/after-show/:streamId`, `/c/:username`, `/ai/results`, `/ai/ratings/:kind`,
`/ai/leaderboard`, `/ai/models/:id`, `/ai/providers`, `/ai/compare`, `/ai/picks`, `/design-health`, `/ai/usage/open`.
Person: `GET /me/stats?days=`, `PUT /me/stats/published`, `GET /u/:name/stats`, `/me/session-reports`,
`/session-reports[/:id]`. Staff: `GET /ai/exchange?from=&to=` (only with `REPORT_AI_EXCHANGE=1`).
Internal (loopback): `POST /internal/events`, `GET|POST /internal/shadow`, `GET /internal/metrics?scope=&id=&days=`,
`GET /internal/channels/:channel/analytics` (creator analytics plus Billing revenue).

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter.
- Every dynamic value in a page goes through `esc()` in [server/views/index.js](server/views/index.js); no raw source
  HTML is trusted.
- New schema = a new `migrations/NNNN_name.sql`; never edit one that has run. Keep `report_` prefixes.
- Ingest is idempotent on event id (`report_inbox`) and the shadow comparison stores both sides and their differences;
  a replay changes nothing.
- A source outage shows the last good copy with its read time; AI HTML is `no-store` so the outage notice stays
  current. Public pages are `public, max-age=120`, the popularity pair 300.
- CORS is `*` on public aggregates and never includes a person, username, subject or project; co-usage only reads
  people who published their `sites` section and omits pairs below three people.
- CSP: add origins to `helmet` in [server/app.js](server/app.js). No Font Awesome; shared glyphs.
- Phone first: every page fits 390 px; charts/tables must not force horizontal scroll.
- "Calm reduces, only Off removes": a person may publish fewer sections; only an explicit hide/delete removes data.
- AI text may describe people; only sex acts/porn stay gated (`test/no-looks-guard.test.js`).

## Key Pitfalls

- **The shadow is not the cutover.** In `REPORT_SOURCE=network` the pages still read Network; Report's tables are
  computed beside it and compared (`report_shadow_*`). Do not silently switch a page's source.
- **Never derive** a Bench score/cost/time, a Billing price or a provider's offer; render the source row and its read
  time. The AI Exchange aggregates use exact nano-USD integers from settlements — no floating-point money.
- **AI meter/Exchange:** raw calls kept 90 days; settlement ids are counted once (`report_ai_exchange_seen`) and
  invalid payloads are stored rejected, never dropped silently. `REPORT_AI_EXCHANGE=0` consumes nothing and hides the
  staff page/API.
- **Person's stats are private by default.** `/u/:name` copies only the published sections from the last snapshot;
  a missing section is absent, not zero. `GET /api/v1/me/stats` is `no-store`.
- **Session reports** belong to their owner; sharing uses `openvibe-sdk/share` and the audience default is the owner's,
  never a public default.
- **Staff gate:** the HTML page checks the role claim; the JSON Exchange read checks the service capability. Do not
  replace one with the other.
- **Internal routes** must stay loopback-only; a forwarded request or a bad HMAC is refused and changes nothing.
- **Drill/jobs:** `REPORT_JOBS=0` stops the ingest/shadow loops; add new background work behind it.

## Testing

`npm test` runs each file in its own process with a stubbed fetch: data sources, ingest/idempotency, shadow, AI usage
and Exchange, AI catalogue/join/market, pages/arena/short, me-stats/you, session reports and sharing, popularity,
design health, discovery/Search, events route, config, readiness, metrics, auth/limits, no-looks and secret leaks.
`npm run test:pg` for PostgreSQL. Run the narrowest file first, then the suite; always `node --check` changed files.

## Documentation

- [README.md](README.md) — purpose, what Report owns now, does-not-own, pages, API, ingest/idempotency, configuration,
  run/test, cutover, deploy, security, AI market provenance.
- [docs/report.metric.v1.json](docs/report.metric.v1.json) — the proposed flat metric contract.
- [docs/shared-ratings.md](docs/shared-ratings.md) — shared ratings notes.
- [STATUS.json](STATUS.json), [.env.example](.env.example), [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).
