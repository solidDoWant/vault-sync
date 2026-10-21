-- User key pairs for end-to-end encryption (SPEC.md §9.3; issue #665).
--
-- One row per user who has created a key. The private key is stored only
-- wrapped under a key derived from the user's passphrase with Argon2id; the
-- server never sees the passphrase, the Argon2id output or the private key.
-- auth_key_hash is SHA-256 of the auth_key the device derives from the same
-- Argon2id output: the server releases wrapped_private_key only to a caller
-- presenting the matching auth_key, and never stores auth_key itself.
--
-- failed_attempts counts wrong auth_keys since attempt_window_start (NULL
-- when no window is open). Keeping the count here, and checking it under the
-- row lock, makes the limit the same on every replica.
--
-- Additive, so the previous release runs unchanged against this schema
-- during a rolling upgrade (SPEC.md §12): it never names the table.
CREATE TABLE user_keys (
    user_id              uuid        PRIMARY KEY REFERENCES users (id),
    public_key           bytea       NOT NULL CONSTRAINT user_keys_public_key_length CHECK (octet_length(public_key) = 32),
    wrapped_private_key  bytea       NOT NULL CONSTRAINT user_keys_wrapped_private_key_length CHECK (octet_length(wrapped_private_key) BETWEEN 1 AND 256),
    suite                integer     NOT NULL,
    argon2_memory_kib    integer     NOT NULL,
    argon2_iterations    integer     NOT NULL,
    argon2_parallelism   integer     NOT NULL,
    salt                 bytea       NOT NULL CONSTRAINT user_keys_salt_length CHECK (octet_length(salt) = 16),
    auth_key_hash        bytea       NOT NULL CONSTRAINT user_keys_auth_key_hash_length CHECK (octet_length(auth_key_hash) = 32),
    failed_attempts      integer     NOT NULL DEFAULT 0 CONSTRAINT user_keys_failed_attempts_nonnegative CHECK (failed_attempts >= 0),
    attempt_window_start timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);
