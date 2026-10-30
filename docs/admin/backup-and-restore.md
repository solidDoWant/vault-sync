# Backup and restore

For: admins. You run the server with the Helm chart, and you back up PostgreSQL and S3 with your own tools.

This page tells you what to back up, how to run the plaintext export job and read its output, and how to undelete a vault. The export job is a CronJob that writes a plaintext copy of every vault to a volume. Your tape-archival tooling then reads that volume.

## What to back up

The server keeps all its data in one PostgreSQL database and one S3 bucket ([What lives where](postgresql-and-s3.md#what-lives-where)). Back up both of them, as a pair. One without the other is not a usable backup.

Run the export job too. The export is the plaintext disaster-recovery copy of every vault. You can read it with any editor, without vault-sync, PostgreSQL or S3. So it is what you restore from if you lose the database or the bucket. The server does not restore from an export yet. That is planned for Phase 6, and the export is designed so that a later restore can be exact.

Old backups keep the keys and the encrypted data that they held when you made them. [What encryption does not protect](security.md#what-encryption-does-not-protect) tells you what that means for end-to-end encrypted vaults.

## Restore a server

To restore the server from a backup of PostgreSQL and S3, stop the server, restore both, and then start the server again. To get a consistent pair, take the PostgreSQL snapshot first and the S3 snapshot second. The server writes the content of a file to S3 before it records the version in PostgreSQL, and it never deletes content that a version still uses. So every version in the earlier PostgreSQL snapshot has its content in the later S3 snapshot.

Each device finds out by itself that the server was restored, and syncs again from the start. If a file on a device differs from the file on the restored server, the device keeps both: the server's version at the path, and its own version as a conflict copy. Changes that the restored server does not know are uploaded again. For more detail, see [Server restore](../design/engine.md#9-server-restore-offline-snapshot).

## The export job

The export is a one-shot job. It runs, writes a JSON summary to stdout, and exits. Run it on a schedule, with its own credentials.

### Run it with the Helm chart

The chart runs the export as a CronJob, but it is off by default. To turn it on, set `config.export.enabled: true` and give it an output volume in `config.export.output.persistence`. [Chart values](chart-values.md) lists every value of the export.

- The job runs daily at 03:00 by default. Two runs never overlap. The chart stops a run after 6 hours by default, so a hung run (for example on a stalled NFS volume) cannot block every later run. Kubernetes retries a failed run twice.
- The job writes to the directory `config.export.output.directory` (`vaults` by default) in the volume. It also keeps a lock file and a staging directory next to that directory. So the top level of the volume must be writable.
- The job creates files with mode `0640` and directories with mode `0750`, owned by user and group `65532` (the `fsGroup` of the pod). Give your tape-archival tooling that group. Plaintext notes and paths are never readable by others.
- By default, the job uses the database and S3 settings of the server. Give it its own database role and read-only S3 credentials. The next section lists what they need.
- To export end-to-end encrypted vaults that have escrow, give the job the escrow identity in `config.export.escrow`. The chart mounts it into the export job only, never into the server. See [End-to-end encrypted vaults](#end-to-end-encrypted-vaults).

### Run it by hand

The image holds one binary, `/bin/vault-sync-server`. The export is its `export` subcommand:

```sh
vault-sync-server export -out /backup/vault-sync
```

| Flag | Description |
|---|---|
| `-out DIR` | Required. The export directory. Every run replaces its whole content with a fresh export. |

If a flag is not valid, the export exits with status 2 and prints no summary.

### Configuration and permissions

The export reads the PostgreSQL, S3 and log-level variables of the server, and `VAULT_SYNC_ESCROW_IDENTITY_FILE`. It ignores all the other variables. The S3 variables are required, because the export reads the content of files from S3. [Which variables each command reads](configuration.md#which-variables-each-command-reads) has the list, and the [configuration reference](configuration-reference.md#postgresql-connection) describes each variable. `VAULT_SYNC_S3_IDLE_TIMEOUT` makes the export fail if the object store stops answering. It does not stop a long download of a large file that still makes progress.

The export only reads, except for one row of status:

- Every database session that it opens sets `default_transaction_read_only`. PostgreSQL refuses any write, even if the role can write.
- At the end of each run, one read-write transaction updates the single row of `export_status`. It records the time the run finished and its status (`ok`, `partial` or `failed`). For `ok`, it also records the time of the last successful export. Every server replica reports that time as `vault_sync_service_export_last_success_timestamp_seconds` ([Service-wide metrics](metrics-reference.md#service-wide-metrics)). If the export cannot record the row, it logs a warning. The status and the exit code of the run do not change.
- It never runs migrations. Run it against a database that the server already migrated.
- It reads objects from S3, and never writes or deletes any.

So the export needs only these permissions:

- A database role with `SELECT` on `vaults`, `documents`, `revisions` and `blobs`, `INSERT` and `UPDATE` on `export_status`, and no other privilege:

  ```sql
  GRANT SELECT ON vaults, documents, revisions, blobs TO vault_sync_export;
  GRANT INSERT, UPDATE ON export_status TO vault_sync_export;
  ```

- S3 credentials with `s3:GetObject` and `s3:ListBucket` (for `HeadBucket`) on the bucket. [Permissions](postgresql-and-s3.md#permissions) shows how to create them with Ceph RGW.

## What an export contains

An export is a copy of the current files of your vaults, for archiving.

The export holds:

- Every file that exists (is not deleted) in a plaintext vault when the export of that vault starts. This includes notes, attachments and any other file that clients sync. Each file is byte for byte as last synced to the server.
- Files that a filesystem cannot hold at their path. Examples are a file `a` next to a folder `a` that contains `a/b.md`, or a name longer than 255 bytes. The export keeps these in a separate folder next to the folder of the vault, named by document id. The manifest records their original path. The export never leaves out a file because of its name. See [Documents that cannot be placed at their path](#documents-that-cannot-be-placed-at-their-path).
- Vaults that an owner deleted, until the server purges them 30 days later. So your backups still hold a vault while you can undelete it. The export writes a deleted vault like any other, with a `<vault-id>.DELETED` file next to its folder that holds the deletion time. The export leaves out a purged vault.
- One manifest per vault. It lists every file with its path, kind, revision, size and SHA-256, and says where in the export its bytes are.

The export does not hold:

- History. The export holds only the latest version of each file. The server keeps earlier versions, but the export does not.
- Deleted files. The server keeps them as tombstones (records of a delete), but the export does not.
- End-to-end encrypted vaults without escrow. Only their members can decrypt them. So the export skips them and lists them in the summary as skipped (`no_escrow`). The export decrypts vaults with escrow and writes them like plaintext vaults. If the export has no escrow identity (`VAULT_SYNC_ESCROW_IDENTITY_FILE`), it skips those vaults too (`no_escrow_identity`).
- Anything that is not synced to the server. This includes edits that a device did not upload yet, and anything that clients do not sync, for example the `.obsidian/` settings of Obsidian.
- Who has access. The export does not write vault members, roles, users or devices.
- Files whose stored content is missing or corrupt in the object store, or, in a vault with escrow, cannot be decrypted. Only these files can have no bytes in the export. The export writes no part of such a file. The manifest still lists the file (as `missing`), the summary counts it, and the run reports `partial` with exit status 1.
- Changes that devices make while the export of a vault runs. The next run exports them.

## Output layout

```
DIR/
  .vault-sync-export                    marker: {"format":2,"started_at":"…"}
  <vault-id>/                           the vault's tree: each document at its path
  <vault-id>.unplaced/<document-id>     documents that cannot be placed at their path (only if there are any)
  <vault-id>.manifest.jsonl             the vault's manifest
  <vault-id>.DELETED                    only for a vault an owner deleted: its deletion time (RFC 3339)
```

- The directory of each vault has the id of the vault as its name, not the name of the vault. Users choose names, can change them, and two vaults can have the same name. The summary and the manifest map ids to names.
- The directory of a vault holds its live documents, each at its path, as of the `head_seq` of the vault when its export started. The `head_seq` is the point in the history of the vault that the export copies. The content of each file is the head revision (latest version) of its document, byte for byte.
- The unplaced tree and the manifest are next to the directory of the vault, never in it. So no document path can be mistaken for them. A user file named `<vault-id>.manifest.jsonl` or `.vault-sync-export` is exported unchanged in the directory of the vault. Vault ids are UUIDs, so the suffixes cannot collide with the directory of another vault.
- Every directory in the directory of a vault or in its unplaced tree holds at least one exported file. A document that is unplaced or `missing` leaves no empty directory. The directory of the vault exists even when it holds no file.
- Only `/` separates directories. A `\` in a document path is part of the file name.
- Directories have mode `0750` and files (manifests too) have mode `0640`, less the umask of the process.
- Skipped and failed end-to-end encrypted vaults get no directory and no manifest. The summary lists them as `skipped` or `failed`.

### End-to-end encrypted vaults

If you set `VAULT_SYNC_ESCROW_IDENTITY_FILE` to the escrow identity, the export decrypts every vault that has escrow. The escrow identity is the private escrow key ([The escrow key](encryption.md#the-escrow-key)). The export writes the tree and the manifest of the vault like those of a plaintext vault, with plaintext paths and contents. The manifest holds the plaintext path, size and SHA-256, and its `encryption` is `e2ee`.

- Before the export writes anything for a vault, it opens the escrow slot of every epoch (key generation) that has one. It uses every identity in the file. During an escrow key rotation, the file holds more than one. The export makes sure that each key matches the key commitment of its epoch. If a slot does not open with the identity that it names, or its key does not match, the summary marks the vault `failed` with the reason. The export writes nothing of that vault, so it never writes anything with a wrong key. The run is `partial`, and the export writes the other vaults.
- The export decrypts each document with the key of the epoch of its head revision: the path and the content. It makes sure that the content matches its blob id. Revisions from before a plaintext vault was converted (epoch 0) are plaintext, and the export writes them as they are.
- The export still lists a document that it cannot decrypt. The document is `missing` if its content does not decrypt, does not match its blob id, or has an epoch without an escrow slot (because the owner turned escrow off later). The manifest then shows the stored (encrypted) `size` and an empty `sha256`, and the summary counts it in `document_errors`. If only the path does not decrypt, the export writes the document to the unplaced tree with an empty `path`.

### Documents that cannot be placed at their path

The export writes a document to `<vault-id>.unplaced/<document-id>`, a file named by its document id that holds its bytes, when it cannot create its path in the directory of the vault:

- The path conflicts with the file or directory of another document. For example, with live documents `a` and `a/b.md`, the export places the document with the lower id and writes the other to the unplaced tree. Data that the server already holds can contain such collisions.
- The filesystem cannot hold the path, for example a name longer than 255 bytes.
- The path is not vault-relative, or is not valid UTF-8.
- Someone put a symbolic link in the tree of the export while it runs.

Such a document is still exported, so the run stays `ok`. The summary counts these documents (`unplaced`). The manifest records the original path of each one and the reason. If the export cannot write the unplaced file, the run fails and the previous export stays in place. The export never drops a document that it can read.

### Manifest

`<vault-id>.manifest.jsonl` lists every live document of the vault and where its bytes are. Use it to make sure that an export is complete. A later restore will use it to restore exactly. It is a [JSON Lines](https://jsonlines.org/) file: a line for the vault, one line for each document, and an end line with counts. A manifest without the end line is incomplete, for example a truncated copy. The format has a version number, 2 now, in the marker and in each manifest. The doc comments of the manifest types in `internal/export/manifest.go` describe every field.

```json
{"type":"vault","format":2,"vault_id":"0192…","name":"Notes","encryption":"none","head_seq":9123,"started_at":"2026-10-18T03:00:00Z"}
{"type":"document","document_id":"0192…a1","path":"daily/2026-10-18.md","kind":"text","revision_id":"0192…","size":512,"sha256":"9f86…","status":"placed","location":"0192…/daily/2026-10-18.md"}
{"type":"end","documents":1,"placed":1,"unplaced":0,"missing":0}
```

To make sure that the files match their manifests, compare the SHA-256 of each file with `jq` and GNU coreutils. This command does not handle paths that contain a newline or a backslash:

```sh
cd /backup/vault-sync
jq -r 'select(.type == "document" and .location) | "\(.sha256)  \(.location)"' ./*.manifest.jsonl | sha256sum --check --quiet
```

### Atomic replacement

A run never leaves a half-written export. The export writes the new tree to a staging directory next to `DIR`, and then swaps it with `DIR` in one step. At every moment, `DIR` holds one complete export. A run that fails, is killed or loses power leaves the previous export untouched. This has some requirements:

- The platform is Linux. On other platforms, the export refuses to run.
- The parent of `DIR` exists, is writable, and is on the same filesystem as `DIR`. `DIR` must not be a mount point. Mount the volume at the parent instead. For example, mount a volume at `/backup` and use `-out /backup/vault-sync`.
- `DIR` is not a symbolic link.
- If `DIR` exists and is not empty, it holds a previous export (its `.vault-sync-export` marker). The export refuses to replace any other directory, so a mistyped `-out` cannot destroy other data.
- The volume has space for two full exports while a run is in progress.

A lock file, `.<name>.lock` in the parent of `DIR`, makes a second run against the same `DIR` fail at once. If the lock file is a symbolic link, the run fails. Remove the link. The run also fails if the lock file is not a regular file with one hard link, owned by the user that runs the export (for example a hard link to another file, a FIFO or a directory). Remove it. Each run first removes the staging directories that interrupted runs left behind.

Read `DIR` with your archival tooling while no export runs, or make the tooling accept that the tree can change between two reads.

## Summary and exit status

When the run ends, or fails after the flags are read, the export writes one JSON line to stdout. Logs go to stderr as JSON. Neither the summary nor the logs ever contain document paths or contents. They name documents by id. Paths are only in the manifests, in the export.

```json
{"status": "partial", "output": "/backup/vault-sync", "started_at": "2026-10-18T03:00:00Z", "duration_seconds": 12.5,
 "vaults": 2, "skipped_vaults": 1, "failed_vaults": 0, "files": 1532, "bytes": 48213344, "document_errors": 1, "unplaced": 1,
 "vault_details": [
   {"id": "0192…", "name": "Notes", "encryption": "none", "head_seq": 9123, "files": 1530, "bytes": 48213000, "unplaced": 1,
    "document_errors": [{"document_id": "0192…", "reason": "stored content is missing"}]},
   {"id": "0193…", "name": "Work", "encryption": "none", "head_seq": 12, "files": 2, "bytes": 344, "unplaced": 0},
   {"id": "0194…", "name": "Private", "encryption": "e2ee", "head_seq": 40, "skipped": "no_escrow", "files": 0, "bytes": 0, "unplaced": 0}]}
```

The `status` is one of three values:

- `ok`: the new export is in place, and it holds the bytes of every live document of every exported vault.
- `partial`: the new export is in place, but it has gaps. Some documents are missing, corrupt or cannot be decrypted (`document_errors`), or the escrow keys of some encrypted vaults do not match (`failed_vaults`).
- `failed`: the run stopped, and `error` says why. The previous export, if any, is untouched.

The summary lists at most 100 document errors, under their vault, with a reason. It counts all of them, and the manifests list all of them. A vault with `unplaced` documents does not make the run `partial`, but look at it. On a `failed` run, `vault_details` covers only the vaults that the run reached. If the run does not fail, its last log line (`"msg": "export finished"`) repeats the counts of the summary, for alerts on logs.

The exit status is `0` only for `ok`. It is `1` for `partial` or `failed`, and `2` for flags that are not valid. Alert on an exit status that is not 0, for example a failed Kubernetes Job. Then use the summary to tell a `partial` export (in place, with gaps) from a `failed` one (not in place). The job has no metrics endpoint. The [VaultSyncExportNotSucceeding](alerts.md#vaultsyncexportnotsucceeding) alert fires when the last export with the status `ok` is more than 36 hours old.

## Signals

If the export gets `SIGTERM` or `SIGINT`, it stops at the next document. It removes the staging directory, the summary reports `failed`, and the previous export stays in place.

## Import Markdown

The `vault-sync-server import` subcommand loads a folder of Markdown notes and attachments into a new, empty vault on the server. The folder can be an existing Obsidian vault. Devices that connect to the vault later download the files like any other files. For how the engine treats an import, see [the engine design](../design/engine.md) (§9).

```sh
vault-sync-server import https://sync.example.com 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 /path/to/notes
```

Before you run it, create the vault in the plugin or with `CreateVault`, and copy the id of the vault.

The subcommand is a client of the API of the server, like the plugin. You can run it on any machine that can connect to the URL of the server and to the identity provider. The folder must be on the local disk of that machine. The subcommand needs no access to PostgreSQL or S3, and it needs none of the variables of the server.

The subcommand signs in the same way as the plugin, with the OIDC device authorization grant:

1. It asks the server (`GetServerInfo`) for the identity provider and the client id. `VAULT_SYNC_OIDC_CLIENT_ID` must be set on the server. See [Sign-in (OIDC)](configuration-reference.md#sign-in-oidc).
2. It writes a line to stderr, for example `To sign in, open https://idp.example.com/device?user_code=ABCD-EFGH and confirm the code ABCD-EFGH`.
3. It waits until you approve the sign-in in a browser.

You never give a token on the command line. You must be an owner or an editor of the vault. The subcommand refuses a viewer and a user who is not a member, and it imports nothing.

Two variables are optional. [Which variables each command reads](configuration.md#which-variables-each-command-reads) lists them for every command:

- `VAULT_SYNC_BLOB_MAX_SIZE_BYTES` (default 1 GiB): the subcommand skips larger files and does not read them. See [Blob uploads](configuration-reference.md#blob-uploads).
- `VAULT_SYNC_LOG_LEVEL`: the log level. See [Listeners, request limits, shutdown and logging](configuration-reference.md#listeners-request-limits-shutdown-and-logging).

The server still refuses a file that is larger than its own `VAULT_SYNC_BLOB_MAX_SIZE_BYTES`. The subcommand then skips that file.

### What it imports

- Each file becomes one document with a single revision and no history. A file whose name ends in `.md` becomes a `TEXT` document (Markdown, merged three-way). Any other file becomes a `BLOB` document.
- Each empty folder becomes a `FOLDER` document, so that it appears on every device.
- The subcommand converts names to Unicode NFC. This includes the names that a Mac wrote in NFD.
- The revisions are attributed to the signed-in user and to a device named `vault-sync-server import`. The subcommand registers this device for the user for the run, and removes it when the run ends.

The vault must never have had a document. The subcommand refuses any other vault. Hidden files and folders are files like any others. This includes the `.obsidian` folder, where Obsidian keeps its configuration. Before you import, remove from the folder what you do not want in the vault.

### Import into an end-to-end encrypted vault

The subcommand can also import into an end-to-end encrypted vault with your own key. For what the server holds for these vaults, see [Encryption for operators](encryption.md). The subcommand encrypts on the machine that runs it, in the same way as the plugin. The server only receives ciphertext. The subcommand seals paths and contents under the current key epoch of the vault. A key epoch is one generation of the vault key. Nothing readable, no passphrase and no key goes to the server or into the logs.

You unlock your key with your recovery passphrase or with your private key:

```sh
vault-sync-server import -passphrase-file ~/passphrase.txt https://sync.example.com 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 /path/to/notes
vault-sync-server import -private-key-file ~/identity.txt https://sync.example.com 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 /path/to/notes
```

- `-passphrase-file FILE`: a file that holds your recovery passphrase. The whole file is the passphrase, without one trailing line ending.
- `-private-key-file FILE`: a file that holds your private key as an age hybrid identity (`AGE-SECRET-KEY-PQ-1…`). The subcommand ignores blank lines and `#` comments.
- If you give neither flag, the subcommand asks for the passphrase at the terminal and does not echo it. If standard input is not a terminal, the subcommand fails.

The secret itself is never a command-line argument. Each file can be at most 64 KiB.

With the passphrase, the subcommand unlocks your key in the same way as a new device (`GetUserKeyParams`, then `UnlockUserKey`). A wrong passphrase counts against the limit of attempts on the server. With either secret, the subcommand opens your key slots for the first and the current epochs of the vault. It makes sure that each key matches the key commitment of its epoch before it uses the key. If a key rotation replaces the epoch during the import, the subcommand encrypts again under the new epoch and tries again.

Before you import, make sure of these conditions. If one is not true, the subcommand refuses the import and imports nothing:

- You enabled encryption in the plugin.
- The vault already has a key. Open the vault in the plugin on the device of an owner first. If you are an editor, wait until the device of an owner shares the vault key with you.
- The vault is in your anchor list. The anchor list is your encrypted list of the vaults that you trust, with the genesis hash of each. The plugin adds the vault when you create, join or open it.

### Verification against the server

The subcommand does not trust the server for any key. Before it uses an epoch key, it verifies the membership log and the signed epoch records of the vault in the same way as a plugin device. If a check fails, the import stops before it imports anything, with the error "the server sent key or membership data that doesn't verify" and the check that failed. For how the checks work, see [Import](../design/encryption.md#import) and [Protection against an active server](../design/encryption.md#protection-against-an-active-server) in the encryption design.

### Import with the escrow identity

The escrow identity is the private key of the deployment that can open escrowed vaults. For how to make and keep it, see [Encryption for operators](encryption.md). If you hold the escrow identity, you can import into a vault that has escrow. You need no passphrase or key of a member:

```sh
vault-sync-server import -escrow-identity-file /secure/escrow-identity.txt -genesis "$VAULT_FINGERPRINT" https://sync.example.com 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 /path/to/notes
vault-sync-server import -escrow -genesis "$VAULT_FINGERPRINT" https://sync.example.com 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12 /path/to/notes
```

- `-escrow-identity-file FILE`: an age identity file that holds one or more escrow identities (`AGE-SECRET-KEY-PQ-1…`). The subcommand ignores blank lines and `#` comments. It is the same file that the export job reads from `VAULT_SYNC_ESCROW_IDENTITY_FILE` (see [Escrow](configuration-reference.md#escrow)). During a rotation of the escrow key, put both the new and the retiring identity in the file. The file can be at most 64 KiB.
- `-escrow`: you type the escrow identity at the terminal, and the subcommand does not echo it. If standard input is not a terminal, the subcommand fails.
- `-genesis HASH`: required with either flag. This is the genesis hash of the vault. The plugin shows it as the **vault fingerprint** in the settings of the vault. Give it as 64 hexadecimal digits. The subcommand ignores spaces and colons between the digits.

Get the vault fingerprint from a member, not from the server. The escrow import has no anchor list, so it verifies the membership log of the vault from this hash. Without `-genesis`, the subcommand refuses to run. With the hash of another vault, it refuses the import. With your own key, the subcommand refuses `-genesis`, because your anchor list holds the hash.

The identity is never a command-line argument. The subcommand never logs it and never sends it to the server. You still sign in as an owner or an editor of the vault. The identity only unlocks the keys of the vault on your machine.

The subcommand lists the escrow slots of the vault (`ListKeySlots` with the escrow recipient kind, open to editors and owners only). It opens the slots of the first and the current epochs, each with the identity that the slot names. It makes sure that each key matches the key commitment of its epoch before it uses the key. The subcommand refuses a vault without escrow. It also refuses an identity file that does not hold the key that a slot is wrapped to. In both cases it imports nothing. After a rotation, it encrypts and tries again in the same way as with your own key.

Give at most one of `-passphrase-file`, `-private-key-file`, `-escrow-identity-file` and `-escrow`.

### What it skips

The subcommand skips the items below. It lists each one in the report with the reason, and it imports everything else. It checks names with the same rules that the server applies to every new path (see [the engine design](../design/engine.md), §6):

- A name outside the portable set. This is a name with a `< > : " / \ | ? *` or control character, a leading or trailing space, or a trailing `.`. It is also a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without an extension), a name over 255 UTF-8 bytes, a path over 1024 UTF-8 bytes, or a name that is not valid UTF-8. If a folder has such a name, the subcommand skips the folder and everything in it.
- A name that another imported file or folder already uses, if you ignore case and Unicode normalization. For example, `Note.md` next to `note.md`.
- A file that is larger than `VAULT_SYNC_BLOB_MAX_SIZE_BYTES`, or larger than the limit of the server.
- A symbolic link. The subcommand never follows one. It also skips anything that is not a regular file or a folder.

To import the skipped files, rename them, create a new vault, and import again.

### Report and exit status

The subcommand writes its logs to stderr. When it ends, it writes one line of JSON to stdout:

```json
{"status":"partial","vault_id":"0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12","source":"/path/to/notes","imported":{"text":412,"blob":37,"folder":2},"bytes":48213397,"skipped":[{"path":"Inbox/what?.md","reason":"unportable name: a new path may not be created at this path: a new path must not contain any of < > : \" | ? *"}]}
```

| `status` | Exit status | Meaning |
| --- | --- | --- |
| `ok` | 0 | The subcommand imported every file and every empty folder. |
| `partial` | 1 | The import finished. `skipped` lists what the subcommand left out. |
| `failed` | 1 | The import did not start, or it stopped early. `error` tells why. What the subcommand imported before it stopped stays in the vault. Create a new vault and import again. |

A usage error exits with status 2.

## Undelete a vault

When an owner deletes a vault, the server keeps it for 30 days. Then the retention job purges it ([Deleting a vault](../design/sharing.md#deleting-a-vault)). Before the purge, you can restore the vault with the `vault` subcommand of the server binary. It reads only the PostgreSQL variables. For example, run it in a running server pod (here the Deployment of a release named `vault-sync`). The image has no shell, so call the binary directly:

```sh
kubectl exec deploy/vault-sync -- /bin/vault-sync-server vault undelete 0192f2c4-7a1e-7c3d-9f0a-2b4c6d8e0f12
```

The members of the vault can use it again at once, on every replica, with all its documents, history and attachments. You can undelete a vault even if its owner already owns 100 vaults.

The command exits with status 1 in these cases:

- `no vault ID: it does not exist or has been purged`: the vault is not known, or its purge started.
- `vault ID is not deleted`: the vault is not deleted.

On a usage error, it exits with status 2.
