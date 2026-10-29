# Sync situations to test (from the old engine's tests)


This list records which user-visible situations the old engine's tests covered. The new engine must handle every IN situation. The outcomes in `engine.md` §5 and §12 decide each one; where this list and `engine.md` differ, `engine.md` wins. The test file names refer to the old engine, which has been removed.
Source: vault-sync `master` at `5abdf829` (2026-10-29). I skimmed the test names and scenario notes in `plugin/src/core/engine/*.test.ts`, `plugin/test/*.test.ts`, `plugin/test/e2e/specs/*.e2e.ts`, `sim/*-scenarios.ts`, `sim/scenarios.ts` and `sim/regressions/*.md`. Duplicates are merged. The test files are named relative to `plugin/src/core/engine/` unless a path is given (`e2e/` means `plugin/test/e2e/specs/`).

Verdicts:

- **IN**: in scope under the new requirements. The outcome is the expected behaviour. A "?" marks a part the requirements don't decide.
- **OUT**: out of scope. The rule that excludes it is named.
- **MOOT**: exists only because of how the old engine was built. A user can't see it.

Two rules decide many rows:

- **No silent loss.** No acknowledged write is lost (SPEC §2, principle 1). Where the requirements don't say where a file ends up, I still require that its content survives.
- **Portable, case-unique names.** The server never holds an unportable or case-only-different name. So every "a remote name this device cannot hold" situation becomes OUT.

## 1. Editor and unsaved text

| # | Situation | Covered by | Verdict | Expected outcome |
|---|---|---|---|---|
| E1 | A remote edit arrives for a note open in the editor, and the user has unsaved typing that doesn't overlap it | `e2e/editor.e2e.ts` | IN | Three-way merged into the open note. The cursor and the unsaved typing are kept. |
| E2 | A remote edit arrives that overlaps the unsaved typing in an open note | `e2e/editor.e2e.ts` | IN | The typing is saved first and then goes through the normal merge. Nothing typed is lost, and a conflict copy is made if needed. |
| E3 | A remote edit arrives for an open note with nothing unsaved | `e2e/editor.e2e.ts` | IN | Applied in place and the cursor is kept. |
| E4 | The editor saves between the moment sync reads the file and the moment it writes it | `e2e/editor.e2e.ts`, `interleaving.test.ts` | IN | The save is never overwritten. It is merged in the next round. |
| E5 | A remote delete arrives for a note that has unsaved typing | `e2e/unsaved.e2e.ts`, `e2e/editor.e2e.ts` | IN | The typing is saved and survives. ? Whether the note stays at its path or becomes a conflict copy. |
| E6 | A remote rename or a new remote file lands on the path of an open note that has unsaved typing | `e2e/unsaved.e2e.ts` | IN | The typing is saved and kept in a file. A conflict copy is made if the path is taken. |
| E7 | A remote write arrives for a canvas open with unsaved changes | `e2e/editor.e2e.ts` | IN | Unsaved canvas changes are saved first. Canvas isn't Markdown, so the newest version wins and the other becomes a conflict copy. ? The old engine merged canvases node by node. |
| E8 | The user edits right after a remote write, and Obsidian's file reload would throw that edit away | `e2e/editor.e2e.ts` | IN | The edit is kept. |
| E9 | A remote write arrives for a file open in another plugin's custom or read-only view | `e2e/editor.e2e.ts` | IN | ? Any unsaved data in the view is saved first and nothing is lost. The view's handling isn't specified. |
| E10 | The editor writes a file while sync is writing the same file | `e2e/atomicity.e2e.ts` | IN | Both writes apply in order and neither is lost. No half-written file. |
| E11 | The user saves just before sync deletes the file, writes a merge result, writes a conflict copy, or moves the file aside | `interleaving.test.ts`, `sim/scenarios.ts` (`saveBeforeEngineWrite`) | IN | The save is never overwritten or deleted. It is picked up in the next round. |
| E12 | The user makes a rapid burst of edits | `push.test.ts` | IN | One push after the burst, with the final text. An edit made during a push goes in the next push. |
| E13 | Obsidian indexes the vault at startup | `e2e/startup.e2e.ts` | IN | Not treated as changes. A real edit made afterwards is. |
| E14 | Sync's own writes show up as file events, sometimes late, or folded together with a user edit by the watcher | `engine.test.ts`, `echo.test.ts`, `respelled-echo.test.ts` | IN | Sync's own writes are never pushed back as user changes. A user edit is always detected, even right after a sync write. |
| E15 | A file is rewritten with identical content, or edited without its modification time changing | `engine.test.ts`, `push.test.ts` | IN | Changes are detected by content. Identical content pushes nothing, and a real edit is caught even when the modification time is unchanged. |

