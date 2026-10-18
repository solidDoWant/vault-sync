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

## Output layout

```
DIR/
  .vault-sync-export            marker: {"format":1,"started_at":"…"}
  <vault-id>/                   one directory per exported vault
    <document path>             each live document, byte-for-byte
```

- Each vault's directory is named by its id, not its name, because names are mutable, can collide and are chosen by users. The summary maps ids to names.
- A vault's directory holds every live document, as of the vault's `head_seq` when its export started, at the document's path. File contents are the documents' head revisions, byte for byte. Deleted (tombstoned) documents are left out, and so is history. Documents committed while a vault is being exported belong to the next run.
- Only `/` separates directories. A `\` in a document path is written as part of the file name.
- Directories are created with mode `0750` and files with `0640`, less the process umask. Plaintext notes are never readable by others.
- End-to-end encrypted vaults are skipped (they are listed in the summary with `"skipped": "e2ee"`). Exporting them requires escrow (SPEC.md §9.4, Phase 4).

### Atomic replacement

The export writes the new tree to a staging directory beside `DIR` (`.<name>.staging-<random>` in `DIR`'s parent). Once the whole tree is written and flushed to disk (`syncfs`), it atomically exchanges the staging directory with `DIR` (`renameat2` with `RENAME_EXCHANGE`) and then removes the previous tree. At every instant `DIR` holds one complete export: a run that fails, is killed or loses power part-way leaves the previous export untouched. On the first run `DIR` is created by a plain rename.

This requires that:

- the platform is Linux (other platforms refuse to run the export);
- `DIR`'s parent exists, is writable, and is on the same filesystem as `DIR`. `DIR` itself must not be a mount point: mount the volume at the parent, for example mount a volume at `/backup` and use `-out /backup/vault-sync`;
- `DIR` is not a symbolic link;
- `DIR`, if it exists and is not empty, holds a previous export (its `.vault-sync-export` marker). The export refuses to replace any other directory, so a mistyped `-out` cannot destroy unrelated data;
- the volume has room for two full exports while a run is in progress.

A lock file (`.<name>.lock` in the parent) makes a second concurrent run against the same `DIR` fail at once. A run removes staging directories left by interrupted runs before it starts.

Archival tooling should read `DIR` while no export runs, or tolerate the tree being swapped between two reads.

### Path safety

Document paths come from the database and are treated as untrusted. Before anything is written, every path is checked against the vault-relative rule shared with the server and clients (SPEC.md §6.2, `testdata/paths/validity.json`): no leading separator, no drive letter or UNC prefix, and no empty, `.` or `..` segment (with `\` also counted as a separator). Files are then created through a handle confined to the vault's directory (`os.Root`), every directory on the way is checked without following symbolic links, and files are created exclusively (`O_EXCL`), so the export never writes through a symbolic link or overwrites a file.

A document that cannot be written faithfully is left out and reported, and the export continues. Its file is never left half-written. This covers:

- a path that is not vault-relative;
- a path that conflicts with another document's file or directory (for example a document `a` and a document `a/b.md`; the document with the lower id wins);
- a path the filesystem cannot represent (for example a name longer than 255 bytes);
- stored content that is missing, or whose length or SHA-256 does not match its blob id.

## Summary and exit status

On completion, or on any failure after the flags are parsed, the export writes one JSON line to stdout. Logs go to stderr as JSON. Neither ever contains document paths or contents: document errors are reported by document id.

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
  "vault_details": [
    {"id": "0192…", "name": "Notes", "encryption": "none", "head_seq": 9123, "files": 1530, "bytes": 48213000,
     "document_errors": [{"document_id": "0192…", "reason": "path conflicts with another document's file or directory"}]},
    {"id": "0193…", "name": "Work", "encryption": "none", "head_seq": 12, "files": 2, "bytes": 344},
    {"id": "0194…", "name": "Private", "encryption": "e2ee", "head_seq": 40, "skipped": "e2ee", "files": 0, "bytes": 0}
  ]
}
```

| Field | Meaning |
|---|---|
| `status` | `ok`: every live document of every exported vault was written and the new export is in place. `partial`: the new export is in place, but `document_errors` documents were left out. `failed`: the run stopped (see `error`). The previous export, if any, is untouched. |
| `error` | Why a `failed` run stopped. Present only then. |
| `output` | The absolute export directory. |
| `started_at`, `duration_seconds` | When the run started (UTC) and how long it took. |
| `vaults`, `skipped_vaults` | Vaults exported, and vaults skipped (end-to-end encrypted). |
| `files`, `bytes` | Files written and their total size. |
| `document_errors` | Documents left out. At most 100 are listed, under their vault, with a reason. All of them are counted. |
| `vault_details` | Per vault: `id`, `name`, `encryption`, the `head_seq` exported, `files`, `bytes`, `skipped` if not exported, and listed `document_errors`. On a `failed` run it covers only the vaults reached. |

The exit status is `0` only for `ok`. It is `1` for `partial` or `failed`, and `2` for invalid flags. Alert on a non-zero exit (for example a failed Kubernetes Job), and use the summary to tell a `partial` export (in place, with gaps) from a `failed` one (not in place). The job has no metrics endpoint.

## Signals

`SIGTERM` or `SIGINT` stops the export at the next document. The staging directory is removed, the summary reports `failed`, and the previous export stays in place.
