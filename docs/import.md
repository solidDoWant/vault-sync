# Markdown import

`vault-sync-server import` loads a folder of Markdown notes and attachments, such as an existing Obsidian vault, into a new, empty vault on the server (`docs/design/engine.md` §9). Devices that then connect to the vault download the files like any others.

```sh
vault-sync-server import 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 /path/to/notes
```

Create the vault first (in the plugin, or with `CreateVault`) and copy its id. Run the subcommand where it can reach PostgreSQL and S3, with the server's variables (`docs/configuration.md`): the `VAULT_SYNC_DATABASE_*` and `VAULT_SYNC_S3_*` variables are required, `VAULT_SYNC_BLOB_MAX_SIZE_BYTES` sets the largest file imported, and `VAULT_SYNC_LOG_LEVEL` the log level. In Kubernetes, `kubectl cp` the folder into a running server pod and run the subcommand there with `kubectl exec`.

## What it imports

- Every file becomes one document with a single revision and no history: a file whose name ends in `.md` becomes a `TEXT` document (Markdown, merged three-way), any other file a `BLOB`.
- Every empty folder becomes a `FOLDER` document, so it appears on every device.
- Names are converted to Unicode NFC, which covers names a Mac wrote in NFD.
- The revisions are attributed to the vault's owner and a device named `vault-sync-server import`, which is registered for the run and removed when it ends.

The vault must be a plaintext vault that has never had a document; the subcommand refuses any other. Hidden files and folders, including Obsidian's `.obsidian` configuration folder, are files like any others: remove what you don't want imported from the folder first.

## What it skips

It skips the following, lists each in the report with the reason, and imports everything else:

- a name outside the portable set (`engine.md` §6): a `< > : " / \ | ? *` or control character, a leading or trailing space, a trailing `.`, a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without an extension), a name over 255 UTF-8 bytes, a path over 1024 UTF-8 bytes, or a name that is not valid UTF-8. A folder with such a name is skipped with everything in it;
- a name that another imported file or folder already takes, ignoring case and Unicode normalization (for example `Note.md` beside `note.md`);
- a file larger than `VAULT_SYNC_BLOB_MAX_SIZE_BYTES`;
- symbolic links (never followed) and anything that is not a regular file or folder.

Rename the skipped files, create a new vault, and import again.

## Report and exit status

Logs go to stderr. When it ends, the subcommand writes one line of JSON to stdout:

```json
{"status":"partial","vault_id":"0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12","source":"/path/to/notes","imported":{"text":412,"blob":37,"folder":2},"bytes":48213397,"skipped":[{"path":"Inbox/what?.md","reason":"unportable name: the name contains '?'"}]}
```

| `status` | Exit status | Meaning |
| --- | --- | --- |
| `ok` | 0 | Every file and empty folder was imported. |
| `partial` | 1 | The import finished; `skipped` lists what it left out. |
| `failed` | 1 | The import did not start or stopped early (`error` says why). What it imported before stopping stays in the vault: create a new vault and import again. |

A usage error exits with status 2.
