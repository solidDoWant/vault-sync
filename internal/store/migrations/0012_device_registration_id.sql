-- Idempotent device registration (SPEC.md §9.2; issue #428).
--
-- A client chooses a registration id, stores it before it first calls
-- RegisterDevice and sends it with every retry, so a retry after a lost
-- response or a crash gets the device the first call registered instead of
-- using another place under the device limit. The id is unique among a
-- user's devices that are not removed; NULL (a registration without one)
-- never conflicts. devices is small (bounded per user by the device limit
-- plus removed rows), so building the index is quick.
--
-- Additive, so the previous release runs unchanged against this schema
-- during a rolling upgrade (SPEC.md §12): it never names the column, and
-- registers every call as a new device, as before, until every replica runs
-- this release.
ALTER TABLE devices ADD COLUMN registration_id uuid;

CREATE UNIQUE INDEX devices_registration_id_idx ON devices (user_id, registration_id)
    WHERE registration_id IS NOT NULL AND removed_at IS NULL;
