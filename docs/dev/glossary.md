# Glossary

For: developers. Each entry is a short definition and a link to its exact definition. `SPEC.md` and `docs/design/` are the exact definitions.

- **Acknowledged.** A revision is acknowledged when `CommitRevision` returns success. From then on it is never lost. `SPEC.md` §6.2.
- **Anchor.** Random bytes that the server draws when it stores a revision. A device sends the anchor of its cursor, so it can detect a server that went back in time. `SPEC.md` §6.1.
- **Base.** The revision this device last synced for a document (`base_rev_id`, `base_hash` in the journal). A commit names its base. `docs/design/engine.md` §2.
- **Blob.** Content stored in S3 and addressed by its hash (`blob_id`). Also `BLOB`, the document kind for files that are not Markdown. `SPEC.md` §5.
- **Conflict copy.** A file that keeps the losing side of a conflict, next to the winner. `docs/design/engine.md` §5 (rule C).
- **Cursor.** The highest `seq` that a device fully applied to disk, with its anchor. `SPEC.md` §6.1.
- **Decision table.** The table that decides what the engine does with each remote revision and local change. `docs/design/engine.md` §5.
- **Device.** One plugin installation, registered with `RegisterDevice`. `SPEC.md` §5 and §9.2.
- **Diverged.** The answer of `ListChanges` when the server no longer has the revision at the device's cursor, for example after a restore from backup. The engine then resyncs. `docs/design/engine.md` §9.
- **Document.** A file or folder with a stable id across renames. Its kind is `text`, `blob` or `folder`. `SPEC.md` §5.
- **Epoch.** A numbered generation of a vault's key in an end-to-end encrypted vault. Removing a member starts a new epoch. `SPEC.md` §9.3.
- **Escrow.** An optional extra key slot for each epoch, wrapped to the deployment's escrow key, so the export job can decrypt the vault. `SPEC.md` §9.4.
- **Head.** The latest revision of a document (`head_rev_id`). `head_seq` is the latest `seq` of a vault. `SPEC.md` §5.
- **Journal.** The engine's durable store on the device, in IndexedDB: cursor, documents, pending operations and conflicts. `docs/design/engine.md` §2.
- **Key slot.** An epoch key wrapped to one recipient (a member or the escrow key). `SPEC.md` §9.3, `docs/design/crypto.md`.
- **Membership log.** The signed, hash-linked log of membership changes of an end-to-end encrypted vault, which devices replay and trust. `docs/design/encryption.md`.
- **Path key.** The normalized form of a path (`path_key`), on which the server enforces unique live paths. `SPEC.md` §5.
- **Pending operation.** A local change that the server has not acknowledged yet, kept in the journal. `docs/design/engine.md` §2.
- **Purge.** Deleting old non-head revisions under the retention policy. `SPEC.md` §11.
- **Revision.** One append-only version of a document: content, path, or a tombstone. `SPEC.md` §5.
- **Seq.** The gapless position of a revision in its vault's change list. `SPEC.md` §6.1.
- **Tombstone.** A revision that marks a document as deleted. `SPEC.md` §6.3.
- **`VaultAdapter`.** The interface through which the engine reads and writes the vault. `plugin/src/core/vault/`.
