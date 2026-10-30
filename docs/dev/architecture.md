# Architecture

For: developers. You know Go, TypeScript and the Obsidian plugin API. Read this page first.

vault-sync is a self-hosted replacement for Obsidian Sync. It has two halves:

- An Obsidian community plugin, written in TypeScript. It watches a vault and syncs it.
- A sync server, written in Go. It keeps vault metadata and revisions in PostgreSQL, and file contents in an S3-compatible object store.

It is for a small number of users (a household or a small team) on infrastructure that the operator already runs: PostgreSQL, S3 and an OIDC sign-in provider. The rules for every part are in `SPEC.md` §4. This page is the overview.

## The parts

```
 Obsidian (desktop / Android)                       Kubernetes
 plugin/src/obsidian (adapter)    ConnectRPC    vault-sync-server (Go)        --> PostgreSQL
 plugin/src/core (sync engine)    WebSocket     API, realtime hub, authz,     --> S3
                                                retention                     --> OIDC (JWKS)
                                                vault-sync export (CronJob)   --> plaintext tree
```

### The plugin

The plugin is in `plugin/`. It has two layers:

- `plugin/src/core` is the sync engine. It is a pure TypeScript library: the engine, the journal, merging, cryptography and the protocol client. It never imports `obsidian`. A lint rule and `plugin/test/core-import-fence.test.ts` enforce this. The engine reads and writes files through the `VaultAdapter` interface. So its tests run against an in-memory vault and an in-memory server (`plugin/src/core/sync/memory-server.ts`).
- `plugin/src/obsidian` is the thin adapter. It turns Obsidian's `Vault` events into engine input, writes safely to open editors, and holds the settings, the status bar, the conflict view and the history view. `ObsidianVaultAdapter` implements `VaultAdapter` on Obsidian's Vault API.

`SyncSession` (`plugin/src/obsidian/session.ts`) ties the engine to the plugin's lifecycle. It starts when the workspace layout is ready and stops in `onunload`. `SyncController` (`plugin/src/obsidian/controller.ts`) runs a session only while the device is signed in and connected to a server vault. A session syncs when it starts, 2 seconds after the last local change of a burst, when the realtime channel reports a change, and every 30 seconds.

The engine keeps one journal per vault in IndexedDB. The journal holds the cursor (the last `seq` it applied), the synced base of each document, and the local operations that the server has not acknowledged yet. It is the only durable store of the plugin (`SPEC.md` §2, principle 2).

### The server

`vault-sync-server` is one Go binary (`cmd/vault-sync-server`). It serves the ConnectRPC API and the realtime WebSocket. It authenticates every request, checks the caller's vault role, stores revisions and blobs, and runs the retention job.

The server never merges content. It orders revisions, refuses a commit made on top of an old head, stores bytes and sends notifications. All merging happens on the devices. That is why the server can store end-to-end encrypted vaults without changes to sync.

Several replicas can run at the same time. They share no state in memory. PostgreSQL serializes the commits to one vault, and `LISTEN`/`NOTIFY` carries change notifications between replicas.

### The export job

`vault-sync export` is a subcommand of the same binary. It runs as a separate Kubernetes job with its own credentials. It only reads PostgreSQL and S3, and writes each vault as a tree of plain files. It is the only process that may hold the escrow private key, so only it can decrypt an end-to-end encrypted vault with escrow. Admins run it for backups (`docs/export.md`).

## One edit, end to end

This is what happens when a user edits `note.md` on a laptop and a phone receives it:

1. Obsidian sends a `modify` event. The adapter passes it to the engine as a hint.
2. About 2 seconds after the last edit, the engine starts a sync cycle. It hashes the file. The SHA-256 differs from the document's `base_hash`, so the engine records a pending `edit` operation in the journal, with a new `revision_id`.
3. The engine pulls first: it calls `ListChanges` from its cursor and applies any newer revisions through the decision table (`docs/design/engine.md` §5).
4. The engine pushes. It uploads the content as a blob (`BeginBlob`, `PutBlobChunk`, `CommitBlob`) unless the server already has it. The blob id is the SHA-256 of the content.
5. The engine calls `CommitRevision` with `base_rev_id` set to the revision it last synced. The server checks that this base is still the document's head, gives the revision the next `seq` of the vault, and commits. The revision is now acknowledged. From now on it is never lost (`SPEC.md` §2, principle 1).
6. In the same transaction, the server queues a `vault_changed` notification. Every replica receives it and sends `vault_changed{vault_id, seq}` to the devices subscribed to the vault.
7. The phone receives the notification, pulls from its cursor, and gets the new revision. It downloads the blob, writes the file, then updates its journal and cursor.

