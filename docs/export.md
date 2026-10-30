# Plaintext export

`vault-sync-server export` writes a plaintext copy of every vault to a directory tree, which the operator's tape-archival tooling then picks up (SPEC.md §3, §4). It is a one-shot job: it runs, writes a JSON summary to stdout, and exits. Run it on a schedule, for example as a Kubernetes CronJob, with its own credentials.

```sh
vault-sync-server export -out /backup/vault-sync
```

Running it is recommended: the export is the plaintext disaster-recovery copy of every vault, readable with any editor and without vault-sync, PostgreSQL or S3, so it is what you restore from if the database or the bucket is lost. The Helm chart runs it as a CronJob, but only once you turn it on: set `config.export.enabled: true` and give it an output volume in `config.export.output.persistence` ([deployment.md](deployment.md#the-export-job) lists every value).

## Flags

| Flag | Description |
|---|---|
| `-out DIR` | Required. The export directory. Every run replaces its whole content with a fresh export. |

Invalid flags exit with status 2 and print no summary.

## Environment variables

The export reads the server's database and object-store variables (see [configuration.md](configuration.md)) and ignores all others (listener, OIDC, limits):

| Variable | Description |
|---|---|
| `VAULT_SYNC_DATABASE_URL` | Required. As for the server. |
| `VAULT_SYNC_DATABASE_TLS_CERT_FILE`, `VAULT_SYNC_DATABASE_TLS_KEY_FILE`, `VAULT_SYNC_DATABASE_TLS_CA_FILE` | As for the server. |
| `VAULT_SYNC_S3_BUCKET`, `VAULT_SYNC_S3_ACCESS_KEY_ID_FILE`, `VAULT_SYNC_S3_SECRET_ACCESS_KEY_FILE` | Required: the export reads blob contents from S3. |
| `VAULT_SYNC_S3_ENDPOINT`, `VAULT_SYNC_S3_REGION`, `VAULT_SYNC_S3_FORCE_PATH_STYLE`, `VAULT_SYNC_S3_TLS_CA_FILE`, `VAULT_SYNC_S3_IDLE_TIMEOUT` | As for the server. The idle timeout fails the export if the store stops answering; a long but progressing download of a large blob is not cut short. |
| `VAULT_SYNC_LOG_LEVEL` | Minimum log level (`info` by default). |

The export only reads, except for one row of status. Every database session it opens sets `default_transaction_read_only`, so PostgreSQL refuses any write even if the role could make one. The single exception is the end of each run: in one explicit read-write transaction it updates the single row of `export_status` with the time the run finished, its status (`ok`, `partial` or `failed`) and, for `ok`, the time of the last successful export, which every server replica reports as `vault_sync_service_export_last_success_timestamp_seconds` ([configuration.md](configuration.md#service-wide-metrics)). A failure to record it is logged as a warning and does not change the run's status or exit code. It never runs migrations: run it against a database the server has already migrated. It reads objects from S3 and never writes or deletes any. A database role with `SELECT` on `vaults`, `documents`, `revisions` and `blobs`, `INSERT` and `UPDATE` on `export_status` and no other privilege, and S3 credentials with `s3:GetObject` and `s3:ListBucket` (for `HeadBucket`) on the bucket, are enough:

```sql
GRANT SELECT ON vaults, documents, revisions, blobs TO vault_sync_export;
GRANT INSERT, UPDATE ON export_status TO vault_sync_export;
```

## What an export contains

An export is a copy of your vaults' current files, meant to be archived. Restoring from it is not supported yet (planned for Phase 6), but the export is designed so a future restore can be exact.

**In the export:**

- Every file that exists (is not deleted) in a plaintext vault when that vault's export starts, byte for byte, as last synced to the server. This includes notes, attachments, and any other file clients sync.
- Files that a filesystem cannot hold at their path, for example a file `a` next to a folder `a` that contains `a/b.md`, or a name longer than 255 bytes. These are kept in a separate folder next to the vault's folder, named by document id, and the manifest records their original path (see [Documents that cannot be placed at their path](#documents-that-cannot-be-placed-at-their-path)). A file is never left out because of its name.
- Vaults an owner deleted, until the server purges them 30 days later, so backups still hold a vault while it can be undeleted. A deleted vault is exported like any other, with a `<vault-id>.DELETED` file next to its folder that holds the deletion time. A purged vault is no longer exported.
- A manifest per vault that lists every file with its path, kind, revision, size and SHA-256, and says where in the export its bytes are.

**Not in the export:**

- **History.** Only each file's latest version is exported. The server keeps earlier versions (SPEC.md §11), but the export does not.
- **Deleted files.** The server keeps them as tombstones, but the export does not.
- **End-to-end encrypted vaults without escrow.** Nobody but their members can decrypt them, so they are skipped and listed in the summary as skipped (`no_escrow`). Escrowed vaults are decrypted and exported like plaintext vaults (see [End-to-end encrypted vaults](#end-to-end-encrypted-vaults)); without an escrow identity (`VAULT_SYNC_ESCROW_IDENTITY_FILE`) they are skipped too (`no_escrow_identity`).
- **Anything not synced to the server.** This covers edits still waiting on a device to be uploaded, and anything clients do not sync (for example Obsidian's `.obsidian/` settings, which clients do not sync yet).
- **Who has access.** Vault members, roles, users and devices are not exported.
- **Files whose stored content is missing or corrupt in the object store,** or, in an escrowed vault, cannot be decrypted. These are the only files whose bytes can be absent. They are still listed in the manifest (as `missing`) and in the summary, and the run reports `partial` with exit status 1.
- **Changes committed while a vault is being exported.** These belong to the next run.

## Output layout

```
DIR/
  .vault-sync-export                    marker: {"format":2,"started_at":"…"}
  <vault-id>/                           the vault's tree: each document at its path
  <vault-id>.unplaced/<document-id>     documents that cannot be placed at their path (only if there are any)
  <vault-id>.manifest.jsonl             the vault's manifest
  <vault-id>.DELETED                    only for a vault an owner deleted: its deletion time (RFC 3339)
```

- Each vault's directory is named by its id, not its name, because names are mutable, can collide and are chosen by users. The summary and the manifest map ids to names.
- A vault's directory holds its live documents, as of the vault's `head_seq` when its export started, each at its path. File contents are the documents' head revisions, byte for byte.
- The unplaced tree and the manifest sit next to the vault's directory, never inside it. No document path can be mistaken for them: a user file named `<vault-id>.manifest.jsonl` or `.vault-sync-export` is exported unchanged inside the vault's directory. Vault ids are UUIDs, so the suffixes cannot collide with another vault's directory.
- Every directory inside a vault's directory or unplaced tree holds at least one exported file: a document that ends up unplaced or `missing` leaves no empty directory behind. The vault's directory itself exists even when it holds no file.
- Only `/` separates directories. A `\` in a document path is written as part of the file name.
- Directories are created with mode `0750` and files (manifests included) with `0640`, less the process umask. Plaintext notes and paths are never readable by others.
- Skipped and failed end-to-end encrypted vaults get no directory and no manifest (they are listed in the summary with `skipped` or `failed`).

### End-to-end encrypted vaults

With `VAULT_SYNC_ESCROW_IDENTITY_FILE` set to the escrow identity (`docs/encryption.md`, *Escrow*), the export decrypts every escrowed vault and writes its plaintext tree and manifest exactly like a plaintext vault's: plaintext paths and contents, and in the manifest the plaintext path, size and SHA-256. The manifest's `encryption` is `e2ee`.

- **Keys first.** Before writing anything for a vault, the export opens the escrow slot of every epoch it has one for, with every configured identity (more than one during an escrow key rotation), and checks each key against its epoch's key commitment. A slot that does not open with the identity it names, or whose key fails its commitment, marks the vault `failed` in the summary with the reason. Nothing of it is exported, so nothing is ever written with a wrong key, and the run is `partial`. The other vaults are exported.
- **Each document** is decrypted with the key of its head revision's epoch: its path, its content, and its content is checked against its blob id. Revisions from before an in-place conversion (epoch 0) are plaintext and exported as they are.
- **A document that cannot be decrypted** is still listed. Content that does not decrypt or does not match its blob id, or a revision whose epoch has no escrow slot (escrow was turned off for the vault later), makes the document `missing`, with its stored (encrypted) `size` and an empty `sha256`, and counts in `document_errors`. A path that does not decrypt, with content that does, puts the document in the unplaced tree with an empty `path`.

### Documents that cannot be placed at their path

A document goes to `<vault-id>.unplaced/<document-id>`, a file named by its document id that holds its bytes, when its path cannot be created in the vault's directory:

- the path conflicts with another document's file or directory. For example, with live documents `a` and `a/b.md`, the document with the lower id is placed and the other goes to the unplaced tree. Data the server already holds can contain such collisions;
- the filesystem cannot represent the path, for example a name longer than 255 bytes;
- the path is not vault-relative (see [Path safety](#path-safety)), or is not valid UTF-8;
- a symbolic link has been planted in the export's tree while it runs.

Such a document is still exported, so the run stays `ok`. The summary counts these documents (`unplaced`), and the manifest records each one's original path and the reason it was not placed. If the unplaced file itself cannot be written, the run fails and the previous export stays in place. A readable document is never dropped.

### Manifest

`<vault-id>.manifest.jsonl` lists every live document of the vault and where its bytes are, so an export can be checked and, in a later phase, restored exactly. It is written while the vault is exported, one document at a time, so its size never limits the vault's size.

The format is versioned: this page describes **format 2**, the number in every manifest's first line and in the marker. A change that a reader must know about increases the format. Readers should reject a format they do not know and ignore fields they do not know.

The file is UTF-8 [JSON Lines](https://jsonlines.org/): one JSON object per line, each ended by `\n`. Every object has a `type`:

1. The first line has `"type": "vault"`:

   | Field | Meaning |
   |---|---|
   | `format` | `2`. |
   | `vault_id`, `name`, `encryption` | The vault's id, name at export time, and encryption (`none`, or `e2ee` for a decrypted escrowed vault). |
   | `head_seq` | The point in the vault's history that was exported. |
   | `started_at` | When the run started (RFC 3339, UTC). |

2. Then one line with `"type": "document"` for each live document, in ascending `document_id` order:

   | Field | Meaning |
   |---|---|
   | `document_id` | The document's id (stable across renames). |
   | `path` | The document's vault-relative path, exactly as stored. If the path is not valid UTF-8, which JSON cannot carry exactly, `path` holds an approximation and `path_base64` holds the exact bytes (standard base64). |
   | `kind` | `blob`, `text` or `yjs`. |
   | `revision_id` | The head revision that was exported. |
   | `size`, `sha256` | The head revision content's size in bytes and its SHA-256 (lowercase hex), as stored by the server. They are present even when the bytes are missing. |
   | `status` | `placed`: the bytes are at `<vault-id>/<path>`. `unplaced`: the bytes are at `<vault-id>.unplaced/<document-id>`. `missing`: the content is missing or corrupt in the object store, so the bytes are not in the export. |
   | `location` | The file holding the bytes, relative to `DIR`, with `/` separators. Absent when `status` is `missing`. |
   | `reason` | Why the document is `unplaced` or `missing`. Absent when it is `placed`. |

3. The last line has `"type": "end"`, plus `documents`, `placed`, `unplaced` and `missing` counts. A manifest without this line, or whose counts do not match its document lines, is incomplete (for example a truncated copy).

```json
{"type":"vault","format":2,"vault_id":"0192…","name":"Notes","encryption":"none","head_seq":9123,"started_at":"2026-10-18T03:00:00Z"}
{"type":"document","document_id":"0192…a1","path":"daily/2026-10-18.md","kind":"text","revision_id":"0192…","size":512,"sha256":"9f86…","status":"placed","location":"0192…/daily/2026-10-18.md"}
{"type":"document","document_id":"0192…b2","path":"a/b.md","kind":"text","revision_id":"0192…","size":20,"sha256":"2c26…","status":"unplaced","location":"0192….unplaced/0192…b2","reason":"path conflicts with another document's file or directory"}
{"type":"document","document_id":"0192…c3","path":"lost.png","kind":"blob","revision_id":"0192…","size":4096,"sha256":"e3b0…","status":"missing","reason":"stored content is missing"}
{"type":"end","documents":3,"placed":1,"unplaced":1,"missing":1}
```

**Verifying an export.** An export is intact when, for every manifest, the file at each document's `location` has exactly `size` bytes whose SHA-256 is `sha256`, and every file under `<vault-id>/` and `<vault-id>.unplaced/` is the `location` of exactly one document line. A quick check of the hashes with `jq` and GNU coreutils (it does not handle paths that contain a newline or a backslash):

```sh
cd /backup/vault-sync
jq -r 'select(.type == "document" and .location) | "\(.sha256)  \(.location)"' ./*.manifest.jsonl | sha256sum --check --quiet
```

### Atomic replacement

The export writes the new tree to a staging directory beside `DIR` (`.<name>.staging-<number>` in `DIR`'s parent). Once the whole tree is written and flushed to disk (`syncfs`), it atomically exchanges the staging directory with `DIR` (`renameat2` with `RENAME_EXCHANGE`) and then removes the previous tree and flushes the rename to disk. If only that last flush fails, the new export is already in place: the run reports `ok` or `partial` as usual and logs a warning that the swap may not survive a power loss. At every instant `DIR` holds one complete export: a run that fails, is killed or loses power part-way leaves the previous export untouched. On the first run `DIR` is created by a plain rename.

This requires that:

- the platform is Linux (other platforms refuse to run the export);
- `DIR`'s parent exists, is writable, and is on the same filesystem as `DIR`. `DIR` itself must not be a mount point: mount the volume at the parent, for example mount a volume at `/backup` and use `-out /backup/vault-sync`;
- `DIR` is not a symbolic link;
- `DIR`, if it exists and is not empty, holds a previous export (its `.vault-sync-export` marker). The export refuses to replace any other directory, so a mistyped `-out` cannot destroy unrelated data;
- the volume has room for two full exports while a run is in progress.

A lock file (`.<name>.lock` in the parent) makes a second concurrent run against the same `DIR` fail at once. If `.<name>.lock` is a symbolic link, the run fails rather than follow it; remove the link. The run also fails, leaving the entry untouched, if `.<name>.lock` is anything but a regular file with a single hard link owned by the user running the export (for example a hard link to another file, a FIFO or a directory); remove it. A run removes staging directories left by interrupted runs before it starts: only entries named exactly `.<name>.staging-` followed by digits, so the lock file and staging directories of an export to a sibling directory (for example `-out /backup/out.staging-1`) are left alone. This holds for any `<name>`, including one that contains `*`. If the staging name a run picks is already taken (by a directory, file or symbolic link created after that cleanup), the run leaves that entry alone and picks another, failing after 100 taken names.

Archival tooling should read `DIR` while no export runs, or tolerate the tree being swapped between two reads.

### Path safety

Document paths come from the database and are treated as untrusted. Before anything is written, every path is checked against the vault-relative rule shared with the server and clients (SPEC.md §6.2, `testdata/paths/validity.json`): no leading separator, no drive letter or UNC prefix, and no empty, `.` or `..` segment (with `\` also counted as a separator). A path that fails the check is never used as a file name: the document goes to the unplaced tree. Files are created through a handle confined to the vault's directory (`os.Root`), every directory on the way is checked without following symbolic links, and files are created exclusively (`O_EXCL`), so the export never writes through a symbolic link or overwrites a file.

A document whose stored content is missing, or whose length or SHA-256 does not match its blob id, has no file in the export (no half-written file is left behind). It is listed in the manifest as `missing` and in the summary's `document_errors`, and the export continues.

## Summary and exit status

On completion, or on any failure after the flags are parsed, the export writes one JSON line to stdout. Logs go to stderr as JSON. Neither ever contains document paths or contents: documents are reported by id. Paths appear only in the manifests, inside the export.

```json
{
  "status": "partial",
  "output": "/backup/vault-sync",
  "started_at": "2026-10-18T03:00:00Z",
  "duration_seconds": 12.5,
  "vaults": 2,
  "skipped_vaults": 1,
  "failed_vaults": 0,
  "files": 1532,
  "bytes": 48213344,
  "document_errors": 1,
  "unplaced": 1,
  "vault_details": [
    {"id": "0192…", "name": "Notes", "encryption": "none", "head_seq": 9123, "files": 1530, "bytes": 48213000, "unplaced": 1,
     "document_errors": [{"document_id": "0192…", "reason": "stored content is missing"}]},
    {"id": "0193…", "name": "Work", "encryption": "none", "head_seq": 12, "files": 2, "bytes": 344, "unplaced": 0},
    {"id": "0194…", "name": "Private", "encryption": "e2ee", "head_seq": 40, "skipped": "no_escrow", "files": 0, "bytes": 0, "unplaced": 0}
  ]
}
```

| Field | Meaning |
|---|---|
| `status` | `ok`: the bytes of every live document of every exported vault are in the new export (at their path or in the unplaced tree), and it is in place. `partial`: the new export is in place, but the content of `document_errors` documents is missing, corrupt or cannot be decrypted, so their bytes are not in it, or `failed_vaults` encrypted vaults are not in it. `failed`: the run stopped (see `error`), and the previous export, if any, is untouched. |
| `error` | Why a `failed` run stopped. Present only then. |
| `output` | The absolute export directory. |
| `started_at`, `duration_seconds` | When the run started (UTC) and how long it took. |
| `vaults`, `skipped_vaults`, `failed_vaults` | Vaults exported; end-to-end encrypted vaults skipped because they cannot be decrypted (`skipped` is `no_escrow` for a vault without escrow, `no_escrow_identity` when the export has no escrow identity); and escrowed vaults left out because an escrow slot does not open or fails its key commitment (`failed` gives the reason). |
| `files`, `bytes` | Document files written (in vault trees and unplaced trees) and their total size. |
| `document_errors` | Documents whose content is missing or corrupt. At most 100 are listed, under their vault, with a reason. All of them are counted, and all of them are in the manifests. |
| `unplaced` | Documents written to an unplaced tree because their path cannot be placed in the vault's tree. They are exported, so they do not make the run `partial`, but a vault that has any is worth a look. |
| `vault_details` | Per vault: `id`, `name`, `encryption`, the `head_seq` exported, `files`, `bytes`, `unplaced`, `skipped` or `failed` if not exported, and listed `document_errors`. On a `failed` run it covers only the vaults reached. |

When the run does not fail, its last log line (`"msg": "export finished"`) repeats the summary's `status`, `vaults`, `skipped_vaults`, `failed_vaults`, `files`, `bytes`, `unplaced` and `document_errors` counts, for operators who alert on logs.

The exit status is `0` only for `ok`. It is `1` for `partial` or `failed`, and `2` for invalid flags. Alert on a non-zero exit (for example a failed Kubernetes Job), and use the summary to tell a `partial` export (in place, with gaps) from a `failed` one (not in place). The job has no metrics endpoint.

## Rotating the escrow key

`vault-sync-server export rotate-escrow` moves every escrow slot to a new escrow key (`docs/design/encryption.md`, *Escrow*). The operator runs it on purpose and names the new escrow bundle: its age recipient and its Ed25519 signing public key.

```sh
vault-sync-server export rotate-escrow -server https://sync.example.com \
  -recipient age1pq1… -signing-public-key BASE64
```

| Flag | Description |
|---|---|
| `-server URL` | Required. The server's URL. The rotation writes only through its job-only `EscrowJobService`. |
| `-recipient` | Required. The new escrow key's age recipient (`age1pq1…`, from `age-keygen -y`). |
| `-signing-public-key` | Required. The new escrow signing public key: standard base64 of the 32-byte Ed25519 public key. |

It reads `VAULT_SYNC_DATABASE_URL` and the database TLS variables (read-only, like the export), `VAULT_SYNC_LOG_LEVEL`, and three files, all required:

| Variable | Description |
|---|---|
| `VAULT_SYNC_ESCROW_IDENTITY_FILE` | The escrow identities: the new one and every old one whose slots are still to be moved. |
| `VAULT_SYNC_ESCROW_SIGNING_KEY_FILE` | The escrow signing keys, one standard base64 Ed25519 seed (32 bytes) per line, blank lines and `#` comments ignored. Keys are matched to bundles by their public keys, not by line order. It must hold the new bundle's key and the key of the escrow chain's current head. |
| `VAULT_SYNC_ESCROW_JOB_TOKEN_FILE` | The job token the server checks on `EscrowJobService` (see [configuration.md](configuration.md)). |

A run does this:

1. It refuses to start unless the identity file holds the new identity and the signing key file holds the new signing key and the chain head's. It reads the escrow chain from PostgreSQL and verifies it.
2. If the chain's head is not the new bundle yet, it appends the escrow rotation statement to it, signed by the head's signing key. A repeat run finds the new bundle at the head and appends nothing.
3. For every vault, including deleted vaults that are not purged yet (deleted within the last 30 days), it opens every escrow slot not on the new key with its identity and checks the key against its epoch's key commitment. It then wraps the key to the new escrow key and replaces the slot, only if the old slot is still there. A slot that does not open, has no identity in the file or fails its commitment is reported and left in place.
4. It counts the escrow slots still not on the new key, which catches a slot a device wrapped to the old key while the run went.

It prints one JSON line and exits `0` only when no slot failed and no slot is left on an old key. Otherwise it exits `1`, and `2` for invalid flags. Logs and the summary never hold keys or note content.

```json
{"status": "ok", "target_key_id": "sha256:…", "appended_statement": true, "vaults": 12,
 "rewrapped": 340, "old_key_slots": 0, "failed_slots": 0, "failures": []}
```

`failures` lists up to 100 of the `failed_slots`, each with `vault_id`, `epoch`, `recipient_id` and `reason`.

**The operator's order of steps:**

1. Generate the new escrow key and a new escrow signing key, and add the new identity to the identity file and the new seed to the signing key file, keeping the old ones:

   ```sh
   age-keygen -pq -o new-escrow.key && age-keygen -y new-escrow.key              # -recipient
   openssl genpkey -algorithm ed25519 -out new-signing.pem
   openssl pkey -in new-signing.pem -outform DER | tail -c 32 | base64           # the seed, for the signing key file
   openssl pkey -in new-signing.pem -pubout -outform DER | tail -c 32 | base64   # -signing-public-key
   ```

2. Run `export rotate-escrow` with the new bundle. It appends the rotation statement and re-wraps the existing slots.
3. Update the server: `VAULT_SYNC_ESCROW_RECIPIENT` and `VAULT_SYNC_ESCROW_SIGNING_KEY` to the new bundle (the server refuses to start with a bundle that is not the chain's head), and the old key's id in `VAULT_SYNC_ESCROW_RETIRING_KEY_IDS`, so that slots that devices still wrap to the old key during the switch are accepted.
4. Re-run `export rotate-escrow` until it reports `"old_key_slots": 0` and exits `0`. Look into any slot listed in `failures`: it stays on the old key.
5. Unset `VAULT_SYNC_ESCROW_RETIRING_KEY_IDS`, then remove the old identity and the old seed from the files and destroy them, offline copies included. An escrow slot now opens with the new identity and `age --decrypt` ([encryption.md](encryption.md#recovery-with-age)).

## Signals

`SIGTERM` or `SIGINT` stops the export at the next document. The staging directory is removed, the summary reports `failed`, and the previous export stays in place.
