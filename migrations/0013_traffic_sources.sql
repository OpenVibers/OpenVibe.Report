-- phase: expand
-- Traffic v2 (plan AD.40, "a full analytics suite"): where people come from, countries, and hours.
--   sources     people's page requests by the site that sent them: a referrer's host only, grouped as people say it
--               (Google, ChatGPT, X …), 'Direct' without one; a page of the same site is not an arrival and is not counted
--   countries   requests by Cloudflare's two-letter country, people and bots apart (no address, no city)
--   hours       requests by hour, site and who, for the "Today" chart; kept 15 days
CREATE TABLE IF NOT EXISTS report_traffic_sources (
    day       date NOT NULL,
    host      text COLLATE "C" NOT NULL,
    source    text COLLATE "C" NOT NULL,
    requests  bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (day, host, source)
);
CREATE TABLE IF NOT EXISTS report_traffic_countries (
    day       date NOT NULL,
    host      text COLLATE "C" NOT NULL,
    people    boolean NOT NULL,
    country   text COLLATE "C" NOT NULL,
    requests  bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (day, host, people, country)
);
CREATE TABLE IF NOT EXISTS report_traffic_hours (
    hour      timestamptz NOT NULL,
    host      text COLLATE "C" NOT NULL,
    who       text COLLATE "C" NOT NULL,
    requests  bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, host, who)
);
CREATE INDEX IF NOT EXISTS report_traffic_hours_hour ON report_traffic_hours (hour);
