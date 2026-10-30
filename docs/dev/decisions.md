# Decisions

For: developers and agents. These are the design decisions that still bind, each with its reason. They are grouped by the section of `SPEC.md` that holds the rule. Do not reverse one without the owner. The history of each decision is in git and the issues.

## §4 Architecture

- **The server never merges content.** It orders revisions, refuses stale commits, stores bytes and sends notifications. All merging happens on the devices. So the server works the same for end-to-end encrypted vaults, where it cannot read the content.
- **`plugin/src/core` never imports `obsidian`.** The engine is a pure library. So its tests run fast against an in-memory vault and server, and the Obsidian API cannot leak into sync decisions.
- **The export job is the only process that holds the escrow private key.** The internet-facing server never has it. So a compromise of the server, PostgreSQL or S3 exposes only ciphertext.

## §4.1 Protocol transport

- **ConnectRPC over protobuf, with one schema for HTTP/1.1 JSON and binary.** The plugin must send requests through Obsidian's `requestUrl` and run in the mobile WebView, where gRPC over HTTP/2 does not work. A hand-written REST API would need a second, hand-kept client. One schema generates the Go server and the TypeScript client.

## §6.2 Push

- **Optimistic concurrency on `base_rev_id`.** A commit succeeds only if its base is the current head. The device whose commit was refused resolves the conflict. So the server needs no locks across requests and never merges.
- **An acknowledged revision is never lost.** Once `CommitRevision` succeeds, the content stays recoverable as the head, in history or as a conflict copy, until a retention purge (principle 1).

## §6.4 Realtime channel

- **The realtime channel only says "pull now". Pulling decides sync.** A missed notification costs only latency, because the periodic pull catches up. So the channel needs no delivery guarantees.
- **The token travels as a WebSocket subprotocol, never in the URL.** A browser cannot set headers on a WebSocket request, and URLs end up in proxy and access logs.

## §9.1 Authentication

- **The OAuth device authorization grant with a public client.** It works the same on desktop and Android, with no redirect handling in the app.
- **Only the refresh token is stored, in device-local storage.** It is never in `data.json`, so tools that back up or sync the vault folder never copy it. The access token stays in memory.

## §9.2 Authorization

- **Authorization is central and runs before every handler.** One interceptor resolves the caller's role from the request's `vault_id`, so a new handler cannot forget the check.
- **There is no admin bypass of vault roles.** Only vault roles decide access through the API. The operator acts through the database, the export job and the server subcommands.

## §9.3 End-to-end encryption

- **Hybrid post-quantum user keys: ML-KEM-768 with X25519, in age's format.** Content stored today stays safe against a future quantum computer, and the standard `age` tool opens an escrow slot.
- **A suite version byte on every ciphertext.** The algorithms can change later without ambiguity, and an unknown suite fails closed.
- **Key commitments in key slots.** A device checks every unwrapped epoch key against its epoch's commitment. So a server cannot hand a device a wrong key.
- **Removing a member starts a new epoch.** New revisions use the new key. The owner's re-key job, not the server, re-encrypts history, because the server never holds a key.

## §9.4 Escrow

- **Escrow is opt-in per vault.** The owner chooses it when the vault is created, and the plugin shows the choice clearly.
- **The escrow key is rotated through a signed chain.** Each rotation is signed by the previous escrow signing key, so a device accepts a new escrow key only when the old key signed it, and a server cannot swap in its own key. Any other change is an escrow reset, which the user must confirm (`docs/design/encryption.md`, *Escrow fingerprint and escrow reset*).

## §11 Retention

- **A document's head revision is never purged**, a head tombstone included. A deleted document stays findable and restorable, and a device that was offline longer than the policy still learns of the delete instead of bringing the document back.
- **Per-vault retention overrides exist, and only the operator sets them** (`vault-sync-server retention set`). Purges cannot be undone, so only the operator, who already holds the database, can shorten a vault's history. There is no API or plugin setting for it.
