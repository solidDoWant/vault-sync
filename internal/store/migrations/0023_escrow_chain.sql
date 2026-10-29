-- The deployment's escrow chain (docs/design/encryption.md, "Where the
-- escrow chain lives").
--
-- Position 0 is the root escrow bundle: the first escrow signing key and
-- recipient the deployment published. Every later position is an escrow
-- rotation statement: the hash of the bundle before it, the new bundle, and
-- the signature of the previous escrow signing key. The server publishes the
-- whole chain in GetServerInfo and, at startup, requires its configured
-- escrow bundle to be the chain's head. Bundles are stored encoded
-- (e2ee.EscrowBundle.Encode).
--
-- A new table only, so the previous release runs unchanged against this
-- schema during a rolling upgrade (SPEC.md §12): it never names it.
CREATE TABLE escrow_chain (
    position        integer     PRIMARY KEY CONSTRAINT escrow_chain_position_valid CHECK (position >= 0),
    bundle          bytea       NOT NULL CONSTRAINT escrow_chain_bundle_length CHECK (octet_length(bundle) BETWEEN 1 AND 8192),
    old_bundle_hash bytea       CONSTRAINT escrow_chain_old_bundle_hash_length CHECK (octet_length(old_bundle_hash) = 32),
    signature       bytea       CONSTRAINT escrow_chain_signature_length CHECK (octet_length(signature) = 64),
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- The root has no predecessor and no signature; every statement has both.
    CONSTRAINT escrow_chain_root_unsigned CHECK (
        (position = 0) = (old_bundle_hash IS NULL) AND (position = 0) = (signature IS NULL)
    )
);
