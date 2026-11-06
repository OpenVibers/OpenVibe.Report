-- phase: expand
-- Agent Streams S3: the report of every agent session (report.session@1).
--
-- A session report is one agent session's story: what was asked, what came out, what it cost and how it ended.
-- It is written by the first-party service that ran the session (Codes, Actor, Live) through
-- POST /internal/session-reports, under the capability report.session.write, and it is idempotent per
-- (source, task_ref): the same session's task always answers the same report, so a repeat never makes a second one.
--
-- The report never holds the raw transcript, a secret or a diff: the house redactor runs over every text field
-- before anything is stored, and a pull request is only ever a link.
--
-- This migration only adds a table and its indexes: nothing that exists is changed or dropped, so it can run
-- beside the old code and the old code keeps working.
CREATE TABLE report_sessions (
    id              text COLLATE "C" PRIMARY KEY,
    owner           text COLLATE "C" NOT NULL,
    source          text COLLATE "C" NOT NULL,
    task_ref        text COLLATE "C" NOT NULL,
    task_title      text NOT NULL,
    task_url        text,
    started_at      timestamptz,
    ended_at        timestamptz,
    worked_seconds  bigint NOT NULL DEFAULT 0,
    outcome         text COLLATE "C" NOT NULL,
    stopped_because text,
    summary         text NOT NULL,
    timeline        jsonb NOT NULL DEFAULT '[]'::jsonb,
    outputs         jsonb NOT NULL DEFAULT '[]'::jsonb,
    proof           jsonb NOT NULL DEFAULT '{}'::jsonb,
    cost_usd        numeric,
    models          jsonb NOT NULL DEFAULT '[]'::jsonb,
    highlights      jsonb NOT NULL DEFAULT '[]'::jsonb,
    stream          jsonb,
    visibility      text COLLATE "C" NOT NULL DEFAULT 'private',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The idempotency key: one report per (source, task).
CREATE UNIQUE INDEX report_sessions_source_task ON report_sessions (source, task_ref);
-- The Rundown's "What agents built today" and the sitemap read the public ones, newest first.
CREATE INDEX report_sessions_public ON report_sessions (visibility, created_at DESC);
-- A person's own reports.
CREATE INDEX report_sessions_owner ON report_sessions (owner, created_at DESC);
