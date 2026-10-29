-- Each user's sealed anchor list (docs/design/encryption.md, "Trust
-- anchors"): vault id to genesis hash, sealed on the user's devices under a
-- key the server never learns. The server stores the sealed bytes and their
-- version, and replaces them only with the next version.
--
-- A new table only, so the previous release runs unchanged against this
-- schema during a rolling upgrade (SPEC.md §12): it never names it.
CREATE TABLE anchor_lists (
    user_id     uuid        PRIMARY KEY REFERENCES users (id),
    version     bigint      NOT NULL CONSTRAINT anchor_lists_version_positive CHECK (version >= 1),
    sealed_list bytea       NOT NULL CONSTRAINT anchor_lists_sealed_list_length CHECK (octet_length(sealed_list) BETWEEN 1 AND 4800045),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
