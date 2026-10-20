-- Purge markers: the seq and anchor of every revision retention purged
-- (SPEC.md §5, §6.1, §11; issues #488, #494).
--
-- ListChanges checks a client's cursor anchor (and the anchor of its own
-- latest commit above the cursor) against a live revision or a purge
-- marker, so a retention purge never reports divergence and a reported
-- divergence always means a restored database. The purge writes the marker
-- in the transaction that deletes the revision, so every snapshot sees
-- either the revision or its marker.
--
-- Additive, so the previous release runs unchanged against this schema
-- during a rolling upgrade (SPEC.md §12): it never names the table. Its
-- retention job, while it still runs, purges without writing markers; a
-- client whose cursor sat on such a revision gets one false-positive
-- divergence, as before this release, and so does one whose cursor sat on a
-- revision purged before this migration (their anchors are gone, so no
-- marker can be written for them).
CREATE TABLE purged_revisions (
    vault_id  uuid    NOT NULL REFERENCES vaults (id),
    seq       bigint  NOT NULL CONSTRAINT purged_revisions_seq_positive CHECK (seq > 0),
    anchor    uuid    NOT NULL,
    PRIMARY KEY (vault_id, seq)
);
