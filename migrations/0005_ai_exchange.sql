-- phase: expand
-- AI Exchange analytics (plan G-P9): Billing's credit settlements, summed by UTC day, exact model id and provider
-- access. Aggregates only: no person, no project, no prompt and no answer is stored here. Report reads the
-- authorities (Billing settles, AI names the model); it never sets a rate, a price or a balance.

-- One row per day, resolved model id and provider access. Money is integer nano-USD (D1) in BIGINT; the margin is
-- retail minus supply, and it is NULL when any settlement in the bucket did not carry a supply cost (never invented).
CREATE TABLE report_ai_exchange_days (
    day                date NOT NULL,
    model              text COLLATE "C" NOT NULL,           -- the resolved exact model id, or 'unknown' when the event did not name it
    provider_access    text COLLATE "C" NOT NULL,           -- OWN_DEPLOYMENT | AUTHORIZED_WHOLESALE | CUSTOMER_BYOK | RESTRICTED | UNVERIFIED | UNKNOWN
    requests           bigint NOT NULL DEFAULT 0,
    tokens_input       bigint NOT NULL DEFAULT 0,
    tokens_cached_read bigint NOT NULL DEFAULT 0,
    tokens_cache_write bigint NOT NULL DEFAULT 0,
    tokens_output      bigint NOT NULL DEFAULT 0,
    retail_nano_usd    bigint NOT NULL DEFAULT 0,
    supply_nano_usd    bigint,                              -- NULL when a settlement in the bucket had no supply cost
    margin_nano_usd    bigint GENERATED ALWAYS AS (retail_nano_usd - supply_nano_usd) STORED,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, model, provider_access)
);
CREATE INDEX report_ai_exchange_days_day ON report_ai_exchange_days (day);

-- The settlement ids already counted, so a redelivered settlement (even under a new event id) counts once. It carries
-- no subject, no project and no amount: just the id and the day it was counted on.
CREATE TABLE report_ai_exchange_seen (
    settlement_id      text COLLATE "C" PRIMARY KEY,
    day                date NOT NULL,
    received_at        timestamptz NOT NULL DEFAULT now()
);
