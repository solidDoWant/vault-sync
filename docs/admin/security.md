# Security model

For admins who run the server. This page explains how the server checks who calls it, what each caller can do, which limits protect the server, and what end-to-end encryption protects against when someone attacks the server. [Identity provider](identity-provider.md) explains the sign-in setup. [Encryption for operators](encryption.md) explains what the server can and cannot see in an encrypted vault.

## Sign-in tokens

Every RPC except `vaultsync.v1.ServerInfoService/GetServerInfo` requires an `Authorization: Bearer` header with a JWT access token from the issuer. `GetServerInfo` returns only public data: the build and protocol versions, the realtime subscription limit, the issuer URL and the plugin's client ID.

The server accepts a token only if it is at most 16 KiB, and its signature and claims meet the checks in [What the provider must offer](identity-provider.md#what-the-provider-must-offer).

Every other token gets the Connect code `unauthenticated` (HTTP 401), with no detail about the reason. The server logs the reason at `debug` level. It never logs tokens or claims.

### Signing keys of the issuer

The server fetches the key set of the issuer on the first authenticated request ([Where the server gets the signing keys](identity-provider.md#where-the-server-gets-the-signing-keys)). It fetches the keys again in two cases:

- A token names a key id that the server does not know (key rotation).
- The cached keys are older than one hour, so that the server stops trusting withdrawn keys.

The server fetches the keys at most once every 30 seconds. So a flood of tokens with made-up key ids cannot cause a flood of requests to the issuer. Only one fetch runs at a time, and it stops after 10 seconds. While the server fetches keys that are an hour old again, other requests use the cached keys and do not wait. So a slow or hanging issuer delays only the request that started the fetch, and requests that name an unknown key id.

A refused URL or redirect makes the fetch fail. Before the first successful fetch, the server rejects every token. After it, the server keeps the cached keys.

## Authorization

The server checks the caller's membership in a vault before every RPC that names a `vault_id`. There is no administrator bypass: an operator has no role in a vault through the server, only through a membership like any user.

- A caller who is not a member gets `not_found` (HTTP 404). This is the same response as for a vault that does not exist, so a caller cannot find out which vaults exist.
- A `viewer` who calls a write RPC (committing revisions, uploading blobs) gets `permission_denied` (HTTP 403).
- A malformed `vault_id` (not a lowercase hyphenated UUID) gets `invalid_argument`.

The roles are `owner`, `editor` and `viewer`. [Sharing](../user/sharing.md#roles) explains them for users. `SPEC.md` §9.2 lists which role each RPC needs.

The server never merges content. It orders revisions, enforces optimistic concurrency (a commit must name the revision it replaces), stores bytes and sends notifications. All merging happens on the devices.

## Fixed limits

These limits protect the server from one user who uses too many resources. You cannot change them.

| Limit | Value | Error when it is reached |
|---|---|---|
| Vaults that a user owns, not counting deleted ones | 100 | `resource_exhausted` |
| Members of a vault | 100 | `resource_exhausted` |
| Pending invitations of a vault | 100 | `resource_exhausted` |
| Devices of a user that are not removed | 100 | `resource_exhausted` (HTTP 429), reason `ERROR_REASON_DEVICE_LIMIT` |
| Wrong recovery passphrases of a user in one hour | 10 | `resource_exhausted`, reason `ERROR_REASON_PASSPHRASE_ATTEMPTS_EXHAUSTED`, until the hour ends |
| Length of a vault name or a device name | 256 bytes | `invalid_argument` |
| Size of a user's sealed vault list (anchor list) | 4,800,045 bytes (100,000 vaults) | The request is refused |
| Size of a key slot | 256 bytes | The request is refused |
| Blobs that one replica composes at the same time | 4, at most 2 for one user | The user's further commits wait |
| Realtime client frame | 4 KiB | The connection closes |
| Realtime client frames | 20 per second on average | The connection closes |

When a user has 100 devices, they remove devices that no longer exist in the plugin settings. The user's existing devices keep syncing. The passphrase limit is counted in PostgreSQL, so every replica enforces the same count. It lifts by itself when the hour ends, so there is nothing for you to reset.

The per-user limit on concurrent requests (`VAULT_SYNC_MAX_CONCURRENT_RPCS_PER_USER`, see the [configuration reference](configuration-reference.md#listeners-request-limits-shutdown-and-logging)) also answers `resource_exhausted`, with the reason `ERROR_REASON_TOO_MANY_CONCURRENT_REQUESTS`. Clients tell the two apart by the reason, not by the message.

Vault names and device names cannot contain control characters (Unicode category `Cc`, such as U+0000 or a newline), format characters (`Cf`, such as the bidi controls U+202A–U+202E and U+2066–U+2069, zero-width spaces and joiners, or the byte order mark), or the line and paragraph separators U+2028 and U+2029. Device names also cannot be blank.

## Request size and the WAF

Requests and responses are bounded by `VAULT_SYNC_MAX_REQUEST_BYTES` in both directions. The server measures a response by the bytes that it sends, after compression when the client accepts it. A response over the limit fails with `RESOURCE_EXHAUSTED`. The plugin uploads files in chunks of at most `VAULT_SYNC_BLOB_MAX_CHUNK_BYTES`. Every chunk except the last must be at least 64 KiB, or the advertised `max_chunk_size` if that is smaller.

A maximum-size chunk fits only in the binary protobuf encoding, which the plugin uses. A client that uses the Connect JSON encoding (base64 bytes, a third larger) must send smaller chunks and request smaller download ranges.

If a WAF in front of the server inspects bodies (for example Coraza with Istio, see [The ingress](install.md#the-ingress)), keep the limits of the server at or below the limits of the WAF. The Coraza WAF of the reference setup rejects inspected request bodies above 1 MiB. vault-sync never sends a larger request with the defaults: chunks are at most 768 KiB (`VAULT_SYNC_BLOB_MAX_CHUNK_BYTES`) and requests at most 1 MiB (`VAULT_SYNC_MAX_REQUEST_BYTES`). Keep it that way:

- Keep `config.server.maxRequestBytes` at or below the request body limit of the WAF. The server does not start if a chunk (`config.server.blob.maxChunkBytes`) plus 1024 bytes does not fit in `VAULT_SYNC_MAX_REQUEST_BYTES`.
- Responses are bounded by the same `VAULT_SYNC_MAX_REQUEST_BYTES`. If the WAF also inspects response bodies, its response limit must be at least as large.
- The server reads a request body before it checks the bearer token. So keep the limit low: it is also the amount that a caller without a token can make the server read per request.

Paths of documents are also bounded: at most 4096 bytes of UTF-8 and at most 8192 bytes after normalization. `SPEC.md` §6.2 has the full rule for paths.

## Cross-origin requests

On the API listener, the server allows cross-origin requests only from the Obsidian app origins `app://obsidian.md`, `capacitor://localhost` and `http://localhost`.

## The realtime channel

The plugin opens one WebSocket per device to learn about new revisions ([The ingress](install.md#the-ingress) has what your ingress needs for it).

- Sign-in: Browser clients (the Obsidian plugin) send the access token as the WebSocket subprotocol `vaultsync.bearer.<token>`, next to `vaultsync.v1`. Other clients can send `Authorization: Bearer <token>` instead. The token is never in the URL, and the server never logs the `Sec-WebSocket-Protocol` header. If your proxy logs request headers, exclude that one.
- Refused upgrades: The server refuses an upgrade with HTTP 401 without a valid token, and with HTTP 403 from a browser origin other than the Obsidian app origins. When the token expires, the server sends an `UNAUTHENTICATED` error frame and closes the connection. The client then connects again with a new token.
- Membership: The server checks each subscription against the caller's vault membership, and also every notification before it sends it. A non-member gets `NOT_FOUND`, exactly as for a vault that does not exist. A member who is removed from a vault stops getting its notifications. Before each delivery, one membership query per vault covers up to 1,000 subscribed users. If that query fails, the server does not send the notification, and clients catch up on their next pull.
- Limits: The frame limits are in [Fixed limits](#fixed-limits). The server queues notifications for a slow client only up to a fixed bound. A client that falls further behind is disconnected and connects again. The other limits are settings ([Realtime channel](configuration-reference.md#realtime-channel)).

## The export and document paths

The export treats document paths as untrusted. It never writes outside a vault's directory, through a symbolic link or over a file. A path that fails the check goes to the unplaced tree ([Output layout](backup-and-restore.md#output-layout)).

## Threat model for encrypted vaults

This section says which attacks end-to-end encryption holds against, and which it does not. It covers encrypted vaults only. A plaintext vault is protected by the access control of the server alone. [Encryption](../user/encryption.md) has the short version for users. `docs/design/encryption.md` explains how the protection works.

### A stolen copy of the database or the bucket

Someone can get a copy of the PostgreSQL database or the S3 bucket, from a backup, a leaked dump or a break-in. They then have the ciphertext of every file and path, the wrapped key slots, every user's private key wrapped under that user's passphrase, and the metadata in [What the server can and cannot see](encryption.md#what-the-server-can-and-cannot-see).

Without a member's passphrase or the escrow identity, they cannot read any file or path. Every guess at a passphrase costs them a full Argon2id computation, and no server slows them down further. So they can guess a weak passphrase offline, but not a long one that is used nowhere else.

Old copies keep what they held when they were made. A backup from before a passphrase change still opens with the old passphrase. A backup from before a key was retired still holds the slots and the ciphertext of that key. So protect your backups as well as the live database and bucket.

### An actively malicious server

End-to-end encryption also holds against a server that is actively malicious, or against an attacker who controls the running server. Such a server cannot get a vault key. It cannot add its own public key to a vault, replace a member's key or the escrow key with its own, inject a vault key that it chose, or roll a vault back to an older key.

This holds because devices never trust the server about who is in a vault or which key is current. Each encrypted vault has a signed membership log, and each vault key is signed by an owner. When something does not verify, the plugin stops syncing that vault, keeps the local files, and reports it. It never falls back to trusting the server.

Two moments still rely on trust:

- When an owner converts a plaintext vault, their device takes every member's key as the server reports it at that moment. The plugin shows every member's fingerprint and asks the owner to compare them with the members before converting.
- A device trusts the first escrow key that the server shows it. Publish the fingerprint of the escrow key so that owners can compare it when they create a vault ([Publish the escrow fingerprint](encryption.md#publish-the-escrow-fingerprint)).

### What encryption does not protect

- Metadata: The server sees everything in [What the server can and cannot see](encryption.md#what-the-server-can-and-cannot-see), including exact file sizes, path lengths, timing and devices.
- Withheld, delayed or replayed changes: A malicious server can hold back changes, deliver them late, show an older state of a file, or stop serving a vault. Devices detect a rollback of the keys and the membership log, not whether the files they receive are the newest ones.
- Authorship: Encryption does not prove which member wrote a revision. Every holder of a vault key can encrypt under it. The device and member that a revision comes from are what the server reports.
- A compromised device: A device holds the user's private key, the vault keys and the plaintext files. Anyone who controls it can read them.
- A member: Every member can read the whole vault and keep copies. Removing a member protects only what is committed afterwards. A member who leaves keeps the current key until an owner's device next syncs and rotates the key.
- File-name guesses by a removed member: The secret behind the file-name fingerprints of the server comes from the first key of the vault and never changes, so a removed member keeps it. With a later copy of the database, they can test whether a file with a name that they guess exists. They cannot read the names that exist.
- Old copies: Database backups and older S3 object versions keep the slots and ciphertext of retired keys, and each private key wrapped under every earlier passphrase. Whoever holds such a copy and also an old passphrase, a retired key, or the escrow identity of that time can read what the copy holds.
- A lost single device: There is no way to revoke one device's copy of a private key. An owner can rotate the key of a vault instead. But a device that holds the private key can open the new key too, as long as it can still sign in to the server.
