# Phase 6 acceptance checklist: restore from an export

Owner-approved on 2026-11-02. **This list is the definition of done for Phase 6. Only the owner adds to it or changes it.**

The goal is to back up files and recover them after a data loss. A restore brings back the current files of a vault. It does not bring back history, members, roles or devices.

Phase 6 is done when:
- every scenario below passes as an automated test on `master` (named `[P6-nn] …`), apart from P6-04, which the owner signs off;
- the release is cut.

Design: `docs/design/restore-from-export.md`.

| Id | Scenario |
|---|---|
| P6-01 | An admin restores a vault from an export into a new, empty vault with one command. Every file in the export is in the new vault with the same bytes: placed files at their paths, and unplaced files at their original paths, or under a fallback name that the report lists if the server refuses that path. Files that the manifest lists as `missing` are listed in the report. This works for a plaintext vault and for an escrowed encrypted vault restored into an encrypted vault. |
| P6-02 | A damaged export is reported before anything is imported: a file whose SHA-256 does not match the manifest, a file that is missing, a manifest without its end line, or an unknown format version. By default the restore then imports nothing. With an explicit option, it imports the files that verify and lists the others. |
| P6-03 | A device that synced the lost vault connects its existing folder to the restored vault. No file on the device is lost or overwritten: identical files are matched with no change, files that differ are kept as conflict copies, and files that only the device has are uploaded. |
| P6-04 | The admin documentation has a restore runbook, approved by the owner: how to restore a vault from an export, how users reconnect their devices, and what a restore brings back and what it does not (history, members, roles, devices, and encrypted vaults without escrow, which are not in the export). |

## Out of scope for Phase 6

Restoring history, members, roles, devices or vault settings; resuming an interrupted restore (run it again into another new vault); restoring into a vault that already has files; restoring encrypted vaults without escrow from an export (restore the server's PostgreSQL and S3 backups, or reconnect devices).
