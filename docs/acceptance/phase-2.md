# Phase 2 acceptance checklist

Owner-approved on 2026-10-29. **This list is the definition of done for Phase 2. Only the owner adds to it or changes it.**

Phase 2 is done when every scenario below passes as an automated test on `master` and the owner is using the build. The design is in `docs/design/engine.md`.

**How scenarios are tested.**
- Every scenario has at least one test whose name starts with its id, for example `it("[AC-04] a note created on A appears on B", …)`.
- Scenarios that involve Obsidian are end-to-end tests in `plugin/test/e2e/specs/`.
- AC-22 and AC-23 are server integration tests.
- AC-25 is an end-to-end or integration test against a real server.
- `make acceptance` runs every `[AC-nn]` test and prints the scoreboard: passing out of total (25 scenarios; AC-01 was removed).

Unless stated otherwise, A and B are two devices: two Obsidian vaults with the plugin, signed in to the same server vault.

## Setup

- **AC-01** (Removed by the owner, 2026-10-29: deploying to the homelab is not part of the checklist. The id is kept so the others keep their numbers.)
- **AC-02** Connecting a vault: an empty vault connects. A vault that already has files connects, and its files are uploaded.
- **AC-03** A second device connects to the same vault and downloads every file. If it already has files, it warns first, and nothing is lost (`engine.md` §12, X2).

## Basic sync

- **AC-04** A note created on A appears on B.
- **AC-05** An edit on A appears on B.
- **AC-06** A delete on A is applied on B.
- **AC-07** A rename or move on A is applied on B, and the document keeps its history.
- **AC-08** Folders: create, rename and delete folders, including folders with files in them. Empty folders sync. An empty folder deleted on A stays deleted on both devices.
- **AC-09** Attachments: an image and a PDF of a few MB arrive byte for byte. A file over the size limit is skipped with a notice, and other files still sync.

## Offline and conflicts

- **AC-10** Edits made on A while it is offline upload when it reconnects.
- **AC-11** A and B edit different parts of the same note: both edits are merged on both devices, with no conflict copy.
- **AC-12** A and B edit the same lines: the server's version stays at the path, and the other version is saved as a conflict copy. Nothing is lost, and there is exactly one copy.
- **AC-13** A and B change the same attachment: the newest wins at the path, and the other is kept as a conflict copy.
- **AC-14** A deletes a note while B edits it: the edit wins, and the note exists on both devices with B's edit.
- **AC-15** A renames a note while B edits it: the note ends up at the new name, with B's edit, on both devices.
- **AC-16** A and B create a note at the same path. Same content: one note. Different content: one note at the path plus one conflict copy.

## Robustness

- **AC-17** The app is killed mid-sync (during a download and during an upload): no half-written or lost file, sync resumes on the next start, and the server holds no duplicate revision.
- **AC-18** Server unreachable: the plugin works locally, shows offline, and catches up when the server is back.
- **AC-19** Unportable names are refused with a clear reason, and nothing else breaks: a Windows-forbidden character, a reserved name, a trailing dot, and a name that differs from an existing one only by case.
- **AC-20** File names created on Windows, macOS and Linux arrive identically on the others, including Unicode names (NFC).
- **AC-26** A path too long for one device's filesystem is skipped there, with a notice. It still syncs to the other devices, and the rest of the vault syncs normally. A long new path (over 200 characters) gets a warning.

## Mobile

- **AC-21** Android: sign in, sync a vault, and receive edits after the app is reopened. Edits made just before the app went to the background are pushed when it comes back.

## Server data

- **AC-22** Offline restore: stop the server, restore an earlier PostgreSQL and S3 snapshot, and start it again. A connected device detects it, resyncs, and re-uploads every file only it held. Nothing is lost.
- **AC-23** Markdown import: `vault-sync-server import` loads a folder of Markdown files and attachments into an empty vault. A device then syncs them.
- **AC-24** Per-note history: list a note's versions and restore an old one. The restore becomes the newest version on every device.

## Convergence

- **AC-25** Three devices make random creates, edits, renames and deletes (seeded), with some going offline and coming back, then sync until idle. All three end with identical files, equal to the server's heads, and no user edit is lost (it is in a file or a conflict copy).

## Explicitly out of scope for Phase 2

Vault sharing, end-to-end encryption, live co-editing, online restore, names outside the portable set, selective sync, config-folder sync, merging non-Markdown files (backlog #1105), and any proof or simulation bar beyond these scenarios.
