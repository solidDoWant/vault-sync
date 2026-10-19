-- Retention and blob garbage collection (SPEC.md §11; issues #26, #58).
--
-- The retention job purges old non-head revisions. A purged revision is
-- almost always the parent of a newer one, and revisions_parent_fkey has no
-- ON DELETE action, so the purge first re-parents the purged revision's
-- child onto the purged revision's own parent, in the same transaction
-- (issue #58). The foreign key is left exactly as it is: parent_rev_id
-- always names a revision that exists, now meaning the nearest retained
-- ancestor.
--
-- Everything here is additive, so the previous release runs unchanged
-- against this schema during a rolling upgrade (SPEC.md §12): it never reads
-- the new column or table, and it never deletes revisions or blobs.

-- The child of a purged revision, found through parent_rev_id, and the
-- foreign-key check PostgreSQL runs when a revision is deleted. Without it
-- both scan every revision.
CREATE INDEX revisions_parent_idx ON revisions (parent_rev_id, document_id) WHERE parent_rev_id IS NOT NULL;

-- Whether any revision still references a blob: the garbage collector's
-- check and the foreign-key check PostgreSQL runs when a blob row is
-- deleted.
CREATE INDEX revisions_content_idx ON revisions (vault_id, content_ref) WHERE content_ref IS NOT NULL;

-- When a purge last removed a revision referencing the blob. A blob no
-- revision references is garbage-collected once this is older than the
-- grace period; NULL means no purge released it (or the collector found it
-- referenced again).
ALTER TABLE blobs ADD COLUMN released_at timestamptz;

CREATE INDEX blobs_released_at_idx ON blobs (released_at) WHERE released_at IS NOT NULL;

-- Blobs whose row the collector deleted and whose S3 object it has not
-- deleted yet. The row goes first, in its own transaction, so no commit can
-- reference the blob while its object is being deleted; this marker makes
-- the object deletion survive a crash and lets an upload of the same blob
-- wait for a deletion in progress, so a re-uploaded object is never
-- deleted.
CREATE TABLE blob_deletions (
    vault_id    uuid        NOT NULL REFERENCES vaults (id),
    blob_id     bytea       NOT NULL CONSTRAINT blob_deletions_blob_id_length CHECK (octet_length(blob_id) = 32),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, blob_id)
);
