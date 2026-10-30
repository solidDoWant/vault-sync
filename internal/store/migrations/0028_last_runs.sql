-- When the retention job and the export last succeeded, read by the
-- service-wide metrics (docs/configuration.md, Service-wide metrics) so that
-- every replica reports the same values.
--
-- maintenance_runs holds one row per server background job (today only
-- 'retention'), updated by whichever replica finishes a run without errors.
--
-- export_status holds a single row (id is always true), inserted here and
-- updated by the export subcommand at the end of each run: when it
-- finished, its status (ok, partial or failed) and when a run last finished
-- ok; all NULL before the first run. The export's database role is granted
-- INSERT and UPDATE on this table only (docs/export.md); because the row
-- already exists, the export updates it without reading it.
--
-- Additive, so the previous release runs unchanged against this schema
-- during a rolling upgrade (SPEC.md §12): it never names either table.
CREATE TABLE maintenance_runs (
    job text PRIMARY KEY,
    last_success_at timestamptz NOT NULL
);

CREATE TABLE export_status (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    finished_at timestamptz,
    status text,
    last_success_at timestamptz
);

INSERT INTO export_status (id) VALUES (true);
