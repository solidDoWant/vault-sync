-- Index live path keys by digest (issue #121).
--
-- A btree index entry holds at most 2704 bytes, but a path_key may be up to
-- 8192 (a 4096-byte path, case-folded), so indexing path_key itself rejected
-- long, poorly compressible paths with an error. Uniqueness is now enforced
-- on the key's SHA-256 digest, which is 32 bytes for any key. Two distinct
-- keys can share an index entry only through a SHA-256 collision, and even
-- then the index can only refuse the second commit, never treat the two
-- paths as one document: nothing looks documents up by path_key.
--
-- The index keeps its name and stays a unique index, so a collision is still
-- a unique_violation on documents_live_path_key_idx, which the previous
-- release maps to ALREADY_EXISTS: it runs unchanged against this schema
-- during a rolling upgrade (SPEC.md §12). The statements below run in one
-- transaction, so no commit, from either release, ever sees the table
-- without a uniqueness index.

-- The digest of a path_key's UTF-8 bytes. PostgreSQL marks convert_to only
-- STABLE, but converting a database's text to UTF-8 is deterministic (the
-- database encoding never changes), so this function is immutable, as an
-- index expression must be. text has no safe cast to bytea: ::bytea parses
-- backslash escapes.
CREATE FUNCTION documents_path_key_digest(path_key text) RETURNS bytea
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN sha256(convert_to(path_key, 'UTF8'));

DROP INDEX documents_live_path_key_idx;

-- path_key is unique per vault among live documents (SPEC.md §5).
CREATE UNIQUE INDEX documents_live_path_key_idx ON documents (vault_id, documents_path_key_digest(path_key)) WHERE NOT deleted;
