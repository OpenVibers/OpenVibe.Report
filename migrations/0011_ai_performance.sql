-- phase: expand
-- AI performance (plan L40/L41, ai-metrics.md): every ai.call.recorded@1 call is also counted by day, system,
-- provider, model, operation, task, place and harness. The sums answer cost and tokens; the three log-scale
-- histograms answer p50/p90/p95 for time to first token, latency and tokens per second; errors_by_class answers the
-- top errors. The task roll-up keeps one row per day, task kind and system with the number of tasks and the cost and
-- time histograms per task. Raw records stay 90 days; these stay.

-- The 1.1.0 fields (ai.call.recorded@1, Contracts 0.421.0). All optional: rows written before this migration keep
-- the empty string or NULL and are still counted in the older totals.
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS operation    text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS task         text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS task_id      text COLLATE "C";
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS task_ms      bigint;
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS harness      text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS place        text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS streamed     boolean;
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS tps          double precision;
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS queue_ms     bigint;
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS error_class  text COLLATE "C";
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS fallbacks    integer;
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS cache_hit    boolean;
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS tool_calls   integer;
ALTER TABLE report_ai_usage ADD COLUMN IF NOT EXISTS region       text COLLATE "C";
CREATE INDEX IF NOT EXISTS report_ai_usage_task ON report_ai_usage (day, task, system, task_id);

-- One row per day and group: the counters, the token and cost sums, and the log-scale histograms (40 counts each).
-- The three histograms hold counts over HISTOGRAM_BOUNDS in server/analytics/ai-performance.js; a percentile answers
-- the upper bound of the bucket it lands in, never a made-up value inside it.
CREATE TABLE report_ai_perf_days (
    day               date NOT NULL,
    system            text COLLATE "C" NOT NULL DEFAULT '',
    provider          text COLLATE "C" NOT NULL DEFAULT '',
    model             text COLLATE "C" NOT NULL DEFAULT '',
    operation         text COLLATE "C" NOT NULL DEFAULT '',
    task              text COLLATE "C" NOT NULL DEFAULT '',
    place             text COLLATE "C" NOT NULL DEFAULT '',
    harness           text COLLATE "C" NOT NULL DEFAULT '',
    calls             bigint NOT NULL DEFAULT 0,
    succeeded         bigint NOT NULL DEFAULT 0,
    errors            bigint NOT NULL DEFAULT 0,
    fallbacks         bigint NOT NULL DEFAULT 0,            -- calls that had at least one fallback (a rate, never a sum > calls)
    streamed          bigint NOT NULL DEFAULT 0,
    cache_hits        bigint NOT NULL DEFAULT 0,
    tool_calls        bigint NOT NULL DEFAULT 0,
    tokens_input      bigint NOT NULL DEFAULT 0,
    tokens_output     bigint NOT NULL DEFAULT 0,
    tokens_reasoning  bigint NOT NULL DEFAULT 0,
    tokens_cache_read bigint NOT NULL DEFAULT 0,
    tokens_cache_write bigint NOT NULL DEFAULT 0,
    charged_usd       double precision NOT NULL DEFAULT 0,
    list_cost_usd     double precision NOT NULL DEFAULT 0,
    cache_saved_usd   double precision NOT NULL DEFAULT 0,
    ttft_hist         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 40 counts, TTFT ms
    latency_hist      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 40 counts, latency ms
    tps_hist          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 40 counts, output tokens per second
    errors_by_class   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- error_class -> count
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, system, provider, model, operation, task, place, harness)
);
CREATE INDEX report_ai_perf_days_day ON report_ai_perf_days (day);

-- One row per day, task kind and system: a task is the calls that share task_id. Its cost is the sum of the calls'
-- charged_usd; its time is task_ms when any call gives it, else the sum of the calls' latency_ms. The histograms hold
-- the cost and time of each task, so a p50 is a task's middle cost or time, never a call's.
CREATE TABLE report_ai_task_days (
    day         date NOT NULL,
    task        text COLLATE "C" NOT NULL DEFAULT '',
    system      text COLLATE "C" NOT NULL DEFAULT '',
    tasks       bigint NOT NULL DEFAULT 0,
    cost_hist   jsonb NOT NULL DEFAULT '[]'::jsonb,          -- 40 counts, USD per task
    time_hist   jsonb NOT NULL DEFAULT '[]'::jsonb,          -- 40 counts, ms per task
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, task, system)
);
CREATE INDEX report_ai_task_days_day ON report_ai_task_days (day);
