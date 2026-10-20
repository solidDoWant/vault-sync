-- Per-vault retention overrides set by the operator (SPEC.md §11; issue
-- #468).
--
-- `vault-sync-server retention set` stores a vault's policy here; a vault
-- without a row follows the deployment-wide policy. There is no API for it.
--
-- Additive, so the previous release runs unchanged against this schema
-- during a rolling upgrade (SPEC.md §12): it never names the new table or
-- column, and its inserts into retention_scans get the column's default,
-- which matches no digest this release computes. That release's retention
-- job applies the deployment-wide policy to every vault, so overrides are
-- only set once every replica runs this release (docs/deployment.md).

-- keep_all and keep_daily are in microseconds, like retention_scans.
CREATE TABLE vault_retention (
    vault_id    uuid        PRIMARY KEY REFERENCES vaults (id),
    keep_all    bigint      NOT NULL CONSTRAINT vault_retention_keep_all_positive CHECK (keep_all > 0),
    keep_daily  bigint      NOT NULL CONSTRAINT vault_retention_keep_daily_not_below_keep_all CHECK (keep_daily >= keep_all),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A digest of every override in force when the recorded scan started. A
-- complete scan only lets later scans be incremental under the same
-- deployment-wide policy and the same overrides: a changed override makes
-- revisions purgeable that crossed no age.
ALTER TABLE retention_scans ADD COLUMN overrides text NOT NULL DEFAULT '';
