-- Each user key's Ed25519 signing public key (docs/design/crypto.md,
-- bundle), so the server can report every member's bundle. Keys stored
-- before this migration have none (NULL) until a device that unlocks them
-- adds it, once.
--
-- A nullable column without a default only changes the catalog, and the
-- previous release runs unchanged against this schema during a rolling
-- upgrade (SPEC.md §12): it never names the column, and its inserts leave it
-- NULL.
ALTER TABLE user_keys
    ADD COLUMN sign_public_key bytea CONSTRAINT user_keys_sign_public_key_length CHECK (octet_length(sign_public_key) = 32);
