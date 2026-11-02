# Restore from an export

For: developers and agents. You know `SPEC.md`, the export (`internal/export`, `docs/admin/backup-and-restore.md`) and the Markdown import (`internal/vaultimport`).

Status: approved by the owner on 2026-11-02, with the Phase 6 checklist (`docs/acceptance/phase-6.md`). Revised after the Phase 6 design review.

## 1. Goal

An admin can recover the current files of a vault after a data loss, from the export that the export job writes. The restore reuses the Markdown import. It adds what the export knows and a folder does not: the manifest, the unplaced files and the integrity of the bytes.

The admin's other recovery paths stay as they are: restoring the PostgreSQL and S3 backups (`docs/admin/backup-and-restore.md`, engine §9), and the devices, which hold full copies of their vaults.

## 2. Command

```
vault-sync-server import -from-export EXPORT_DIR -source-vault VAULT_ID [-allow-partial] SERVER TARGET_VAULT
```

- `EXPORT_DIR` is an export's output directory (it holds the `.vault-sync-export` marker). `VAULT_ID` names the exported vault in it: its directory `VAULT_ID/`, its unplaced tree `VAULT_ID.unplaced/` and its manifest `VAULT_ID.manifest.jsonl`.
- `TARGET_VAULT` is a new, empty vault, with the same rules, sign-in and encryption options as the Markdown import (the vault has never had a document, and the caller is an owner or an editor). An escrowed encrypted vault's export is plaintext, so it is restored into an encrypted vault with the caller's passphrase, as the Markdown import does today.
- If the manifest's `vault` line says `"encryption":"e2ee"` and the target vault is plaintext, the restore refuses before it reads any file, so a formerly encrypted vault is never uploaded in plaintext.
- `-from-export` takes two positional arguments. Three is a usage error (exit 2).
- Without `-from-export`, the command is the Markdown import, unchanged.

## 3. Verify

The restore reads and checks everything before it creates any document. It opens the vault's directory and unplaced tree once each with `os.OpenRoot`, and reads only regular files through them. It never follows a symbolic link.

1. **Format.** The marker and the manifest's `vault` line have format 2. Any other format is refused.
2. **Manifest shape.** These failures are format failures, which stop the restore even with `-allow-partial`:
   - The `vault` line is first, and its `vault_id` equals `-source-vault`. The `end` line is last, nothing follows it, and its counts match the document lines.
   - Every `document_id` is unique. `kind` is `text` or `blob` (the export writes no other kind for a plaintext or escrowed vault). `status` is `placed`, `unplaced` or `missing`.
   - `location` is present exactly when the status is not `missing`, and it is bound to the document: `VAULT_ID/` + `path` for `placed`, and `VAULT_ID.unplaced/` + `document_id` for `unplaced`. Any other value is refused, so a damaged line cannot point at another vault's file.
   - `sha256` is 64 lowercase hex characters when the status is not `missing`.
   - A manifest line is at most 1 MiB. Unknown fields are ignored, as the format allows.
3. **Documents.** For every line that is not `missing`: the file at `location` exists, its size and SHA-256 match the manifest, and its size is within the server's file size limit (from `GetServerInfo`). The failure reasons are fixed strings: `file missing`, `size differs`, `sha256 differs`, `over the file size limit`.
4. **No extra files.** A file in the vault's directory or unplaced tree that no line names is reported. It is not imported.

If any check fails, the restore prints a report of every failure and creates nothing (exit 1). With `-allow-partial`, documents that fail step 3 are left out and listed, and the rest are imported. Steps 1 and 2 still stop it.

## 4. Plan

Before any commit, the restore decides every document's target path on the client, from the whole manifest:

1. It takes placed documents first, then unplaced documents, each in manifest order.
2. A document keeps its original `path` if the path passes `vaultpath.CheckText` and `vaultpath.CheckNew`, and its `path_key` (`internal/pathkey`) collides with no path already chosen, neither exactly nor as a file where another chosen path needs a folder, or the reverse.
3. Otherwise, and for a document whose `path` is empty (it did not decrypt), it goes to the fallback: `Restored files/<document-id><ext>`. `<document-id>` is the manifest's `document_id`. `<ext>` is `path.Ext` of the last path segment, kept only if the whole fallback path passes the same checks. Otherwise there is no extension, except that a `text` document always ends in `.md`. The folder is `Restored files`, or `Restored files 2`, `3` and so on: the first whose key no planned path uses as a file.
4. Every folder that holds a planned file gets a `FOLDER` document (engine §2), created before its files.

No vault holds documents from before the current release (owner, 2026-11-02), so every placed document passed the current path rules when it was committed and keeps its path. The fallback is a safety net for unplaced documents and for defects. It never drops bytes. The same plan applies to plaintext and encrypted targets, although the server checks plaintext paths only in plaintext vaults.

