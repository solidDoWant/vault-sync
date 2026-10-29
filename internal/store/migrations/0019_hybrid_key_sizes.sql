-- Hybrid post-quantum key wrapping (cipher suite 2, docs/design/crypto.md).
--
-- A user's public key is now an MLKEM768-X25519 public key (1216 bytes)
-- instead of an X25519 key (32 bytes), and a key slot is an age file of up
-- to 2048 bytes instead of a 105-byte sealed box. The checks keep accepting
-- the suite 1 sizes, so the user keys stored before this migration stay as
-- they are and the previous release keeps working against this schema
-- during a rolling upgrade (SPEC.md §12). The server only accepts suite 2
-- keys from now on.
--
-- Re-adding a check scans its table under an exclusive lock that blocks
-- unlocks, key changes and key-slot reads and writes until it commits; both
-- tables hold at most one row per user or per recipient and epoch.
ALTER TABLE user_keys
    DROP CONSTRAINT user_keys_public_key_length,
    ADD CONSTRAINT user_keys_public_key_length CHECK (octet_length(public_key) IN (32, 1216));

ALTER TABLE key_slots
    DROP CONSTRAINT key_slots_wrapped_key_length,
    ADD CONSTRAINT key_slots_wrapped_key_length CHECK (octet_length(wrapped_key) BETWEEN 1 AND 2048);
