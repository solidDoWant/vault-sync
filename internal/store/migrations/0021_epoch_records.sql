-- The signed epoch record of an end-to-end encrypted vault's epoch
-- (docs/design/crypto.md, "Identity keys, the membership log and signed
-- epochs"), stored as RotateEpoch received it so that devices can verify it.
-- The server verifies it before storing it; the column is opaque to SQL.
--
-- A nullable column only, so the previous release runs unchanged against
-- this schema during a rolling upgrade (SPEC.md §12): its inserts leave it
-- NULL.
ALTER TABLE vault_key_epochs
    ADD COLUMN record bytea CONSTRAINT vault_key_epochs_record_length CHECK (octet_length(record) <= 1048576);
