# Verified engine core

Status: **draft, awaiting the owner's sign-off** (#945, part of the verified-core rewrite #944). This document will hold the specification of the engine's verified decision core. Only §1 exists so far: the guarantees the core must keep, in plain English, for the owner to approve. The formal specification (#947) states these guarantees as invariants and proves them; it may not weaken them. Changing what a guarantee means needs the owner (#944, "Rules while this runs").

## 1. Guarantees

### 1.1 The guarantees

"You" means any user of the vault, on any device. "Sync" means the plugin's exchange with the server.

- **G1. Nothing the server accepted is lost.** Once the server has accepted a version of a file, that version can always be got back: as the current file, in the file's history, or as a conflict copy. Only the operator's history-retention policy ever removes old versions, and never the latest one.
- **G2. Sync never destroys what you wrote on a device.** The plugin only overwrites or deletes a file whose contents are exactly what it last saw there. It never deletes a file it does not track: it moves it out of the way instead. A file you are editing is never replaced underneath your unsaved changes.
- **G3. A file is only deleted because someone deleted it.** Sync deletes a file on other devices only after a user deleted that file on some device. A crash, a missed notification or a file sync itself moved never counts as a delete.
- **G4. A deleted file only comes back because someone wanted it.** A deleted file reappears only when someone edited it, renamed it, created a new file in its place, or restored it from history. It never comes back by itself.
- **G5. A file stays the same file.** Renaming or moving a file keeps it the same file, with its history. Two different files are never mixed up or joined into one just because they have the same name or the same contents.
- **G6. Simultaneous changes keep both versions.** When two devices change a file at the same time, edits to different parts of a note are combined. Otherwise one version stays in place and the other is saved next to it as a conflict copy. An edit or a rename always beats a delete.
- **G7. One name, one file.** No two files ever hold the same name, on a device or on the server. When two files want one name, one keeps it and the other moves to a new name with its contents intact.
- **G8. A crash changes nothing.** If the app crashes, is killed or loses power at any moment, it finishes or undoes what it was doing when it starts again, and ends up as if it had not crashed (apart from the names and times of conflict copies). Changes made while the app was closed are picked up when it starts.
- **G9. Synced devices agree.** Two devices that have both finished syncing hold the same files, with the same contents, under the same names. The exceptions are files a device cannot hold (a name its system does not allow, a file too large to download), which stay on the server and are reported on that device instead of dropped; settings files a device has chosen not to sync; and folder names that differ only in upper or lower case, where a device's system treats them as one folder.
- **G10. Sync always finishes.** Every conflict is settled within one sync, unless a user has to act on it, which the plugin then reports. Sync never loops or stalls forever.

### 1.2 What each guarantee covers

Invariants are those of `engine-path-ownership.md` §5.1. `SPEC.md` sections are those that state the user-visible rule.

| Guarantee | Invariants | `SPEC.md` |
|---|---|---|
| G1 | INV-4 (bytes are in a file, history or an open copy step) | §2 principle 1, §6.3, §7 (conflict copies), §11 |
| G2 | INV-4 | §8 "Never overwrite unsynced local edits", "Editor-safe writes", "Editor-safe deletes" |
| G3 | INV-5 | §6.3 (delete is a tombstone), §8 "Identity follows the file", "Start-up scan" |
| G4 | INV-6 | §6.3 (delete vs. edit, delete vs. rename), §7 (path and content merged apart), §11 (restore) |
| G5 | INV-3 | §6.3 (rename), §8 "Identity follows the file", "Start-up scan" |
| G6 | INV-4, INV-6 | §6.3, §7 (merge table, "When a copy is made", copy names) |
| G7 | INV-1, INV-2 | §5 (path key, file/folder collisions), §6.3 (create races), §7 "Who keeps a path", "Refused commits" |
| G8 | INV-7 | §8 "Crash safety", "Start-up scan", "Deliberate changes" |
| G9 | INV-9 | §6.1 (pull), §8 "Platform path rules", "Download cap", "`.obsidian/` config sync" |
| G10 | INV-8 | §7 "Refused commits", §8 "Push" |

Invariants not stated as a guarantee of their own:

- **INV-10 (echo independence)** is left out as too implementation-specific. It is about the bookkeeping that tells the plugin's own disk writes apart from a user's. Its observable effect is already required by G3 and G5 (sync's own writes never count as a user's delete or rename) and by G10 (losing that bookkeeping costs at most one sync with nothing to send).
- **INV-1 and INV-2** are merged into G7: INV-1 is the device half (one file per name on disk) and INV-2 the server half.
- No invariant is dropped.

### 1.3 Behaviour the guarantees leave open

These defaults follow design §10.3: (1) what Obsidian Sync does, (2) what loses the least data, (3) what is simplest. Each row names the first step that settles it. Where `SPEC.md` already decided the behaviour before the policy existed, the row says so, and says whether the policy agrees.

| Behaviour | Default | Decided by |
|---|---|---|
| Two devices edit different parts of the same note | Combined automatically; no conflict markers are written into the note | Step 1 (Obsidian Sync merges notes). The merge is line-level, not Obsidian's diff-match-patch: `SPEC.md` §7 decided that (#18), and step 2 agrees, because a fuzzy patch can misplace text silently while a line-level merge falls back to a copy |
| Two devices edit the same lines of a note, or the same non-note file | The other device's version stays in place; this device's version becomes a conflict copy next to it | Step 1 (Obsidian Sync's "create conflict file" option keeps the remote version in place). Its default for non-note files, last-modified-wins, is excluded because it breaks G1 and G6 |
| Name of a conflict copy | `<name> (conflict <device> <date>).<ext>`, as `SPEC.md` §7 says today | `SPEC.md` §7 (PO-14), which predates the policy. Step 1 would pick Obsidian's `<name> (Conflicted copy <device> <YYYYMMDDHHMM>).<ext>`. **Open question for the owner:** keep the current name, or switch to Obsidian's (an engine update, no guarantee changes) |
| One device deletes a file while another edits or renames it | The edit or rename wins; the file stays, with the edit | Step 2 (keeps the edit). Also `SPEC.md` §6.3 |
| Two devices create a file with the same name at the same time | The first to reach the server keeps the name; the other becomes a conflict copy | Step 3 (both outcomes keep all contents, so step 2 does not decide). Also `SPEC.md` §6.3 |
| A file is created where a deleted file used to be, while that device is offline | It becomes the next version of the deleted file, which keeps its history | Step 3 (no data is at stake either way; Obsidian Sync's behaviour is undocumented). Also `SPEC.md` §8 (decision #17) |
| A file is moved or renamed while the app is closed | Recognized as a rename only when its contents match exactly one missing file; otherwise it is a delete plus a new file | Owner decision 4 (2026-10-20, design "Decisions"), which predates the policy. Step 2 agrees: a wrong match would attach one file's history to another, and the fallback loses no contents |
| A file a device cannot hold (name not allowed, too large) | Kept on the server and on other devices unchanged; this device reports it and does not rename it for everyone | Step 3 (no data is lost either way; Obsidian Sync's behaviour is undocumented). Also `SPEC.md` §8 "Platform path rules" |
| Two folders whose names differ only in case, on a device that treats them as one | The device keeps the spelling it already has on disk | Step 3 (no data is at stake). Also `SPEC.md` §8 and design INV-9 (#737) |
| A delete of a note with unsaved changes in an open editor | The changes are saved and the delete is refused, so the edit then wins over the delete | Step 2 (keeps the unsaved text). Also `SPEC.md` §8 "Editor-safe deletes" (#181) |
