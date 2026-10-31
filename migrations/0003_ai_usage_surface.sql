-- phase: expand
-- The AI meter's roll-ups gain the surface (plan L41 R1): a person can group their own calls by the product surface
-- (design.generate, codes.turn) beyond the 90 days of raw records. The roll-up's key grows by it; the rows written
-- before this migration keep the empty surface, and a roll-up recomputed from raw records fills it in.
ALTER TABLE report_ai_usage_days ADD COLUMN surface text COLLATE "C" NOT NULL DEFAULT '';
ALTER TABLE report_ai_usage_days DROP CONSTRAINT IF EXISTS report_ai_usage_days_pkey;
ALTER TABLE report_ai_usage_days ADD PRIMARY KEY (day, subject, attribution, system, surface, provider, model, paid_by);
