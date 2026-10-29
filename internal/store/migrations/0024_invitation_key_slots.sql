-- Invitations to end-to-end encrypted vaults carry key slots
-- (docs/design/encryption.md, "Invitations").
--
-- A key slot may now be wrapped to a pending invitation's key
-- (recipient_kind 'invitation', recipient_id the invitation id). Such slots
-- live only while the invitation's row does: every statement that deletes
-- invitation rows also deletes the slots of invitations that no longer have
-- one. An E2EE invitation also stores its invite anchor, which the newcomer
-- reads with GetInvitationSlots; its code_hash is SHA-256 of the code's
-- `<id>` part, sent by the inviting device.
--
-- Additive, so the previous release runs unchanged against this schema
-- during a rolling upgrade (SPEC.md §12): it never writes invitation slots or
-- the new column, and reads key slots only by user or escrow kind.
-- Re-adding the check scans key_slots under an exclusive lock that blocks
-- key-slot reads and writes until it commits; the table holds at most one
-- row per recipient and epoch.
ALTER TABLE key_slots
    DROP CONSTRAINT key_slots_recipient_kind_valid,
    ADD CONSTRAINT key_slots_recipient_kind_valid CHECK (recipient_kind IN ('user', 'escrow', 'invitation'));

ALTER TABLE vault_invitations
    ADD COLUMN invite_anchor bytea CONSTRAINT vault_invitations_invite_anchor_length CHECK (octet_length(invite_anchor) = 96);