## 2. Renames and paths

| # | Situation | Covered by | Verdict | Expected outcome |
|---|---|---|---|---|
| R1 | One device renames a note while another device edits it | `structure.test.ts`, `merge.test.ts` | IN | The edit survives. ? Whether it ends up as one note at the new name or as a delete plus a create. |
| R2 | Two devices rename the same note to different names | `structure.test.ts` | IN | Exactly one note remains and its content is kept. ? Which name wins (newest?). |
| R3 | Rename chains across devices (a→b on one, b→c on another), swaps of two names, or a rotation of three | `structure.test.ts`, `pathkey-collision.test.ts` | IN | Every content ends up exactly once. No duplicates and nothing lost. |
| R4 | A folder with many files is renamed while another device edits a file inside it | `structure.test.ts`, `matched-folder-rename.test.ts` | IN | All files move. The other device's edit ends up in the renamed folder. |
| R5 | A local rename lands on a path where another device just created a file | `rename-onto-remote-create.test.ts`, `merge.test.ts` | IN | Both files are kept, and the later one gets a conflict-copy name. The other device's note is never deleted. |
| R6 | A remote rename lands on a path where a local, never-synced file sits | `merge.test.ts`, `sim/scenarios.ts` (`remoteRenameOntoUnsyncedFile`) | IN | The local file is kept whole as a conflict copy, and the renamed note takes the path. |
| R7 | A path is vacated and reused: delete a and create a new a, or rename a away and create a new a, or rename b onto a deleted a | `vacated-path.test.ts`, `renamed-away-path.test.ts`, `sim/scenarios.ts` (`fileAtVacatedPath`, `freedPathReused`) | IN | Every file's content survives, and unrelated contents are never merged together. ? Whether the new file counts as the old note or a new one. |
| R8 | The user deletes a file and then puts the same content back at the same path | `vacated-path.test.ts` | IN | No visible change on other devices. |
| R9 | The user renames or swaps files while the app is closed, or during the startup scan | `bindings.test.ts`, `scan-race.test.ts`, `e2e/sync.e2e.ts` | IN | No content lost or duplicated. ? Whether this syncs as a rename or as a delete plus a create. |
| R10 | The user renames a file while its first upload or commit is still in flight | `pending-create-rename.test.ts`, `structure.test.ts` | IN | Other devices end with the file at its final name. Nothing is left at the old name. |
| R11 | The user renames a file while an earlier change to it is still waiting, then creates a new file at the old path | `busy-path.test.ts`, `structure.test.ts` | IN | Both the rename and the new file sync, with no further user action. |
| R12 | A case-only rename (a.md → A.md) of a single note, made locally or remotely, on a case-insensitive disk | `case-rename.test.ts`, `platform.test.ts` | IN | Synced as a rename. Every device shows the new spelling. |
| R13 | A remote case-only rename of a note that was edited locally, or that is renamed again before it is pushed | `case-rename.test.ts`, `rename-onto-deleted-path-restart.test.ts` | IN | Both the rename and the edit land. The user's spelling survives a restart. |
| R14 | A folder respelled by case only (Notes/ → notes/) while files inside are edited, or while the disk keeps the old folder spelling | `respelled-folder-rename.test.ts`, `one-spelling-folder.test.ts` | IN | The folder and all its files take the new spelling, and local edits are merged in. No stray copies. |
| R15 | A user renames a file onto the path a remote note is arriving at, during the pull | `known-holder-supersede.test.ts`, `merge.test.ts` | IN | Both are kept. One gets a conflict-copy name. |
| R16 | A rename onto the path of a note that was just deleted, while another device edited the deleted note | `rename-onto-deleted-path.test.ts`, `rename-onto-deleted-path-restart.test.ts` | IN | The renamed note and the other device's edit both survive. A conflict copy is made if they collide. |
| R17 | Two devices each rename a different note onto the same vacated path | `rename-onto-vacated-both.test.ts` | IN | One note takes the path and every edit is kept. A conflict copy is made if needed. |
| R18 | One device renames a note while another deletes it | `rename-against-delete.test.ts`, `deleted-rename-source.test.ts`, `structure.test.ts` | IN | ? Whether the rename brings the note back. The old engine kept the renamed note. |
| R19 | The user moves a renamed file back to its old path while a remote delete of it arrives | `redecide-moved-back.test.ts` | IN | There is no net local change, so the delete applies. No stray copy. |
| R20 | One device creates a file named x while another creates a folder x/ | `structure.test.ts`, `file-folder.test.ts`, `rename-onto-folder-name.test.ts` | IN | Both are kept. One is renamed to a conflict name, and sync doesn't retry forever. |
| R21 | Rules for conflict-copy names under nested folders that are blocked by other files or folders | `claims.test.ts`, `outer-folder-copy.test.ts` | MOOT | Internal naming mechanics. Only the outcome in C9 is visible. |

