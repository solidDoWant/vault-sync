-- Garbage collection of blobs no revision ever referenced, and incremental
-- retention scans (SPEC.md §11; issue #225 items 2 and 3).
--
-- Everything here is safe for the previous release during a rolling upgrade
-- (SPEC.md §12): it never names the new table, its inserts into blobs get
-- the new default, and its collector already re-checks references and
-- un-releases a blob a revision references.

-- A blob row starts released: CommitBlob stores a blob before any revision
-- references it, and one never referenced (an upload whose revision was
-- never committed) is collected once the grace period has passed. The
-- collector clears released_at of a blob it finds referenced.
ALTER TABLE blobs ALTER COLUMN released_at SET DEFAULT now();

-- Blobs stored before this release that no revision references start their
-- grace period now.
UPDATE blobs b SET released_at = now()
WHERE b.released_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.vault_id = b.vault_id AND r.content_ref = b.blob_id);

-- How far the retention job has scanned under a policy: every revision the
-- policy (keep_all, keep_daily, in microseconds) purged as of scanned_through
-- (the database time a complete scan started) is purged. A later scan only
-- considers documents with revisions that crossed keep_all or keep_daily
-- since then, the only way a revision becomes purgeable. One row at most; a
-- different policy ignores it.
CREATE TABLE retention_scans (
    id               boolean     PRIMARY KEY DEFAULT true CONSTRAINT retention_scans_single CHECK (id),
    keep_all         bigint      NOT NULL,
    keep_daily       bigint      NOT NULL,
    scanned_through  timestamptz NOT NULL
);

-- The revisions that crossed an age since the last scan.
CREATE INDEX revisions_created_at_idx ON revisions (created_at, document_id);
