# Glossary

For: admins who run the server. Each entry is a short definition and a link to the admin page that explains it. Users have their own [glossary](../user/glossary.md), and developers have the [developer glossary](../dev/glossary.md) with the exact definitions.

- **Blob.** The content of a file, stored in S3 and named by its hash. In an encrypted vault, it is ciphertext. [What lives where](postgresql-and-s3.md#what-lives-where).
- **Change feed.** The ordered list of revisions of a vault that devices pull (`ListChanges`). [Page sizes and response limits](postgresql-and-s3.md#page-sizes-and-response-limits).
- **Chunk.** One part of a blob upload. Each chunk is at most `VAULT_SYNC_BLOB_MAX_CHUNK_BYTES`, and the server stages it in S3 until the upload is complete. [Request size and the WAF](security.md#request-size-and-the-waf).
- **Device.** One plugin installation. Each user can have at most 100 devices that are not removed. [Fixed limits](security.md#fixed-limits).
- **End-to-end encrypted vault.** A vault whose contents and paths the devices encrypt before upload. The server holds only ciphertext. [Encryption for operators](encryption.md).
- **Epoch.** One key of an encrypted vault. A new epoch starts after a member is removed or leaves. [Epochs and key rotation](encryption.md#epochs-and-key-rotation).
- **Escrow.** An extra recipient of the keys of an encrypted vault, so that the export job can make plaintext backups. [Escrow](encryption.md#escrow).
- **Escrow chain.** The signed list of escrow key bundles in PostgreSQL. Its newest entry (the head) must match the escrow variables of the server. [Rotate the escrow key](encryption.md#rotate-the-escrow-key).
- **Escrow identity.** The private half of the escrow key (an age identity). Only the export job and your offline machine hold it, never the server. [The escrow key](encryption.md#the-escrow-key).
- **Escrow signing key.** The Ed25519 key that signs each change of the escrow key. Keep it offline. [Keep the escrow signing key offline](encryption.md#keep-the-escrow-signing-key-offline).
- **Export.** The `export` subcommand, usually a daily CronJob, that writes every vault as plaintext files. [The export job](backup-and-restore.md#the-export-job).
- **Fingerprint.** A short form of a public key that people compare to make sure that a key is the right one. [Publish the escrow fingerprint](encryption.md#publish-the-escrow-fingerprint).
- **Head revision.** The current revision of a document. Retention never purges it. [The retention policy](history-and-retention.md#the-retention-policy).
- **Job token.** The shared secret that the export job's escrow commands send to the server's `EscrowJobService`. [The rotate-escrow command](encryption.md#the-rotate-escrow-command).
- **Key slot.** A copy of a vault key, wrapped to the public key of one recipient. [Vault keys and key slots](encryption.md#vault-keys-and-key-slots).
- **Member.** A user with a role in a vault: `owner`, `editor` or `viewer`. [Authorization](security.md#authorization).
- **Purge.** The removal of old revisions by the retention job. It cannot be undone. [The retention policy](history-and-retention.md#the-retention-policy).
- **Purge marker.** A small row that the retention job keeps for each purged revision, so that a device that was offline can continue. [Purge markers](history-and-retention.md#purge-markers).
- **Realtime channel.** The WebSocket at `/v1/realtime` that tells devices to pull now. [The realtime channel](security.md#the-realtime-channel).
- **Recovery passphrase.** The passphrase that protects a user's key for encrypted vaults. Nobody can recover it for the user. [The recovery passphrase and the guess limit](encryption.md#the-recovery-passphrase-and-the-guess-limit).
- **Replica.** One running server pod. Replicas keep no state of their own. [High availability](upgrades.md#high-availability).
- **Retention.** The policy that decides which old revisions the server keeps. [History and retention](history-and-retention.md).
- **Revision.** One saved version of a document, stored in PostgreSQL. Its content is a blob.
- **Service-wide metrics.** Metrics about the whole deployment, served on a separate port. [Service-wide metrics](monitoring.md#service-wide-metrics).
- **Tombstone.** The revision that records the delete of a document. [The retention policy](history-and-retention.md#the-retention-policy).
- **Unplaced tree.** The folder of an export for documents that cannot be written at their path. [Documents that cannot be placed at their path](backup-and-restore.md#documents-that-cannot-be-placed-at-their-path).
- **Vault.** A synced set of notes, shared by its members. Each vault is separate on the server.
