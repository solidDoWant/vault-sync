-- A random anchor per revision, to detect a restored server's history
-- (SPEC.md §6.1, §8; issue #155).
--
-- A client sends the anchor of the revision at its cursor with ListChanges.
-- The server checks that it still holds a revision at that seq with that
-- anchor and reports divergence if not. Revision ids are chosen by the
-- committing client, which may commit the same id again after a restore;
-- the anchor is drawn by PostgreSQL, so a restored database that commits
-- new revisions never reproduces the anchor of one it lost.
--
-- The default is set after the column is added, so adding the column does
-- not rewrite the table; existing revisions are given an anchor by the
-- UPDATE below. The previous release never names the column, and its
-- inserts get the default, so it keeps working during a rolling upgrade
-- (SPEC.md §12).
ALTER TABLE revisions ADD COLUMN anchor uuid;

ALTER TABLE revisions ALTER COLUMN anchor SET DEFAULT gen_random_uuid();

UPDATE revisions SET anchor = gen_random_uuid() WHERE anchor IS NULL;

ALTER TABLE revisions ALTER COLUMN anchor SET NOT NULL;
