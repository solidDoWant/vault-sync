-- Reset points in the escrow chain (docs/design/encryption.md, "The escrow
-- chain" and "Escrow reset on the server").
--
-- A reset point names the hash of the bundle before it and the new bundle,
-- like a signed rotation, but carries no signature: an admin started the
-- chain again from the new bundle without the previous signing key. The
-- reset column marks it. The root is never a reset point.
--
-- Rolling upgrade (SPEC.md §12): the previous release reads and writes the
-- same columns as before and never names reset, which defaults to false for
-- its signed rotations. It refuses to start on a chain that holds a reset
-- point, which the admin appends only after the upgrade.
ALTER TABLE escrow_chain
    ADD COLUMN reset boolean NOT NULL DEFAULT false,
    DROP CONSTRAINT escrow_chain_root_unsigned,
    -- The root has no predecessor, no signature and no reset mark. Every
    -- later position has a predecessor, and a signature unless it is a
    -- reset point.
    ADD CONSTRAINT escrow_chain_statement_shape CHECK (
        CASE WHEN position = 0
            THEN old_bundle_hash IS NULL AND signature IS NULL AND NOT reset
            ELSE old_bundle_hash IS NOT NULL AND (signature IS NULL) = reset
        END
    );
