# Markdown import

`vault-sync-server import` loads a folder of Markdown notes and attachments, such as an existing Obsidian vault, into a new, empty vault on the server (`docs/design/engine.md` §9). Devices that then connect to the vault download the files like any others.

```sh
vault-sync-server import https://sync.example.com 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 /path/to/notes
```

Create the vault first (in the plugin, or with `CreateVault`) and copy its id. The subcommand is a client of the server's API, like the plugin: run it anywhere that can reach the server's URL and the identity provider, with the folder on local disk. It needs no database or S3 access and none of the server's variables.

It signs in the way the plugin does, with the OIDC device authorization grant: it asks the server (`GetServerInfo`) for the identity provider and the client id (`VAULT_SYNC_OIDC_CLIENT_ID` must be set on the server), writes a line to stderr such as `To sign in, open https://idp.example.com/device?user_code=ABCD-EFGH and confirm the code ABCD-EFGH`, and waits until you approve the sign-in in a browser. No token is ever passed on the command line. You must be an owner or editor of the vault; a viewer or a user who is not a member is refused, and nothing is imported.

Two variables are optional: `VAULT_SYNC_BLOB_MAX_SIZE_BYTES` (default 1 GiB) skips larger files without reading them, and `VAULT_SYNC_LOG_LEVEL` sets the log level. The server still refuses a file over its own `VAULT_SYNC_BLOB_MAX_SIZE_BYTES`, and the subcommand then skips it.

## What it imports

- Every file becomes one document with a single revision and no history: a file whose name ends in `.md` becomes a `TEXT` document (Markdown, merged three-way), any other file a `BLOB`.
- Every empty folder becomes a `FOLDER` document, so it appears on every device.
- Names are converted to Unicode NFC, which covers names a Mac wrote in NFD.
- The revisions are attributed to the signed-in user and a device named `vault-sync-server import`, which is registered for the user for the run and removed when it ends.

The vault must never have had a document; the subcommand refuses any other. Hidden files and folders, including Obsidian's `.obsidian` configuration folder, are files like any others: remove what you don't want imported from the folder first.

## Importing into an end-to-end encrypted vault

The subcommand also imports into an end-to-end encrypted vault (`docs/encryption.md`) with your own key. It encrypts on the machine it runs on, exactly as the plugin does, so the server only ever receives ciphertext: paths and contents are sealed under the vault's current key epoch, and nothing readable, no passphrase and no key reaches the server or the logs. You unlock your key with your recovery passphrase or with your private key:

```sh
vault-sync-server import -passphrase-file ~/passphrase.txt https://sync.example.com 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 /path/to/notes
vault-sync-server import -private-key-file ~/identity.txt https://sync.example.com 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 /path/to/notes
```

- `-passphrase-file FILE`: a file holding your recovery passphrase. The whole file is the passphrase, without one trailing line ending.
- `-private-key-file FILE`: a file holding your private key as an age hybrid identity (`AGE-SECRET-KEY-PQ-1…`), with blank lines and `#` comments ignored.
- With neither, the subcommand asks for the passphrase at the terminal without echoing it. When standard input is not a terminal, it fails instead.

The secret itself is never a command-line argument. Files may be at most 64 KiB. With the passphrase, the subcommand unlocks your key the way a new device does (`GetUserKeyParams`, then `UnlockUserKey`): a wrong passphrase counts against the server's limit of attempts. With either secret, it opens your key slots for the vault's first and current epochs and checks each key against its epoch's key commitment before using it. If a key rotation replaces the epoch during the import, it re-encrypts under the new epoch and retries.

You must have enabled encryption in the plugin, and the vault must already have a key: open it in the plugin on an owner's device first, and as an editor, wait until an owner's device has shared the vault key with you. Otherwise the subcommand refuses the import and imports nothing.

### With the escrow identity

An operator who holds the deployment's escrow identity (`docs/encryption.md`, `docs/export.md`) can import into a vault that has escrow, without any member's passphrase or key:

```sh
vault-sync-server import -escrow-identity-file /secure/escrow-identity.txt https://sync.example.com 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 /path/to/notes
vault-sync-server import -escrow https://sync.example.com 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 /path/to/notes
```

- `-escrow-identity-file FILE`: an age identity file holding one or more escrow identities (`AGE-SECRET-KEY-PQ-1…`), with blank lines and `#` comments ignored: the same file the export job reads from `VAULT_SYNC_ESCROW_IDENTITY_FILE`. During an escrow key rotation, list both the new and the retiring identity. At most 64 KiB.
- `-escrow`: type the escrow identity at the terminal, without echo. When standard input is not a terminal, the subcommand fails instead.

The identity is never a command-line argument, and never logged or sent to the server. You still sign in as an owner or editor of the vault: the identity only unlocks the vault's keys on your machine. The subcommand lists the vault's escrow slots (`ListKeySlots` with the escrow recipient kind, open to editors and owners only), opens those of the first and current epochs with the identity that each names, and checks each key against its epoch's key commitment before using it. A vault without escrow, or an identity file that doesn't hold the key a slot is wrapped to, is refused, and nothing is imported. It encrypts and retries after a rotation exactly as with your own key.

Give at most one of `-passphrase-file`, `-private-key-file`, `-escrow-identity-file` and `-escrow`.

## What it skips

It skips the following, lists each in the report with the reason, and imports everything else. Names are checked with the same rules the server applies to every new path:

- a name outside the portable set (`engine.md` §6): a `< > : " / \ | ? *` or control character, a leading or trailing space, a trailing `.`, a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without an extension), a name over 255 UTF-8 bytes, a path over 1024 UTF-8 bytes, or a name that is not valid UTF-8. A folder with such a name is skipped with everything in it;
- a name that another imported file or folder already takes, ignoring case and Unicode normalization (for example `Note.md` beside `note.md`);
- a file larger than `VAULT_SYNC_BLOB_MAX_SIZE_BYTES`, or than the server's limit;
- symbolic links (never followed) and anything that is not a regular file or folder.

Rename the skipped files, create a new vault, and import again.

## Report and exit status

Logs go to stderr. When it ends, the subcommand writes one line of JSON to stdout:

```json
{"status":"partial","vault_id":"0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12","source":"/path/to/notes","imported":{"text":412,"blob":37,"folder":2},"bytes":48213397,"skipped":[{"path":"Inbox/what?.md","reason":"unportable name: a new path may not be created at this path: a new path must not contain any of < > : \" | ? *"}]}
```

| `status` | Exit status | Meaning |
| --- | --- | --- |
| `ok` | 0 | Every file and empty folder was imported. |
| `partial` | 1 | The import finished; `skipped` lists what it left out. |
| `failed` | 1 | The import did not start or stopped early (`error` says why). What it imported before stopping stays in the vault: create a new vault and import again. |

A usage error exits with status 2.