If the phone had also changed `note.md`, its own commit fails with `FAILED_PRECONDITION`, because the head moved. Its next pull brings the laptop's revision, and the decision table merges the two versions or makes a conflict copy (`SPEC.md` §7).

## Data model

All ids are UUIDv7 unless `SPEC.md` says otherwise. Every table is scoped by `vault_id`, and every query filters by it. The main entities:

- A vault has members with a role (`owner`, `editor`, `viewer`) and a `head_seq`, the change counter of the vault.
- A document has a stable id across renames, a kind (`text`, `blob`, `folder`) and a head revision.
- A revision is append-only. It has a `seq`, a parent revision, a path and a content reference. A delete is a tombstone revision.
- A blob is content, addressed by its hash, stored in S3 under the vault.

A path is an attribute of a revision, not an identity. The server enforces unique paths on `path_key`, a normalized form of the path, so two devices cannot create paths that collide on a case-insensitive file system. The full table and the path rules are in `SPEC.md` §5. The migrations are in `internal/store/migrations/`.

## Sign-in and devices

The plugin signs in with the OAuth 2.0 device authorization grant (RFC 8628). It works the same on desktop and Android, with no redirect. The plugin stores only the refresh token, in Obsidian's device-local storage, never in `data.json`. The server checks each access token (a JWT) against the issuer's JWKS. Each plugin installation registers a device once with `RegisterDevice`. See `SPEC.md` §9.1 and §9.2.

## End-to-end encryption

A vault can be end-to-end encrypted. Then the server stores only ciphertext and keys it cannot open. Each user has a key pair, and each vault has a key per epoch, wrapped to every member. Removing a member starts a new epoch. See `SPEC.md` §9.3 and §9.4, `docs/design/encryption.md` and `docs/design/crypto.md`.

## Where the code lives

The full layout is in `SPEC.md` §14. The packages you meet first:

| Path | What it is |
|---|---|
| `cmd/vault-sync-server/` | The server binary, its subcommands (`export`, `escrow`, `import`, `retention`, `vault`), and the server-wide integration tests. |
| `internal/api/` | The ConnectRPC handlers. |
| `internal/auth/`, `internal/authz/` | Token checks, and vault-role checks before every handler. |
| `internal/server/` | Wiring: HTTP server, interceptors, limits, metrics. |
| `internal/store/` | PostgreSQL access and the migrations. |
| `internal/blobstore/` | S3 access. |
| `internal/realtime/` | The WebSocket hub and the fan-out between replicas. |
| `internal/retention/` | The retention job. |
| `internal/export/`, `internal/vaultimport/` | The export job and the Markdown import. |
| `internal/e2ee/` | The Go side of end-to-end encryption. |
| `internal/pathkey/`, `internal/vaultpath/` | Path normalization and path validity. |
| `internal/config/` | The environment variables of the server. |
| `proto/vaultsync/v1/` | The API definition. It is the source of truth for the protocol. |
| `gen/`, `plugin/src/gen/` | Generated code. Never edit it by hand. |
| `plugin/src/core/sync/` | The sync engine and the journal. |
| `plugin/src/core/merge/` | The merge strategies of rule M. |
| `plugin/src/core/protocol/`, `plugin/src/core/realtime/` | The API client and the realtime client. |
| `plugin/src/core/auth/`, `plugin/src/core/keys/`, `plugin/src/core/e2ee/` | Sign-in, key management and cryptography. |
| `plugin/src/obsidian/` | The Obsidian adapter and the user interface. |
| `testdata/crypto/`, `testdata/paths/` | Test vectors that the Go and TypeScript tests share. |
| `deploy/charts/`, `nix/` | The Helm chart, and the Nix packages and images. |

For the protocol, read [protocol.md](protocol.md). To build and run the code, read [building.md](building.md).
