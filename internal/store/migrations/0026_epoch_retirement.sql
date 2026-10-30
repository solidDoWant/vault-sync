-- Re-encrypting history and retiring old epochs (docs/design/encryption.md,
-- "Re-encrypting history").
--
-- An owner's re-key job moves every revision off an old epoch, then retires
-- the epoch: its key slots are deleted and retired_at is set. The epoch row
-- stays, so its commitment and signed record still chain the epoch records
-- together. The index answers "does any revision still use this epoch?"
-- under the vault row lock without scanning the vault's revisions.
--
-- Additive, so the previous release runs unchanged against this schema
-- during a rolling upgrade (SPEC.md §12): it never names the new column, and
-- only this release retires epochs. Building the index blocks writes to
-- revisions until it is built.
ALTER TABLE vault_key_epochs ADD COLUMN retired_at timestamptz;

CREATE INDEX revisions_vault_id_epoch_idx ON revisions (vault_id, epoch);
