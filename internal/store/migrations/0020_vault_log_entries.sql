-- The membership log of end-to-end encrypted vaults (docs/design/crypto.md,
-- "Identity keys, the membership log and signed epochs").
--
-- Each encrypted vault has an append-only, hash-chained log of signed
-- entries, from the genesis entry (seq 1) that its creator signs. The server
-- verifies every entry before storing it, but devices trust only their own
-- replay of the log. The columns hold an entry's fields as signed; the vault
-- is the row's vault.
--
-- A new table only, so the previous release runs unchanged against this
-- schema during a rolling upgrade (SPEC.md §12): it never names it.
CREATE TABLE vault_log_entries (
    vault_id    uuid        NOT NULL REFERENCES vaults (id),
    seq         bigint      NOT NULL CONSTRAINT vault_log_entries_seq_positive CHECK (seq >= 1),
    prev_hash   bytea       NOT NULL CONSTRAINT vault_log_entries_prev_hash_length CHECK (octet_length(prev_hash) = 32),
    entry_type  smallint    NOT NULL CONSTRAINT vault_log_entries_entry_type_valid CHECK (entry_type BETWEEN 1 AND 255),
    payload     bytea       NOT NULL CONSTRAINT vault_log_entries_payload_length CHECK (octet_length(payload) <= 8192),
    signatures  bytea[]     NOT NULL CONSTRAINT vault_log_entries_signatures_count CHECK (cardinality(signatures) BETWEEN 1 AND 2),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, seq)
);
