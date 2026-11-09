-- phase: expand
-- A person's own numbers (the owner, 2026-11-09): "you can make them public if you want, but private by default."
--
-- One row per subject holds the five publish switches (published, all false until the person turns one on) and the
-- last computed snapshot (report.me-stats@1). The snapshot is the private document: the owner's /me, GET
-- /api/v1/me/stats and the per-section switches write it. The public /u/<name> page and GET /api/v1/u/:name/stats
-- read it through server/me-stats.js, which copies only the sections the switches name; the row itself is never
-- returned to a reader.
--
-- Why a snapshot and not a live count on the public page: the sites and the activity come from Network's cross-site
-- history, which only the person's own session token may read. A public page has no token, so it shows the snapshot
-- the owner last computed, with its generated_at. A section whose source did not answer is absent from the snapshot,
-- never a zero.
--
-- The display name and avatar are stored so a public page still names the person when the snapshot is old. Usernames
-- change on Network: the row is re-keyed by subject on every visit and matched case-insensitively by the current name.
--
-- Expand only: one table and its indexes; nothing that exists is changed or dropped, and an older release keeps
-- reading its own tables exactly as before.
CREATE TABLE IF NOT EXISTS report_me_stats (
    subject      text COLLATE "C" PRIMARY KEY,
    username     text NOT NULL,
    display_name text NOT NULL,
    avatar_url   text,
    published    jsonb NOT NULL DEFAULT '{}'::jsonb,
    snapshot     jsonb,
    snapshot_at  timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS report_me_stats_username ON report_me_stats (lower(username));
CREATE INDEX IF NOT EXISTS report_me_stats_updated ON report_me_stats (updated_at DESC);
