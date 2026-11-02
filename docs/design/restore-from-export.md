# Restore from an export

For: developers and agents. You know `SPEC.md`, the export (`internal/export`, `docs/admin/backup-and-restore.md`) and the Markdown import (`internal/vaultimport`).

Status: approved by the owner on 2026-11-02, with the Phase 6 checklist (`docs/acceptance/phase-6.md`).

## 1. Goal

An admin can recover the current files of a vault after a data loss, from the export that the export job writes. The restore reuses the Markdown import. It adds what the export knows and a folder does not: the manifest, the unplaced files and the integrity of the bytes.

The admin's other recovery paths stay as they are: restoring the PostgreSQL and S3 backups (`docs/admin/backup-and-restore.md`, engine §9), and the devices, which hold full copies of their vaults.

## 2. Command

```
vault-sync-server import -from-export EXPORT_DIR -source-vault VAULT_ID [-allow-partial] SERVER TARGET_VAULT
```

- `EXPORT_DIR` is an export's output directory (it holds the `.vault-sync-export` marker). `VAULT_ID` names the exported vault in it: its directory `VAULT_ID/`, its unplaced tree `VAULT_ID.unplaced/` and its manifest `VAULT_ID.manifest.jsonl`.
- `TARGET_VAULT` is a new, empty vault, with the same rules, sign-in and encryption options as the Markdown import (the vault has never had a document, and the caller is an owner or an editor). An escrowed encrypted vault's export is plaintext, so it is restored into an encrypted vault with the caller's passphrase, as the Markdown import does today.
- Without `-from-export`, the command is the Markdown import, unchanged.

## 3. Verify, then import

The restore reads and checks everything before it creates any document.

1. **Format.** The marker and the manifest's `vault` line have format 2. Any other format is refused.
2. **Complete manifest.** The manifest ends with its `end` line, and its counts match the document lines.
3. **Every document line** is checked against the files:
   - `placed`: the file at `location` exists, and its size and SHA-256 match.
   - `unplaced`: the file at `location` (in the unplaced tree) exists, and its size and SHA-256 match.
   - `missing`: there are no bytes to restore. It is reported, never an error.
4. **No extra files.** A file in the vault's directory or unplaced tree that no document line names is reported. It is not imported, because the export never writes one.

If any check in steps 1 to 3 fails, the restore prints a report of every failure and imports nothing, with exit status 1. With `-allow-partial`, a failed format or manifest check (steps 1 and 2) still stops it, but documents that fail step 3 are left out and listed, and the rest are imported.

The manifest is the list of documents to restore. The directory tree is not walked as a folder of notes, so names and kinds come from the manifest, not from guessing:

- Each document is created with the manifest's `path` and `kind` (`text`, `blob` or `folder`) and the verified bytes.
- An unplaced document is created at its original `path` if the server accepts that path. If the server refuses it (a collision with another document's path, or a name that the server's new-path rules refuse), the document is created at `Restored files/<document-id>` with the original extension, and the report lists both paths. Its bytes are never dropped.
- A document with an empty `path` (its path did not decrypt) is created the same way under `Restored files/`.
- Folders that hold files are created by their files' paths, as the Markdown import does today. `folder` documents with no files are created as `FOLDER` documents.

## 4. Report

The report is the Markdown import's JSON report with three more lists: `fallback` (unplaced documents restored under `Restored files/`, with both paths), `missing` (from the manifest) and `failed_verification` (with the reason, under `-allow-partial`). The exit status is 0 only when every document of the manifest was restored at its own path. Like the export's summary, the logs name documents by id, never by path.

## 5. Devices after a restore

A restored vault is a new vault with new document ids. A device that synced the lost vault disconnects from it and connects its existing folder to the restored vault. That is the plugin's existing connect rule (`SPEC.md` §4, engine §12 X2): every existing file goes through rule W. Identical files bind with no change, files that differ are kept as conflict copies, and files that only the device has are uploaded as new documents. So the devices also bring back any edit newer than the export. No new plugin behavior is needed. Phase 6 adds the e2e test (P6-03) and the runbook (P6-04).

## 6. Tests

- `[P6-01]` and `[P6-02]`: integration tests that run the export job against a vault on the test stack (including an unplaced collision, a `missing` document and an escrowed encrypted vault), run the restore, and compare the restored vault with the manifest. The damaged cases change one byte of a file, delete a file, cut the manifest's end line and change the format.
- `[P6-03]`: an e2e test with two Obsidian vaults: one synced to a vault, then that vault restored into a new one from an export, then the first device connected to the new vault with a newer local edit, an identical file and a local-only file.