## 3. Deletes

| # | Situation | Covered by | Verdict | Expected outcome |
|---|---|---|---|---|
| D1 | One device deletes a note while another edits it | `merge.test.ts`, `structure.test.ts`, `stale-base-round.test.ts` | IN | The edit survives and the note is kept with it. A user edit is never silently dropped. |
| D2 | This device deleted a note, and a remote edit of it arrives | `merge.test.ts`, `engine.test.ts` | IN | The note comes back with the remote edit. |
| D3 | Another device deletes a note this device never changed | `purged-cursor.test.ts` | IN | Deleted here and never re-uploaded. |
| D4 | A file is deleted while the app is closed | `bindings.test.ts` | IN | Found at startup and synced as a delete. |
| D5 | A new file appears at the path of a note that was deleted (here or elsewhere) | `push.test.ts`, `vacated-path.test.ts` | IN | The file syncs. Old content is not mixed into it. |
| D6 | The user deletes a new file before its upload was sent, or after the commit landed but its reply was lost | `deleted-outbox-create.test.ts`, `intent-recovery.test.ts` | IN | Not sent: nothing reaches the server. Already landed: deleted on the server too. |
| D7 | A deleted note is brought back on two devices at once, possibly while a new note takes its path | `merge.test.ts`, `resurrection-moved-aside.test.ts`, `ghost-recreate-shared.test.ts` | IN | Both versions are kept, merged or as a conflict copy. Neither overwrites the other. |
| D8 | Two devices make the same edit, or one deletes while the other edits, during the same push round | `stale-base-round.test.ts` | IN | No duplicate and no needless conflict copy. The edit beats the delete. Sync settles. |
| D9 | The user deletes a file during the pull while a remote rename onto that path is in progress | `blocked-holder-delete.test.ts`, `blocked-holder-rename.test.ts` | IN | Both the delete and the remote change land. Sync settles. |

## 4. Conflicts and merges

| # | Situation | Covered by | Verdict | Expected outcome |
|---|---|---|---|---|
| C1 | Concurrent Markdown edits that don't overlap | `merge.test.ts`, `sim/scenarios.ts` (`enginesEditConcurrently`) | IN | Three-way merged on every device. No conflict copy. |
| C2 | Concurrent Markdown edits that overlap | `merge.test.ts` | IN | One version stays in place, the other is saved as a conflict copy, with no conflict markers. ? Which version stays in place (the old engine kept the remote one). |
| C3 | The server moves on between this device's pull and its commit | `merge.test.ts`, `push.test.ts` | IN | The server refuses the stale commit. The device pulls, merges and commits again. |
| C4 | Concurrent edits of an attachment or other binary file | `merge.test.ts` | IN | The newest wins. The other is saved as a conflict copy, never line-merged. |
| C5 | Concurrent edits of non-Markdown text (JSON, canvas, txt, or extensions the user configured as text) | `merge.test.ts` | IN | The newest wins and the other becomes a conflict copy. ? Whether any non-Markdown type is merged. |
| C6 | One side changes only line endings (LF↔CRLF) or the trailing newline | `merge.test.ts` | IN | No conflict copy. ? Which line ending ends up in the file. |
| C7 | Two devices create a file at the same path while offline | `merge.test.ts`, `structure.test.ts` | IN | Both contents are kept. ? Whether two Markdown notes are merged against an empty base or one becomes a conflict copy. |
| C8 | The conflict-copy name is already taken by a file or folder | `merge.test.ts`, `claims.test.ts`, `pathkey-collision.test.ts` | IN | The copy gets a number that is free. |
| C9 | No conflict-copy name fits within the path length limit | `merge.test.ts`, `structure.test.ts` | IN | ? The local version stays where it is and the user is told. It is never dropped. |
| C10 | Conflict copies reach other devices | `platform.test.ts`, `pathkey-collision.test.ts` | IN | A conflict copy is an ordinary file and syncs everywhere. |
| C11 | The conflict list: conflicts listed newest first, both versions opened side by side, an entry cleared once the user deletes or renames the copy, and the original followed if it's renamed | `conflicts.test.ts`, `e2e/conflicts.e2e.ts` | IN | Users can find and resolve conflicts themselves. ? The form of the UI. |
| C12 | The merge base was pruned from history before the merge | `retention.test.ts`, `sim/scenarios.ts` (`purgedMergeBase`, `purgedMergeBaseWhileOffline`) | IN | Unchanged local side: take the remote version. Otherwise both are kept, one as a conflict copy, and the rest of the vault keeps syncing. ? Whether history is pruned at all. |
| C13 | Merges where the merge step can postpone a decision, or the result is written only partly | `engine.test.ts`, `merge.test.ts` (deferring merge hook), `merge-intent-crash.test.ts` (refused result) | MOOT | An old-engine extension point. |

