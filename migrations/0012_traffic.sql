-- phase: expand
-- Traffic (plan AD.40; the owner 2026-11-28: "all files like loops or llms.txt or llms-full should have their own
-- analytics and metrics on openvibe.report … separate bot traffic. have a full analytics suite"): every request any
-- OpenVibe site answered, read from the host's ov-traffic log (server/traffic/collect.js), counted by day, site, who
-- asked (people, or which bot and of what kind, its claim checked where it can be) and what was asked for. Never an
-- address; a path only for the files sites publish for machines and each site's page sections (first segment).

CREATE TABLE IF NOT EXISTS report_traffic_days (
    day        date NOT NULL,
    host       text COLLATE "C" NOT NULL,
    who        text COLLATE "C" NOT NULL,              -- person | search | ai_crawler | ai_assistant | preview | seo | monitor | script | bot | own
    agent      text COLLATE "C" NOT NULL DEFAULT '',   -- the bot's name; '' for people
    verified   text COLLATE "C" NOT NULL DEFAULT '',   -- yes | no | '' (no published way to check, or the check could not run)
    kind       text COLLATE "C" NOT NULL,              -- page | file | feed | api | asset | media | other
    path       text COLLATE "C" NOT NULL DEFAULT '',   -- /llms.txt, /robots.txt, /loops.md, /c/* … ('' for api, assets, media)
    requests   bigint NOT NULL DEFAULT 0,
    ok         bigint NOT NULL DEFAULT 0,              -- 2xx
    redirects  bigint NOT NULL DEFAULT 0,              -- 3xx
    missing    bigint NOT NULL DEFAULT 0,              -- 404, 410
    refused    bigint NOT NULL DEFAULT 0,              -- other 4xx (401, 403, 429 …)
    errors     bigint NOT NULL DEFAULT 0,              -- 5xx
    bytes      bigint NOT NULL DEFAULT 0,
    ms         double precision NOT NULL DEFAULT 0,    -- total answer time, for an average
    first_at   timestamptz,
    last_at    timestamptz,
    PRIMARY KEY (day, host, who, agent, verified, kind, path)
);
CREATE INDEX IF NOT EXISTS report_traffic_days_agent ON report_traffic_days (agent, day);
CREATE INDEX IF NOT EXISTS report_traffic_days_host ON report_traffic_days (host, day);
CREATE INDEX IF NOT EXISTS report_traffic_days_kind ON report_traffic_days (kind, day);

-- Where the collector is in the log: the file's inode and byte position, saved with the counts.
CREATE TABLE IF NOT EXISTS report_traffic_cursor (
    source      text COLLATE "C" PRIMARY KEY,
    inode       text NOT NULL,
    position    bigint NOT NULL,
    lines       bigint NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
