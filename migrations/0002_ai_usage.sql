-- phase: expand
-- The AI meter (plan L40 and L41): Report keeps the ledger. OpenVibe.AI writes one ai.usage.recorded@1 per run;
-- Report stores the record once and rolls the records up by day.

-- The raw records. Kept for 90 days; the roll-ups below are kept for good. The record carries the tokens (the cache
-- read and the cache write counted apart), the money and the ids: never a prompt, never an answer.
CREATE TABLE report_ai_usage (
    id                bigserial PRIMARY KEY,
    record_key        text COLLATE "C" NOT NULL UNIQUE,   -- system | run_id (or turn_id): the same call is stored once
    system            text COLLATE "C" NOT NULL,           -- ai | harness:claude-code | harness:codex | actor | node
    run_id            text COLLATE "C",
    turn_id           text COLLATE "C",
    subject           text COLLATE "C",                    -- the person, or NULL when the call was anonymous
    attribution       text COLLATE "C" NOT NULL DEFAULT '',-- the site or app it came from, as '<type>:<id>'
    surface           text COLLATE "C" NOT NULL DEFAULT '',-- the product surface: design.generate, codes.turn
    provider          text COLLATE "C",
    model             text COLLATE "C",
    effort            text COLLATE "C",
    paid_by           text COLLATE "C" NOT NULL,           -- own_key | openvibe_key | plan | own_machine | free_tier | network_allowance | org_key
    paid_by_detail    text COLLATE "C",                    -- 'anthropic ...a1b2' or 'claude-max': never a whole secret
    tokens_input      bigint NOT NULL DEFAULT 0,           -- the UNCACHED input tokens
    tokens_output     bigint NOT NULL DEFAULT 0,
    tokens_reasoning  bigint NOT NULL DEFAULT 0,
    tokens_cache_read bigint NOT NULL DEFAULT 0,
    tokens_cache_write bigint NOT NULL DEFAULT 0,
    cache_write_ttl   text COLLATE "C",                    -- 5m | 1h | NULL
    images            bigint NOT NULL DEFAULT 0,
    audio_seconds     double precision NOT NULL DEFAULT 0,
    video_seconds     double precision NOT NULL DEFAULT 0,
    list_cost_usd     double precision NOT NULL DEFAULT 0,
    charged_usd       double precision NOT NULL DEFAULT 0,
    fee_usd           double precision NOT NULL DEFAULT 0,
    cache_saved_usd   double precision NOT NULL DEFAULT 0,
    price_source      text COLLATE "C" NOT NULL DEFAULT '',-- models | pricing | flat | no cache price
    price_date        text COLLATE "C",
    latency_ms        bigint,
    ttft_ms           bigint,
    attempts          integer NOT NULL DEFAULT 1,
    outcome           text COLLATE "C" NOT NULL,           -- succeeded | failed | cancelled | cached
    at                timestamptz NOT NULL,                 -- when the call happened
    day               date NOT NULL,
    source            text COLLATE "C" NOT NULL DEFAULT 'events',
    received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_ai_usage_day ON report_ai_usage (day);
CREATE INDEX report_ai_usage_subject ON report_ai_usage (subject);
CREATE INDEX report_ai_usage_at ON report_ai_usage (at);

-- The roll-ups, by day and by the people, the sites, the systems, the providers, the models and the payers behind them.
-- Kept for good: the raw records go after 90 days, these stay.
CREATE TABLE report_ai_usage_days (
    day               date NOT NULL,
    subject           text COLLATE "C" NOT NULL DEFAULT '',
    attribution       text COLLATE "C" NOT NULL DEFAULT '',
    system            text COLLATE "C" NOT NULL,
    provider          text COLLATE "C" NOT NULL DEFAULT '',
    model             text COLLATE "C" NOT NULL DEFAULT '',
    paid_by           text COLLATE "C" NOT NULL,
    calls             bigint NOT NULL DEFAULT 0,
    tokens_input      bigint NOT NULL DEFAULT 0,
    tokens_output     bigint NOT NULL DEFAULT 0,
    tokens_reasoning  bigint NOT NULL DEFAULT 0,
    tokens_cache_read bigint NOT NULL DEFAULT 0,
    tokens_cache_write bigint NOT NULL DEFAULT 0,
    images            bigint NOT NULL DEFAULT 0,
    audio_seconds     double precision NOT NULL DEFAULT 0,
    video_seconds     double precision NOT NULL DEFAULT 0,
    list_cost_usd     double precision NOT NULL DEFAULT 0,
    charged_usd       double precision NOT NULL DEFAULT 0,
    fee_usd           double precision NOT NULL DEFAULT 0,
    cache_saved_usd   double precision NOT NULL DEFAULT 0,
    latency_ms        bigint NOT NULL DEFAULT 0,
    attempts          bigint NOT NULL DEFAULT 0,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, subject, attribution, system, provider, model, paid_by)
);
CREATE INDEX report_ai_usage_days_day ON report_ai_usage_days (day);
CREATE INDEX report_ai_usage_days_subject ON report_ai_usage_days (subject);
