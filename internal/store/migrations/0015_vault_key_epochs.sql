-- Vault key epochs and key slots (SPEC.md §5, §9.3; issue #694).
--
-- An end-to-end encrypted vault has one symmetric key per epoch, which the
-- server never sees. vault_key_epochs records each epoch with its key
-- commitment, and key_slots holds the epoch key wrapped (sealed) to each
-- recipient: a member's user key, or the deployment's escrow key. Both are
-- opaque bytes to the server; no column holds an unwrapped key.
--
-- vaults.current_epoch is the epoch new revisions must use (0 while an E2EE
-- vault has no epoch yet, and always 0 for plaintext vaults); every epoch
-- change is a compare-and-set on it under the vault row lock. A pending
-- rotation (rotation_pending) asks an owner client to create the next
-- epoch: set on a new E2EE vault and when a member leaves. revisions.epoch
-- is the epoch a revision was encrypted under (0 for plaintext revisions).
--
-- Additive, so the previous release runs unchanged against this schema
-- during a rolling upgrade (SPEC.md §12): it never names the new tables or
-- columns, and its inserts get the defaults. It refuses every E2EE commit and
-- E2EE vault creation, so it cannot write a revision under a wrong epoch.
-- Constant defaults do not rewrite the tables.
ALTER TABLE vaults
    ADD COLUMN current_epoch integer NOT NULL DEFAULT 0,
    ADD COLUMN rotation_pending boolean NOT NULL DEFAULT false;

-- Unconstrained, so adding it scans no existing revision: the server only
-- ever writes 0 or the vault's current epoch.
ALTER TABLE revisions ADD COLUMN epoch integer NOT NULL DEFAULT 0;

CREATE TABLE vault_key_epochs (
    vault_id    uuid        NOT NULL REFERENCES vaults (id),
    epoch       integer     NOT NULL CONSTRAINT vault_key_epochs_epoch_positive CHECK (epoch >= 1),
    commitment  bytea       NOT NULL CONSTRAINT vault_key_epochs_commitment_length CHECK (octet_length(commitment) = 32),
    created_by  uuid        NOT NULL REFERENCES users (id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, epoch)
);

CREATE TABLE key_slots (
    vault_id        uuid        NOT NULL,
    epoch           integer     NOT NULL,
    recipient_kind  text        NOT NULL CONSTRAINT key_slots_recipient_kind_valid CHECK (recipient_kind IN ('user', 'escrow')),
    recipient_id    text        NOT NULL CONSTRAINT key_slots_recipient_id_length CHECK (octet_length(recipient_id) BETWEEN 1 AND 255),
    wrapped_key     bytea       NOT NULL CONSTRAINT key_slots_wrapped_key_length CHECK (octet_length(wrapped_key) BETWEEN 1 AND 256),
    created_by      uuid        NOT NULL REFERENCES users (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, epoch, recipient_kind, recipient_id),
    FOREIGN KEY (vault_id, epoch) REFERENCES vault_key_epochs (vault_id, epoch)
);

-- A recipient's slots in a vault, in epoch order (ListKeySlots).
CREATE INDEX key_slots_recipient_idx ON key_slots (vault_id, recipient_kind, recipient_id, epoch);