## 5. Import

The restore creates the planned documents in order through the import's existing client, with these rules:

- **Bytes.** It reads each file once, into the buffer that it uploads, and checks that buffer's SHA-256 against the manifest again. A mismatch is fatal. So the bytes that reach the server are the bytes that were verified, even if the export job replaces the directory in the meantime.
- **Retries.** `UNAVAILABLE`, `DEADLINE_EXCEEDED`, a lost reply and `EPOCH_NOT_CURRENT` are retried a bounded number of times with the same document and revision ids. Commits and uploads are idempotent (`SPEC.md` §6.2), so a retry ends in one state.
- **No skips.** A restore never skips a document. A refusal that the plan did not expect is fatal: the run stops with `failed`, and the report lists what was created. The admin restores again into another new vault.

### Interaction matrix

| Step | Event at the same time | Rule |
|---|---|---|
| Verify or import | The export job replaces the export directory | The bytes uploaded are the bytes checked (§5, *Bytes*). The runbook says to restore from a copy, or to suspend the export job first. |
| Import | A device or member commits into the target vault | `ALREADY_EXISTS` on a planned path moves that document to the fallback. Any other refusal is fatal. |
| Import | A commit or upload is refused for a path, a folder, a name or a size | Fatal (`failed`). The plan and the verification make this a defect, not an expected case. |
| Import | `UNAVAILABLE`, `DEADLINE_EXCEEDED`, or a lost reply | Bounded retry with the same ids. |
| Import | The target vault's key epoch rotates (`EPOCH_NOT_CURRENT`) | Re-seal and retry, as the import does today. |
| Import | The target vault is deleted, or the caller is removed or demoted | Fatal (`failed`). |
| After the restore | Devices are still connected to the lost vault | The runbook's order (§7): the admin deletes the lost vault if it still exists, and devices then connect to the new vault. |

## 6. Report

The report is the Markdown import's JSON report with three more lists: `fallback` (documents restored under `Restored files`, with both paths, and `path_base64` when the original path is not UTF-8), `missing` (from the manifest) and `failed_verification` (with the fixed reason, under `-allow-partial`). `skipped` is always empty. The `status` is `ok` when every document of the manifest is restored at its own path, `partial` when anything is in `fallback`, `missing` or `failed_verification`, and `failed` when the run stopped. The exit status is 0 only for `ok`. Like the export's summary, the logs name documents by id, never by path.

## 7. Devices after a restore

A restored vault is a new vault with new document ids. The order of the recovery is part of the runbook:

1. Restore into the new vault.
2. If the lost vault still exists (for example, only the object store was lost), the admin deletes it. Its devices then see that it was deleted, and stop writing to it.
3. On each device, the user connects the existing folder to the restored vault.

Step 3 is the plugin's existing connect rule (`SPEC.md` §4, engine §12 X2): every existing file goes through rule W. Identical files bind with no change, files that differ are kept as conflict copies, and files that only the device has are uploaded as new documents. So the devices also bring back any edit newer than the export. No new plugin behavior is needed. The device's old journal is not used, so a delete or a rename that the device made and never synced comes back as a file. Nothing is lost.

## 8. What the runbook must say (P6-04)

- The recovery order in §7, and that the export job must be suspended or the export copied first (§5).
- What is not restored: history, members and roles, devices, vault settings, empty folders (the export holds no folders), and encrypted vaults without escrow (the export skips them).
- For an encrypted vault, the owner invites each member again before their devices can connect, because members and their keys are not restored.
- An escrowed vault's restore target needs escrow turned on. Otherwise the next export skips the restored vault, and the backup stops covering it.
- Deletes and renames that a device never synced come back as files (§7).

## 9. Tests

- `[P6-01]`: integration tests that run the export job against a vault on the test stack, run the restore, and compare the restored vault with the manifest. Cases: placed files in nested folders, an unplaced document, a `missing` document, an escrowed encrypted vault restored into an encrypted vault, and an `e2ee` export refused for a plaintext target.
- `[P6-02]`: the damaged cases change one byte of a file, delete a file, cut the manifest's end line, change the format, point a `location` outside its tree, and give a file over the size limit. Each one creates nothing, and `-allow-partial` imports the rest only for the step 3 cases.
- `[P6-03]`: an e2e test with two Obsidian vaults: one synced to a vault, then that vault restored into a new one from an export, then the first device connected to the new vault with a newer local edit, an identical file and a local-only file.
- Unit tests for the plan (§4): collisions, fallback names and extensions, a `Restored files` name already taken, and empty paths.
