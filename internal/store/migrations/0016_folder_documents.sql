-- Folder documents (SPEC.md §5): a document of kind 'folder' has a path and
-- no content, so empty folders sync.
--
-- documents_kind_valid admits 'folder'. revisions_live_has_content (a live
-- revision has content) no longer holds for folders, and a CHECK on
-- revisions cannot see its document's kind, so CommitRevision enforces it
-- instead: a live revision of any other kind has content, a folder revision
-- never has.
--
-- The previous release runs unchanged against this schema during a rolling
-- upgrade (SPEC.md §12): it refuses DOCUMENT_KIND_FOLDER commits and still
-- requires content on every commit it accepts. It lists a folder revision
-- that the new release committed with kind DOCUMENT_KIND_UNSPECIFIED and no
-- content_ref. Re-adding the kind check scans documents under an exclusive
-- lock, which blocks commits and reads of documents until it commits.
ALTER TABLE documents
    DROP CONSTRAINT documents_kind_valid,
    ADD CONSTRAINT documents_kind_valid CHECK (kind IN ('blob', 'text', 'yjs', 'folder'));

ALTER TABLE revisions DROP CONSTRAINT revisions_live_has_content;