## 5. Crashes and restarts

| # | Situation | Covered by | Verdict | Expected outcome |
|---|---|---|---|---|
| K1 | The app is killed while applying a remote change (write, delete or rename) | `engine.test.ts`, `apply-intent-recovery.test.ts` | IN | No half-written or lost file. The next start finishes or redoes the change. |
| K2 | The app is killed during a push, or the commit's reply is lost | `push.test.ts`, `e2e/device.android.e2e.ts`, `sim/scenarios.ts` (`lostResponseAfterHeadMoved`) | IN | The retry is recognised as the same change, so the server holds exactly one new revision. |
| K3 | The app is killed while merging or writing a conflict copy, including for a note deleted and re-created elsewhere | `merge-intent-crash.test.ts`, `conflict-copy-crash.test.ts`, `recreated-note-crash.test.ts` | IN | Both versions are intact after restart and the merge finishes once. |
| K4 | The app is killed right after a user rename, before sync noticed it | `sim/regressions/issue-280.md`, `sim/scenarios.ts` (`renameLostToCrash`) | IN | No content lost or duplicated. ? It may sync as a delete plus a create. |
| K5 | A pull fails partway (network error) | `engine.test.ts` | IN | Resumes from the last change it applied. |
| K6 | Downloaded content doesn't match its hash | `engine.test.ts` | IN | Not written, and the pull retries. |
| K7 | The plugin is disabled and re-enabled, or reloaded | `e2e/lifecycle.e2e.ts`, `e2e/sync.e2e.ts` | IN | Resumes from where it was, with no full resync. The device stays registered. |
| K8 | The local sync state can't be saved (storage error) | `bindings.test.ts` | IN | Sync stops and reports the error rather than pushing a guess. ? How it recovers. |
| K9 | Two pulls overlap | `engine.test.ts` | IN | Each change is applied once. |
| K10 | The app is killed in the middle of a resync after a server restore | `resync.test.ts` | IN | The resync finishes on the next start. |
| K11 | Upgrading local state written by older plugin versions | `bindings.test.ts` (pre-R5a/R7b/v2 journals) | MOOT | Old-engine journal formats. ? Whether the new engine imports old state or starts with a full resync. |
| K12 | The app is killed at various internal checkpoints in old-engine steps: path release, ghost re-create, alias, postponed detach | `platform.test.ts`, `stale-page-holder.test.ts`, `properties.test.ts` | MOOT | Internal steps. K1 to K3 cover what users can see. |

## 6. Attachments and size

