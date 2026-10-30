# Protocol

For: developers. Read [architecture.md](architecture.md) first. This page is an overview. The rules are in `SPEC.md` §6, and each RPC, its fields and its errors are documented in the proto comments in `proto/vaultsync/v1/`.

## Transport

The API is defined in protobuf under `proto/vaultsync/v1/` and served with ConnectRPC: the Connect protocol over HTTP/1.1, with JSON or binary bodies. One schema generates the Go server code (`gen/`) and the TypeScript client (`plugin/src/gen/`). The plugin sends its requests through Obsidian's `requestUrl`, which works the same on desktop and Android and is not subject to CORS. The server also sets CORS headers for Obsidian's app origins (`app://obsidian.md`, `capacitor://localhost`, `http://localhost`).

The realtime channel is a WebSocket that carries protobuf frames. It is separate because browsers and Electron cannot stream from the client over `fetch`.

Schema changes must stay backward compatible, because old plugins talk to new servers and the other way round. `make lint` runs `buf breaking` against `master`. See `docs/testing/proto-compatibility.md`.

## Services

| Service | File | What it does |
|---|---|---|
| `ServerInfoService` | `server_info.proto` | `GetServerInfo`: versions, the realtime subscription cap, the issuer and the public client id of the plugin. The only procedure that needs no sign-in. |
| `VaultService` | `vault.proto` | Create, list and delete vaults. |
| `SyncService` | `sync.proto` | `ListChanges` (pull), `CommitRevision` (push), `GetRevision`, `GetDocumentHistory`. |
| `BlobService` | `blob.proto` | Resumable uploads (`BeginBlob`, `PutBlobChunk`, `CommitBlob`) and ranged downloads (`DownloadBlob`). |
| `DeviceService` | `device.proto` | Register, list, rename and remove the caller's devices. |
| `MembershipService` | `membership.proto` | Invitations, members, roles, leaving a vault. |
| `UserKeyService` | `user_key.proto` | The caller's end-to-end encryption key pair and anchor list. |
| `VaultKeyService` | `vault_key.proto` | Epochs, key slots, the membership log, re-keying history and converting a vault to end-to-end encryption. |
| `EscrowJobService` | `escrow_job.proto` | The writes of an escrow key rotation, made by the export job with its own static token. User tokens are refused. |

Errors use the standard Connect codes. Where a client must tell two causes apart, the error carries an `ErrorDetail` with a reason (`errors.proto`), for example `ERROR_REASON_DEVICE_LIMIT`. Clients match the reason, never the message.

## Authentication and authorization

Every procedure except `GetServerInfo` needs a bearer access token, a JWT from the OIDC provider. One interceptor authenticates every procedure, so a new procedure is authenticated by default. A second interceptor runs after it and before the handler. It reads the request's `vault_id` and resolves the caller's role in that vault. A non-member and a vault that does not exist get the same `NOT_FOUND`. A `viewer` that calls a write procedure gets `PERMISSION_DENIED`. Every vault-scoped procedure must be in the table `server.VaultProcedures`, and a test fails if one is missing. See `SPEC.md` §9.1 and §9.2.

## Pull

`ListChanges(vault_id, since_seq, page_size)` returns the revisions with `seq` above `since_seq`, in `seq` order, a page at a time, until `has_more` is false. Every vault has one gapless `seq` counter (`head_seq`). The cursor of a device is the highest `seq` that it fully applied to disk.

Each revision also carries an `anchor`, random bytes that the server draws when it stores the revision. The client sends the anchor of its cursor. If the server no longer has that revision at that `seq`, for example after the server was restored from an older backup, the response sets `diverged`, and the engine runs the resync of `docs/design/engine.md` §9. See `SPEC.md` §6.1.

## Push

A push has three steps (`SPEC.md` §6.2):

1. Upload the content. `BeginBlob`, then `PutBlobChunk` for each chunk in order, then `CommitBlob`. The upload is resumable and idempotent: `BeginBlob` reports the bytes the server already has, and a blob that is already complete is not uploaded again. For plaintext vaults, the blob id is the SHA-256 of the content, and the server checks it when the upload completes.
2. Commit. `CommitRevision` names the document, a `revision_id` chosen by the client, and `base_rev_id`, the revision the client changed. The server accepts the commit only if `base_rev_id` is the current head of the document, or the document is new and `base_rev_id` is empty. It then gives the revision the next `seq`.
3. If the head moved, the server returns `FAILED_PRECONDITION`. The client pulls, merges against the common base (`SPEC.md` §7), and commits again with the new head as the base.

A revision is acknowledged only when `CommitRevision` succeeds. From then on, it is never lost. A retry with the same `revision_id` and the same fields returns the committed revision, so a lost response does not turn into a false conflict.

A rename is a new revision with a new path. A delete is a tombstone revision. A create is a revision with an empty `base_rev_id`. A live path must not collide with the `path_key` of another live document (`ALREADY_EXISTS`). How the engine uses these is in `docs/design/engine.md` §5.

## The realtime channel

Each device opens one WebSocket, `GET /v1/realtime`. On it, the device subscribes to any number of its user's vaults, up to `GetServerInfo.max_realtime_subscriptions`. Each binary message is one protobuf frame: `ClientFrame` or `ServerFrame` in `proto/vaultsync/v1/realtime.proto`.

- From the client: `subscribe{vault_id}` and `unsubscribe{vault_id}`.
- From the server: `subscribed{vault_id, head_seq}`, `vault_changed{vault_id, seq}` and `error`.

The client sends its access token as the WebSocket subprotocol `vaultsync.bearer.<token>`, next to `vaultsync.v1`, because a browser cannot set headers on a WebSocket request. The token is never in the URL and never logged. When the token expires, the server closes the socket, and the client reconnects with a fresh token.

The channel only says "pull now". A device pulls when a `subscribed` head or a `vault_changed` `seq` is above its cursor. Correctness never depends on a notification: the plugin also syncs every 30 seconds. The upgrade checks, the limits, the fan-out between replicas and the reconnect backoff are in `SPEC.md` §6.4.

## Limits

Every input is bounded: request sizes, chunk sizes, page sizes, path lengths, realtime frames and rates (`SPEC.md` §2, principle 4). The size limits that the engine sees are in `docs/design/engine.md` §7. The configured values are in the admin docs.
