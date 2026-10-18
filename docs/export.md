# Plaintext export

`vault-sync-server export` writes a plaintext copy of every vault to a directory tree, which the operator's tape-archival tooling then picks up (SPEC.md §3, §4). It is a one-shot job: it runs, writes a JSON summary to stdout, and exits. Run it on a schedule, for example as a Kubernetes CronJob, with its own credentials.

```sh
vault-sync-server export -out /backup/vault-sync
```

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

The export only reads. Every database session it opens sets `default_transaction_read_only`, so PostgreSQL refuses any write even if the role could make one. It never runs migrations: run it against a database the server has already migrated. It reads objects from S3 and never writes or deletes any. A database role with `SELECT` on `vaults`, `documents`, `revisions` and `blobs`, and S3 credentials with `s3:GetObject` and `s3:ListBucket` (for `HeadBucket`) on the bucket, are enough.

## What an export contains

An export is a copy of your vaults' current files, meant to be archived. Restoring from it is not supported yet (planned for Phase 6), but the export is designed so a future restore can be exact.

**In the export:**

- Every file that exists (is not deleted) in a plaintext vault when that vault's export starts, byte for byte, as last synced to the server. This includes notes, attachments, and any other file clients sync.
- Files that a filesystem cannot hold at their path, for example a file `a` next to a folder `a` that contains `a/b.md`, or a name longer than 255 bytes. These are kept in a separate folder next to the vault's folder, named by document id, and the manifest records their original path (see [Documents that cannot be placed at their path](#documents-that-cannot-be-placed-at-their-path)). A file is never left out because of its name.
- A manifest per vault that lists every file with its path, kind, revision, size and SHA-256, and says where in the export its bytes are.

**Not in the export:**

- **History.** Only each file's latest version is exported. The server keeps earlier versions (SPEC.md §11), but the export does not.
- **Deleted files.** The server keeps them as tombstones, but the export does not.
- **End-to-end encrypted vaults.** These are skipped until escrow arrives in Phase 4 (SPEC.md §9.4). The summary lists them as skipped.
- **Anything not synced to the server.** This covers edits still waiting on a device to be uploaded, and anything clients do not sync (for example Obsidian's `.obsidian/` settings, which clients do not sync yet).
- **Who has access.** Vault members, roles, users and devices are not exported.
- **Files whose stored content is missing or corrupt in the object store.** These are the only files whose bytes can be absent. They are still listed in the manifest (as `missing`) and in the summary, and the run reports `partial` with exit status 1.
- **Changes committed while a vault is being exported.** These belong to the next run.

## Output layout

```
DIR/
  .vault-sync-export                    marker: {"format":2,"started_at":"…"}
  <vault-id>/                           the vault's tree: each document at its path
  <vault-id>.unplaced/<document-id>     documents that cannot be placed at their path (only if there are any)
  <vault-id>.manifest.jsonl             the vault's manifest
```

- Each vault's directory is named by its id, not its name, because names are mutable, can collide and are chosen by users. The summary and the manifest map ids to names.
- A vault's directory holds its live documents, as of the vault's `head_seq` when its export started, each at its path. File contents are the documents' head revisions, byte for byte.
- The unplaced tree and the manifest sit next to the vault's directory, never inside it. No document path can be mistaken for them: a user file named `<vault-id>.manifest.jsonl` or `.vault-sync-export` is exported unchanged inside the vault's directory. Vault ids are UUIDs, so the suffixes cannot collide with another vault's directory.
- Every directory inside a vault's directory or unplaced tree holds at least one exported file: a document that ends up unplaced or `missing` leaves no empty directory behind. The vault's directory itself exists even when it holds no file.
- Only `/` separates directories. A `\` in a document path is written as part of the file name.
- Directories are created with mode `0750` and files (manifests included) with `0640`, less the process umask. Plaintext notes and paths are never readable by others.
- End-to-end encrypted vaults get no directory and no manifest (they are listed in the summary with `"skipped": "e2ee"`).

### Documents that cannot be placed at their path

A document goes to `<vault-id>.unplaced/<document-id>`, a file named by its document id that holds its bytes, when its path cannot be created in the vault's directory:

- the path conflicts with another document's file or directory. For example, with live documents `a` and `a/b.md`, the document with the lower id is placed and the other goes to the unplaced tree. data the server already holds can contain such collisions;
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
   | `vault_id`, `name`, `encryption` | The vault's id, name at export time, and encryption (`none`). |
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

A lock file (`.<name>.lock` in the parent) makes a second concurrent run against the same `DIR` fail at once. A run removes staging directories left by interrupted runs before it starts: only entries named exactly `.<name>.staging-` followed by digits, so the lock file and staging directories of an export to a sibling directory (for example `-out /backup/out.staging-1`) are left alone.

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
  "files": 1532,
  "bytes": 48213344,
  "document_errors": 1,
  "unplaced": 1,
  "vault_details": [
    {"id": "0192…", "name": "Notes", "encryption": "none", "head_seq": 9123, "files": 1530, "bytes": 48213000, "unplaced": 1,
     "document_errors": [{"document_id": "0192…", "reason": "stored content is missing"}]},
    {"id": "0193…", "name": "Work", "encryption": "none", "head_seq": 12, "files": 2, "bytes": 344, "unplaced": 0},
    {"id": "0194…", "name": "Private", "encryption": "e2ee", "head_seq": 40, "skipped": "e2ee", "files": 0, "bytes": 0, "unplaced": 0}
  ]
}
```

| Field | Meaning |
|---|---|
| `status` | `ok`: the bytes of every live document of every exported vault are in the new export (at their path or in the unplaced tree), and it is in place. `partial`: the new export is in place, but the content of `document_errors` documents is missing or corrupt in the object store, so their bytes are not in it. `failed`: the run stopped (see `error`), and the previous export, if any, is untouched. |
| `error` | Why a `failed` run stopped. Present only then. |
| `output` | The absolute export directory. |
| `started_at`, `duration_seconds` | When the run started (UTC) and how long it took. |
| `vaults`, `skipped_vaults` | Vaults exported, and vaults skipped (end-to-end encrypted). |
| `files`, `bytes` | Document files written (in vault trees and unplaced trees) and their total size. |
| `document_errors` | Documents whose content is missing or corrupt. At most 100 are listed, under their vault, with a reason. All of them are counted, and all of them are in the manifests. |
| `unplaced` | Documents written to an unplaced tree because their path cannot be placed in the vault's tree. They are exported, so they do not make the run `partial`, but a vault that has any is worth a look. |
| `vault_details` | Per vault: `id`, `name`, `encryption`, the `head_seq` exported, `files`, `bytes`, `unplaced`, `skipped` if not exported, and listed `document_errors`. On a `failed` run it covers only the vaults reached. |

The exit status is `0` only for `ok`. It is `1` for `partial` or `failed`, and `2` for invalid flags. Alert on a non-zero exit (for example a failed Kubernetes Job), and use the summary to tell a `partial` export (in place, with gaps) from a `failed` one (not in place). The job has no metrics endpoint.

## Signals

`SIGTERM` or `SIGINT` stops the export at the next document. The staging directory is removed, the summary reports `failed`, and the previous export stays in place.
