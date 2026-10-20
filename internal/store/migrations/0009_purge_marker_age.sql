-- When each purge marker was written, so the retention job can prune markers
-- older than its horizon (SPEC.md §5, §11; issue #514).
--
-- A marker is only consulted by a device that has not pulled since the purge
-- (a pull moves its cursor past the purged revision's successor). Pruning it
-- can only turn that device's anchor check into a false-positive divergence,
-- after which it resyncs and merges every note (SPEC.md §8): nothing is lost.
--
-- Additive, so the previous release runs unchanged against this schema
-- during a rolling upgrade (SPEC.md §12): its retention job never names
-- purged_revisions, and the column has a default for any insert that does
-- not name it. Markers written before this migration get its time, which
-- only delays their pruning. The index serves the bounded prune scan; the
-- table is small (one row per purged revision), so building it in the
-- migration's transaction blocks purges only briefly.
ALTER TABLE purged_revisions ADD COLUMN purged_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX purged_revisions_purged_at ON purged_revisions (purged_at);
