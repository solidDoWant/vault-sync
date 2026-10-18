-- Index the folders of live path keys (issue #134).
--
-- A live document cannot sit at, or under, the folder another live
-- document's path names: a file "notes" and a document "notes/c.md" cannot
-- both exist on any filesystem (SPEC.md §5). The folders of a path key are
-- its proper prefixes that end before a "/". Because the comparison is on
-- path_key, "Folder" and "folder/c.md" collide too.
--
-- CommitRevision checks both directions under the vault row lock, through
-- indexes, never by scanning a vault's documents:
--
-- * Is a folder of the new key a live document's key? One probe of
--   documents_live_path_key_idx (0003) per folder of the new key.
-- * Is the new key a folder of a live document's key? One probe of the GIN
--   index below, which holds the digests of every live key's folders.
--
-- A folder's digest covers the vault id, so the GIN index (which cannot
-- lead with vault_id without the btree_gin extension) only ever matches
-- documents of the committing vault. Folder keys can be up to 8192 bytes,
-- too long for a btree or GIN entry, hence digests, as in 0003: a digest
-- collision could only refuse a commit, never treat two paths as one.
--
-- The previous release does not run the check but is otherwise unaffected
-- by this schema, so it keeps working during a rolling upgrade (SPEC.md
-- §12). Existing documents are indexed as they are; a collision that was
-- committed before this migration is not undone, and the documents in it
-- can still be edited and deleted.

-- The digest of a folder key in a vault. Immutable for the reason given for
-- documents_path_key_digest in 0003; uuid_send is the vault id's 16 bytes,
-- so the input is unambiguous.
CREATE FUNCTION documents_folder_digest(vault_id uuid, folder text) RETURNS bytea
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN sha256(uuid_send(vault_id) || convert_to(folder, 'UTF8'));

-- The folders of a path key, outermost first: "a/b/c.md" has "a" and "a/b".
-- A key without "/" has none. The running aggregate rejoins the first n
-- segments for every n; the last such prefix, the whole key, is not a
-- folder. Building each prefix by copying keeps the deepest key the schema
-- allows (4095 folders) in the tens of milliseconds.
CREATE FUNCTION documents_path_key_folders(path_key text) RETURNS text[]
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN trim_array(ARRAY(
        SELECT string_agg(segment, '/') OVER (ORDER BY ordinal)
        FROM unnest(string_to_array(path_key, '/')) WITH ORDINALITY AS segments (segment, ordinal)
        ORDER BY ordinal
    ), 1);

-- The digests of a path key's folders in a vault. Its cost tells the planner
-- to probe the index below rather than recompute it for every row it would
-- scan: for the deepest keys one call takes tens of milliseconds.
CREATE FUNCTION documents_folder_digests(vault_id uuid, path_key text) RETURNS bytea[]
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE COST 10000
    RETURN ARRAY(
        SELECT documents_folder_digest(vault_id, folder)
        FROM unnest(documents_path_key_folders(path_key)) AS folder
    );

-- The folders of every live document's path key (SPEC.md §5).
CREATE INDEX documents_live_folder_idx ON documents USING gin (documents_folder_digests(vault_id, path_key)) WHERE NOT deleted;