| # | Situation | Covered by | Verdict | Expected outcome |
|---|---|---|---|---|
| A1 | An attachment larger than one upload chunk | `e2e/sync.e2e.ts` | IN | Arrives on the other device byte for byte. |
| A2 | An upload is interrupted, or the server already has the content | `push.test.ts`, `upload.test.ts` | IN | After restart, chunks the server already has are not sent again. Content it already holds is not uploaded at all. |
| A3 | The file changes while its upload is interrupted or still running | `push.test.ts`, `content-ref.test.ts`, `pending-create-rename.test.ts` | IN | The newest content is pushed. |
| A4 | The server removes an upload before its commit (cleanup), or reclaims an idle upload session | `retention.test.ts`, `upload-sessions.test.ts` | IN | The device uploads again and commits. A pending delete is never dropped. |
| A5 | A device leaves many abandoned uploads behind (server session limit) | `upload-sessions.test.ts`, `sim/upload-scenarios.ts` | IN | The server bounds the number of sessions, and the device and others can still upload. |
| A6 | A remote file is bigger than this device's download limit | `too-large.test.ts`, `deferred-holder.test.ts` | IN | ? The requirements set no limit. If one exists: the old version stays, the user is told, other changes keep arriving, and local edits are never overwritten. |

## 7. Server restore (offline snapshot)

| # | Situation | Covered by | Verdict | Expected outcome |
|---|---|---|---|---|
| S1 | The server was restored from an older snapshot, and a device that was further ahead connects | `engine.test.ts`, `restore-anchor.test.ts`, `sim/scenarios.ts` (`restoredServer`) | IN | The device detects it and resyncs instead of skipping changes. |
| S2 | After the restore, the server lacks something this device has: a note, an edit, or the device's own acknowledged commit | `purged-cursor.test.ts`, `resync.test.ts`, `resync-own-commit.test.ts` | IN | Re-uploaded. Nothing only the device held is lost. |
| S3 | The restored server has notes this device lacks | `engine.test.ts`, `resync.test.ts` | IN | Downloaded. |
| S4 | After the restore, another device changes a note this device also holds a lost version of | `resync.test.ts`, `sim/restore-scenarios.ts` | IN | Both versions are kept, merged or as a conflict copy. A file unchanged on this device takes the server version. |
| S5 | The restore happens while this device is in the middle of a push | `restore-mid-push.test.ts`, `sim/regressions/seed-5-restores-faithful-fs.md` | IN | The commit is refused. The device resyncs and pushes again, and nothing is lost. |
| S6 | The device has a delete or rename waiting to be pushed when it meets a restored server | `restore-outbox-rewrite.test.ts`, `restore-lost-deferral.test.ts` | IN | ? Whether the waiting delete or rename is re-applied after resync. Edits are never lost. |
| S7 | After the restore, the server's change count has grown past the device's old position | `restore-anchor.test.ts` | IN | The restore is still detected. |
| S8 | After the restore, another device deletes a note whose newer version only this device had | `purged-cursor.test.ts`, `sim/restore-scenarios.ts` | IN | ? The device's version survives, as a conflict copy or a restored note. |
| S9 | A restore and a history prune that look alike from the device | `purged-cursor.test.ts`, `sim/restore-scenarios.ts` | MOOT | Comes from the old cursor design. S1 and S2 cover what users can see. |
| S10 | Online restore of the vault to an earlier point | — | OUT | No online restore. |

## 8. File names

