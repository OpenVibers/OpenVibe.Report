# Changelog

What changed in OpenVibe.Report, newest first. Each site also publishes its patch notes at /updates on
openvibe.network.

## 0.1.0 — 2026-10-28

The service skeleton: a stateless front for the network's open numbers, The Rundown and every stream's after-show
report.

- **Two read clients** (`server/data/network.js`, `server/data/live.js`): OpenVibe.Network's open stats and
  OpenVibe.Live's Rundown and recap APIs, with injectable fetch, 8 s timeouts, an in-memory cache (1000 entries,
  oldest out; 2 to 10 minutes per answer) and one short log line on failure. A failure is null, never a throw.
  Slugs, stream ids and usernames are validated before a source request; a bad parameter is a 404 without one.
- **Pages** (`server/http/pages.js`, `server/views/index.js`): `/`, `/stats`, `/rundown`, `/rundown/t/:slug`,
  `/rundown/e/:streamId`, `/rundown/s/:username`, `/after-show/:streamId` and `/c/:username`. The views are plain
  placeholders with every dynamic value escaped; the main session designs the real pages. A missing source answer
  is the 404 view.
- **JSON API** (`server/http/api.js`): `/api/v1/stats`, `/api/v1/rundown`, `/api/v1/rundown/topics`,
  `/api/v1/rundown/t/:slug`, `/api/v1/after-show/:streamId` and `/api/v1/c/:username` answer the source's document
  as it came, CORS-open and public for two minutes; 120 requests a minute per address; problem+json 404s.
- **Plumbing**: helmet with the same CSP as OpenVibe.Help, `/api/health`, `/api/ready` (Network and Live are
  optional, so a dead source is degraded and still 200), `/release.json`, `/release-metrics`, `/metrics` on
  loopback, `/shared/*`, `/css` and `/js` (immutable only with the matching `?v=`), `robots.txt`, `sitemap.xml`
  (the home, `/stats`, `/rundown` and every topic), `llms.txt`, and the SDK's graceful stop.
- **Deploy**: `deploy/systemd/openvibe-report.service` on 127.0.0.1:5080 and
  `deploy/nginx/openvibe.report.conf` (www → apex, Let's Encrypt certs, GET-only `/api/`), plus `STATUS.json`,
  `.env.example` and the shared CI workflow.
- **Tests** (`test/`): the clients' cache, expiry, failure and parameter rules; every page and its 404s; the API
  shapes, CORS, cache and rate limit; robots/sitemap/llms; health, readiness and the static cache.
