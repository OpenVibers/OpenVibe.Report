-- phase: expand
-- AI Exchange analytics (plan G-P9): Billing's credit settlements, summed by UTC day, exact model id and provider
-- access. Aggregates only: no person, no project, no prompt and no answer is stored here. Report reads the
-- authorities (Billing settles and names the model in the event); it never sets a rate, a price or a balance.

-- One row per day, resolved model id and provider access. Money is integer nano-USD (D1) in BIGINT: what was
-- collected (retail), what is owed but not collected (shortfall), what the route cost (supply) and the margin
-- (retail minus supply). A sandbox settlement is not money: it only increments sandbox_requests.
CREATE TABLE report_ai_exchange_days (
    day                date NOT NULL,
    model              text COLLATE "C" NOT NULL,           -- the exact id after deployment_id's first ":", or 'unknown'
    provider_access    text COLLATE "C" NOT NULL,           -- OWN_DEPLOYMENT | AUTHORIZED_WHOLESALE | CUSTOMER_BYOK | RESTRICTED | UNVERIFIED | unknown
    requests           bigint NOT NULL DEFAULT 0,
    sandbox_requests   bigint NOT NULL DEFAULT 0,           -- usd_credit_sandbox settlements: counted apart, never money
    tokens_input       bigint NOT NULL DEFAULT 0,
    tokens_cached_read bigint NOT NULL DEFAULT 0,
    tokens_cache_write bigint NOT NULL DEFAULT 0,
    tokens_output      bigint NOT NULL DEFAULT 0,
    retail_nano_usd    bigint NOT NULL DEFAULT 0,           -- charge_nano_usd, what was collected
    shortfall_nano_usd bigint NOT NULL DEFAULT 0,           -- owed, not collected
    supply_nano_usd    bigint NOT NULL DEFAULT 0,
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

-- A payload that does not match billing.credit.settled@1 is counted here, by the day it claims, and never aggregated.
CREATE TABLE report_ai_exchange_rejected (
    day                date NOT NULL,
    reason             text COLLATE "C" NOT NULL,
    events             bigint NOT NULL DEFAULT 0,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, reason)
);
