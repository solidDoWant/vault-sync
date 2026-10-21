-- Vault invitations (SPEC.md §5, §9.2; issue #33).
--
-- An owner creates an invitation and hands its code to the invitee; the
-- server stores only the SHA-256 of the code, which is 256 random bits, so a
-- leaked table cannot be used to join a vault. A row exists only while the
-- invitation is pending: redeeming or revoking an invitation deletes its row
-- (so a code works at most once), and expired rows are pruned when an owner
-- of the vault creates another invitation, so a vault holds at most the
-- pending invitation limit of rows.
--
-- Additive, so the previous release runs unchanged against this schema
-- during a rolling upgrade (SPEC.md §12): it never names the table.
CREATE TABLE vault_invitations (
    id          uuid        PRIMARY KEY,
    vault_id    uuid        NOT NULL REFERENCES vaults (id),
    code_hash   bytea       NOT NULL CONSTRAINT vault_invitations_code_hash_length CHECK (octet_length(code_hash) = 32),
    role        text        NOT NULL CONSTRAINT vault_invitations_role_valid CHECK (role IN ('owner', 'editor', 'viewer')),
    created_by  uuid        NOT NULL REFERENCES users (id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    CONSTRAINT vault_invitations_code_hash_key UNIQUE (code_hash)
);

CREATE INDEX vault_invitations_vault_id_idx ON vault_invitations (vault_id, created_at);