| # | Situation | Covered by | Verdict | Expected outcome |
|---|---|---|---|---|
| N1 | The user creates or renames a file to an unportable name: backslash, a drive-like `x:` prefix, a Windows reserved name, a trailing dot or space, a forbidden character | `unsyncable.test.ts`, `backslash.test.ts`, `drive-prefix.test.ts` | IN | Refused with a message naming the reason. The file stays on disk, untouched, and syncs once renamed to a valid name, even while the app is closed. |
| N2 | A synced note is renamed locally to an unportable name | `unsyncable.test.ts`, `backslash.test.ts` | IN | The rename is refused with a message and the server keeps the old name. Syncs once renamed to a valid name. ? Whether a later delete of that file syncs. |
| N3 | Two notes whose names differ only by case (a.md and A.md), created on two devices or next to each other on a case-sensitive disk | `pathkey-collision.test.ts`, `separate-spelling.test.ts`, `merge.test.ts` | IN | The later one is refused with a message and stays local and intact. |
| N4 | Names that one filesystem treats as the same (dotless ı and I on NTFS, Android shared-storage case folding) | `alias.test.ts`, `pathspace.test.ts` | IN | ? Whether the portable subset refuses these as case variants. |
| N5 | Names that differ only by Unicode normalization (NFC vs NFD, as macOS respells) | `respelled-rename.test.ts`, `pathspace.test.ts`, `respelled-file-push.test.ts` | IN | ? Treat as the same name (normalize) or refuse. They must never become two notes. |
| N6 | A path longer than the limit | `platform.test.ts`, `memory-server.test.ts` | IN | Refused with a message. ? The limit. |
| N7 | The server sends a path with `..`, a path Obsidian's `normalizePath` would change, or invalid UTF-8 | `e2e/paths.e2e.ts`, `engine.test.ts` | IN | Never written to disk. |
| N8 | The device's filesystem refuses a name the rules allow | `platform.test.ts`, `e2e/platform.e2e.ts` | IN | Reported to the user. The rest of the pull finishes. |
| N9 | The server refuses a name for a reason the device didn't foresee | `unsyncable.test.ts`, `sim/scenarios.ts` (`serverRefusedPathsSurfaced`) | IN | The server's message is shown, and sync doesn't retry it forever. |
| N10 | A conflict-copy name must itself be a valid name | `platform.test.ts` | IN | Conflict copies always use portable names. |
| N11 | A remote note whose name this device's OS can't hold (Windows-illegal names and so on), arriving or renamed into | `platform.test.ts`, `sim/scenarios.ts` (`unmaterializableOnWindows`, `parkedEditAtReusedPath`) | OUT | Unportable names. The server never accepts them. |
| N12 | The server already holds a note at an unportable path (legacy data) | `backslash.test.ts`, `drive-prefix.test.ts`, `memory-server.test.ts` | OUT | Unportable names. ? A one-off check when migrating existing data. |
| N13 | Case and spelling variants clashing on the server: a file at another spelling of a folder name, deferred notes waiting for their path | `claims.test.ts`, `deferred-spelling-claim.test.ts`, `local-rename-collision.test.ts`, `refused-path-retry.test.ts`, `matched-folder-rename.test.ts`, `vacated-path-remote-rename.test.ts`, many `sim/regressions/*-faithful-fs.md` | OUT | Names that differ only by case are refused, so these can't arise. |

## 9. Offline

| # | Situation | Covered by | Verdict | Expected outcome |
|---|---|---|---|---|
| O1 | The network is cut while the user edits | `e2e/device.android.e2e.ts` | IN | Status shows offline. Edits are kept and pushed when the network is back. |
| O2 | A device offline long enough that history it hadn't seen was pruned | `purged-cursor.test.ts`, `sim/scenarios.ts` (`purgedCursor`) | IN | It catches up. Remote deletes of untouched notes apply, local edits are kept, and no conflict copy appears for unchanged notes. ? How a pruned change list is handled. |
| O3 | A device makes an edit while offline, during a chain of renames on other devices | `structure.test.ts` | IN | When back online the edit lands in the note at the end of the chain. |
| O4 | The server rate-limits the device | `rate-limit.test.ts`, `sim/scenarios.ts` (`engineBacksOffWhenThrottled`) | IN | The device waits a bounded, growing delay and then pushes the pending change on its own. |
| O5 | A change from another device arrives without waiting for the pull timer (live notification) | `e2e/realtime.e2e.ts`, `cursor.test.ts` | IN | ? Changes show up promptly. The requirements only say devices pull. |

## 10. Mobile lifecycle

| # | Situation | Covered by | Verdict | Expected outcome |
|---|---|---|---|---|
| M1 | Android kills Obsidian's process during a push | `e2e/device.android.e2e.ts` | IN | On the next start the vault matches the server, with no duplicate revision. |
| M2 | The user edits just before Obsidian goes to the background | `e2e/device.android.e2e.ts` | IN | Pushed when the app comes back. |
| M3 | Android destroys the activity when the user switches apps | `e2e/device.android.e2e.ts` | IN | The edit is kept and pushed. |
| M4 | The plugin installs and loads on mobile | `plugin/test/mobile.test.ts`, `e2e/smoke.e2e.ts` | IN | Not marked desktop-only, and loads no Node or Electron modules. |
| M5 | Sync status on mobile | `e2e/smoke.e2e.ts` | IN | Shown without opening settings: a ribbon icon on mobile, the status bar on desktop. |

## 11. Other

