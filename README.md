# OpenVibe.Report

> Every number on OpenVibe, honest.

**Status:** v0.1.0 service skeleton (see [STATUS.json](STATUS.json)). The routes, the API and the plumbing are
complete; the views are plain placeholders the main session will design.
**Domain:** `openvibe.report` · **Port:** 5080 · **Service id:** `report` · **Env prefix:** `OV_` / `REPORT_`
**License:** AGPL-3.0 (same as every OpenVibe service).

The Report room of the OpenVibe network: the open numbers every site publishes, The Rundown of what streamers talked
about, and each stream's after-show report.

## Purpose

OpenVibe.Report is a stateless read-only front. It has no database, no sign-in and no events. It asks two loopback
APIs for their public answers, holds each answer in this process for a few minutes, and renders it:

| Source | Read | Used for |
|---|---|---|
| **OpenVibe.Network** | `GET /api/v1/stats?days=7\|30\|90` | `/`, `/stats`, `GET /api/v1/stats` |
| **OpenVibe.Live** — The Rundown | `GET /api/rundown/`, `/api/rundown/topics`, `/api/rundown/t/:slug`, `/api/rundown/e/:streamId`, `/api/rundown/s/:username` | `/rundown`, `/rundown/t/:slug`, `/rundown/e/:streamId`, `/rundown/s/:username` |
| **OpenVibe.Live** — after-show reports | `GET /api/recap/:streamId`, `GET /api/recap/channel/:username` | `/after-show/:streamId`, `/c/:username` |

A source that does not answer is null, after one short log line; the page (or API route) becomes a 404. The service
never invents a zero and never throws a source error at the reader.

## Does not own

- **The numbers** — OpenVibe.Network's open stats. Report quotes them.
- **The Rundown and the after-show reports** — OpenVibe.Live. Report quotes them, including their counts and text.
- **Identity, sessions and writes** — Report has none. It does not read cookies and has no POST routes.
- **The Shared Frame** — `openvibe-shared` (navbar, footer, theme-loader, static files), served from this site's own
  pinned copy at `/shared/*`.

## Pages

All server-rendered placeholders in `server/views/index.js`; every dynamic value goes through `esc()`.

| Page | What it shows |
|---|---|
| `/` | the 7-day open numbers, the Rundown's counts and lead, and the trending topics |
| `/stats?days=7\|30\|90` | the network totals and a first look at every site (anything else is 30) |
| `/rundown` | on air, the lead, the latest streams and every topic |
| `/rundown/t/:slug` | one topic, its takes and related topics |
| `/rundown/e/:streamId` | one stream as an episode, with its segments |
| `/rundown/s/:username` | one streamer's episodes and topics |
| `/after-show/:streamId` | one after-show report |
| `/c/:username` | one channel's latest after-show reports |

A bad path parameter (slug, stream id, username) or a source that answered nothing renders `views.notFound()` with
status 404. Pages are `Cache-Control: public, max-age=120`.

## API

All under `/api/v1`, CORS `*`, `Cache-Control: public, max-age=120`, 120 requests a minute per address, and the
source's answer as it came:

```
GET /api/v1/stats?days=7|30|90
GET /api/v1/rundown
GET /api/v1/rundown/topics
GET /api/v1/rundown/t/:slug
GET /api/v1/after-show/:streamId
GET /api/v1/c/:username
```

A bad parameter or a missing source answer is a 404 `application/problem+json` body built with
`openvibe-contracts` `http.sendProblem`. The API is read-only; other methods get 405.

## Crawl artifacts

- `/robots.txt` — the public pages are crawlable; `/api/` is not; the sitemap is named.
- `/sitemap.xml` — `/`, `/stats`, `/rundown` and every `/rundown/t/<slug>` from the Rundown's topics (the three
  static pages remain when the topics source is down). `lastmod` comes from `STATUS.json`.
- `/llms.txt` — the site, its pages and its machine-readable answers.

## Configuration

Every value comes from the environment (production: `/etc/openvibe/report.env`). See [.env.example](.env.example).

| Name | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | production switches the base URL and is required for a real deploy |
| `PORT` | `5080` | the loopback port nginx proxies to |
| `HOST` | `127.0.0.1` | listen address |
| `BASE_URL` | `https://openvibe.report` in production, otherwise `http://localhost:5080` | canonical links, sitemap and llms.txt |
| `TRUST_PROXY` | `2` | Express trust proxy (the app sets no cookies, but the per-address limit uses the client address) |
| `OV_NETWORK_INTERNAL_URL` | `http://127.0.0.1:4000` | OpenVibe.Network's loopback origin (its manifest's `internalOrigin`) |
| `OV_LIVE_INTERNAL_URL` | `http://127.0.0.1:3000` | OpenVibe.Live's loopback origin (its manifest's `internalOrigin`) |
| `REPORT_API_RATE_LIMIT_PER_MIN` | `120` | per-address API requests a minute |
| `REPORT_READY_TIMEOUT_MS` | `2500` | how long a readiness probe may take |
| `RELEASE_COMMIT` | unset | `/release.json`'s release; otherwise read from git in the checkout |

## Run and test

```sh
npm install
npm start            # http://127.0.0.1:5080
npm test             # every test/*.test.js, in its own process, with both sources stubbed
```

The tests need no database, no network and no running OpenVibe site: `test/helpers/boot.js` supplies a URL-aware
stub for both sources. They cover the clients' cache hit, expiry, failure and parameter rules; every page route and
its 404s; the API shapes, CORS, cache and rate limit; robots/sitemap/llms; and health/readiness/static caching.

`node --check` is run over `server/`, `test/` and `public/` by CI (`.github/workflows/ci.yml`, the shared
OpenVibe.Shared test workflow, no database service).

## Deploy

The reference files are in `deploy/`:

- `deploy/systemd/openvibe-report.service` — `User=ubuntu`, `WorkingDirectory=/opt/openvibe.report`,
  `EnvironmentFile=/etc/openvibe/report.env`, `PORT=5080`, `SIGTERM` with a 10 s drain.
- `deploy/nginx/openvibe.report.conf` — HTTP → HTTPS, `www` → apex 301, Let's Encrypt certificates under
  `/etc/letsencrypt/live/openvibe.report/`, proxy to `127.0.0.1:5080`, the same security headers as Help's vhost,
  and `/api/` GET-only with a coarse rate limit.

`/api/ready` reports `network` and `live` as optional checks: one or both down is `status: "degraded"` with HTTP 200,
so a stateless front is never marked not-ready just because a source is unavailable.

## Security

Every source text is escaped before it reaches HTML. Path parameters are checked against fixed patterns before any
request. Report holds no accounts, no cookies, no database and no write routes. See [SECURITY.md](SECURITY.md).

<!-- versions:start -->
- openvibe-contracts: v0.225.0
- openvibe-sdk: v0.70.0
- openvibe-shared: v4.31.0
<!-- versions:end -->