| # | Situation | Covered by | Verdict | Expected outcome |
|---|---|---|---|---|
| X1 | Create a remote vault from an existing local vault | `e2e/sync.e2e.ts` | IN | All files are pushed. |
| X2 | Connect a second vault that already has files | `e2e/sync.e2e.ts` | IN | The user is warned first. ? How existing files are combined; nothing is lost. |
| X3 | Sign in with the device flow, stay signed in across reloads, re-sign-in after revoke, sign out | `e2e/signin.e2e.ts` | IN | ? Not in the requirements. The current behaviour works. |
| X4 | Server and identity provider settings are locked while a sign-in runs | `e2e/sync.e2e.ts` | IN | ? |
| X5 | Remove a device in the settings device list | `e2e/devices.e2e.ts` | IN | ? Removed once, and retrying works after a failure. |
| X6 | Sync status: busy and idle, and a failed push reported while its change stays pending | `activity.test.ts`, `push.test.ts` | IN | The user sees syncing, idle and error. A failed change is retried, not dropped. |
| X7 | Per-note version history: list, preview, restore an old version as the newest, restore a deleted note | `history.test.ts`, `e2e/history.e2e.ts` | IN | ? Not in the requirements ("no online restore" is about the whole server). If kept, a restore adds a new version and never overwrites unsynced edits. |
| X8 | Syncing the config folder (off by default, risk warning, plugin list changes ask for a reload) | `e2e/config.e2e.ts`, `sim/scenarios.ts` (`configFolderSync`, `configConflictCopies`) | IN | ? Not in the requirements. |
| X9 | Selective sync scope: files outside it, and notes moved out of scope while edited locally | `deferred.test.ts`, `deferred-holder.test.ts`, `ghost-recreate-wait.test.ts` | IN | ? Not in the requirements. Local edits are never deleted. |
| X10 | Several Obsidian vaults on one device | `e2e/journal.e2e.ts`, `e2e/smoke.e2e.ts` | IN | Each vault keeps its own sync state. |
| X11 | Vault sharing: invites, roles, removing members, viewers who may not write or restore | `e2e/sharing.e2e.ts`, `sim/member-scenarios.ts`, `sim/regressions/simfault-viewer-write.md`, `history.test.ts` | OUT | Vault sharing. |
| X12 | Encrypted (E2EE) vaults | — | OUT | E2EE. |
| X13 | Old-engine internals: path claims, aliases, ghosts, deferral lists, stale feed pages, rules the device holds back reads by, forgetting acknowledged operations, journal read counts, bindings rules | `alias-scan.test.ts`, `claims.test.ts`, `decide.test.ts`, `ghost-recreate-order.test.ts`, `deferred-ghost-claim.test.ts`, `held-back-read.test.ts`, `forget-on-acknowledge.test.ts`, `journal-reads.test.ts`, `stale-page-holder.test.ts`, `merge-claim-displaced.test.ts`, `bound-tombstone*.test.ts`, `bound-file-busy-path.test.ts`, `pending-create-rename.test.ts` (id keeping) | MOOT | Old-engine design. |
| X14 | Test-harness self-checks: harness vault, conformance and journal harnesses, the Dafny bundle, sim lint, shrink, lineage, stalled-engine reports, the `simfault` servers | `harness-vault.test.ts`, `memory-server.test.ts`, `e2e/conformance.e2e.ts`, `e2e/verified.e2e.ts`, `plugin/test/sim-*.test.ts`, `sim/*.test.ts` | MOOT | Old harness, and the proof and simulation bar is out of scope. The one real check here, that the server refuses stale commits, is covered by C3. |
| X15 | Generated property suites (P1 to P10) | `properties.test.ts` | MOOT | They restate D1, K1, R3, R9 and S1 as properties of the old design. |

## Count

- **IN:** 110 situations, 33 of them with a "?".
- **OUT:** 6: N11, N12 and N13 (unportable or case-only names), S10 (online restore), X11 (vault sharing), X12 (E2EE).
- **MOOT:** 8: R21, C13, K11, K12, S9, X13, X14, X15.

"?" items (IN): E5, E7, E9, R1, R2, R7, R9, R18, C2, C5, C6, C7, C9, C11, C12, K4, K8, A6, S6, S8, N2, N4, N5, N6, O2, O5, X2, X3, X4, X5, X7, X8, X9. N12 (OUT) and K11 (MOOT) also carry a "?": a migration check of existing server data, and whether old local state is imported.

The open questions that matter most:

- Edit vs delete placement (E5, R18).
- Which side stays in place in a conflict (C2).
- Whether renames keep a note's identity (R1, R7, R9, K4).
- Unicode normalization and NTFS-equivalent names (N4, N5).
- Whether history is pruned (C12, O2).
- Download size limit (A6).
- Whether per-note history, config sync and selective sync survive (X7, X8, X9).
