# Sync engine design

Status: approved by the owner on 2026-10-29. It replaces `engine-path-ownership.md` and `verified-core.md`, and the parts of SPEC.md §6.3, §7 and §8 that described the old engine.

This document is the whole design of the plugin's sync engine. Agents implement it; they do not change it. If it doesn't decide a case, ask on the issue. The operator answers from the owner's policy, or asks the owner when the question is about the product. The policy, in order: do what Obsidian Sync does; failing that, whatever loses the least data; failing that, whatever is simplest. **Every answer must keep the convergence argument in §11 true.**

## 1. Goals

- **Behaviour like Obsidian Sync, self-hosted.** Markdown is merged three-way. Other files: the newest wins, and the other version is kept as a conflict copy. Users resolve the conflict copies they care about.
- **Converge.** Once every device has synced with no new edits, every device holds the server's files.
- **Never lose user data silently.** A user's change survives as the file, as a conflict copy, or in server history.
- **Small.** One sync loop and one decision table. No proofs, no simulation bar.

Out of scope for Phase 2: vault sharing, end-to-end encryption, live co-editing, online restore, names outside the portable set (§6), selective sync, and config-folder sync.

## 2. Model

- **Server.** One ordered change list per vault (`ListChanges`, `seq` ascending). A document has a stable id, a path, a kind and a head revision. Commits are optimistic: `CommitRevision` succeeds only if `base_rev_id` is the document's head, and is idempotent by `revision_id` (SPEC §6.2). The server refuses a path that collides with another live document (`ALREADY_EXISTS`).
- **Document kinds.** `TEXT` is Markdown (`.md`), merged three-way. `BLOB` is everything else: the newest wins, and the loser becomes a conflict copy. `FOLDER` is new: a folder with no content. **Every folder is a `FOLDER` document**, not only empty ones, so each device's folders mirror the server the same way its files do.
  - **Detection:** a folder on disk with no document is a create, including folders Obsidian makes as a new file's parent. A folder document whose folder is gone is a delete. Obsidian's folder rename event keeps the document.
  - **Remote folder revision:** a live revision creates or moves the folder with its contents, using rule W for the path. If a child is already at its target, that step is a no-op. A tombstone deletes the folder only if nothing live remains in it.
  - **A live item keeps its ancestors live:** a device that keeps, re-creates or writes an item whose parent folder document is missing or deleted creates the folder and pushes its document as a create, or as a re-create on the tombstone.
- **Device journal** (IndexedDB, one per vault, a fresh schema; there is no migration from the old engine's journal):
  - `cursor`: the last applied `seq`, plus its `anchor`.
  - `docs`: `document_id` → `{ path, kind, base_rev_id, base_hash }`. `base_*` is the revision this device last synced for the document; `base_hash` is the SHA-256 of its content.
  - `pending`: local operations not yet acknowledged. Each is `{ op_id, document_id, kind: create|edit|rename|delete, path, revision_id, content_hash }`. `revision_id` is chosen once and kept until the commit is acknowledged, so a retry after a crash is idempotent.
  - `conflicts`: conflict copies this device created, for the conflict view.

## 3. The sync loop

The loop runs one cycle at a time. A cycle starts when there is a local change (debounced about 2 s after the last edit), when the realtime channel reports `vault_changed`, when the app starts or comes back to the foreground, and every 60 s as a fallback.

1. **Detect local changes** (§4) and turn them into `pending` operations.
2. **Pull.** Call `ListChanges` from `cursor` until `has_more` is false. If the server reports `diverged`, run the resync in §9 instead. Apply each revision in order using the decision table (§5). After each one, write the file change and then the journal: `docs`, and `cursor = seq`.
3. **Push.** For each pending operation, oldest first:
   - Upload the content (resumable, deduplicated by hash).
   - Call `CommitRevision` with `base_rev_id = docs[id].base_rev_id`.
   - On success, set `base_* = the new revision` and drop the pending operation.
   - On `FAILED_PRECONDITION` (the head moved), stop pushing this document. The next cycle's pull brings the head, and §5 resolves it.
   - On `ALREADY_EXISTS` (path taken), apply rule P2 in §5.
   - On any other error, keep the operation, back off (bounded and growing), and show the error in the status.
4. If the pull or push made progress, run another cycle at once. Otherwise go idle.

There is only one decision point, the decision table, and it always runs against the server's head. Conflicts are therefore resolved by the device that loses the race: the one whose commit was refused.

## 4. Detecting local changes

- **Source of truth: content.** A file is changed when its SHA-256 differs from `base_hash`. Modification times are only hints.
- **Live events.** Obsidian's vault events (`create`, `modify`, `delete`, `rename`) give quick hints. A `rename` keeps the document id, so the rename syncs as a rename.
- **Startup and resume scan.** Compare the files on disk with `docs`:
  - A file on disk with no document is a create.
  - A document whose file is missing is a delete.
  - A hash mismatch is an edit.
  - A missing document whose `base_hash` equals a new file's hash (one-to-one) is a rename. Otherwise the change syncs as a delete plus a create. This is what happens to renames made while the app was closed.
- **The engine's own writes.** The engine records the hash of every file it writes. A later event whose hash matches is its own write, not a user change. A user edit made right after a sync write has a different hash, so it is always detected.
- **Editor safety.** Before writing to a file that is open with unsaved changes, the engine asks Obsidian to save it, then re-reads it. The saved text is then the local side of the decision. Keep the existing editor-safe writer in `plugin/src/obsidian/`.
- **Startup indexing.** Obsidian's indexing at startup is not a change, because hashes are unchanged.

## 5. Decision table

The table applies one remote revision `R` of document `d`. The local state is defined against `base` (`docs[d]`):

| Local state | Meaning |
|---|---|
| `absent` | No `docs[d]` entry. |
| `clean` | The file exists with `hash == base_hash`, and nothing is pending. |
| `edited` | The file's hash differs from `base_hash`, or an edit is pending. |
| `deleted` | `base` exists, the file is gone, and a delete is pending. |
| `renamed` | A rename to path `p'` is pending. It may be combined with `edited`. |

**Pull rules** (remote revision `R`):

| # | Local | R | Action |
|---|---|---|---|
| A1 | absent | live | Write `R` at `R.path` (see W below). |
| A2 | absent | tombstone | Nothing. |
| A3 | clean | live, same path | Overwrite with `R`. |
| A4 | clean | live, new path | Move the file to `R.path` (W), then write `R`'s content if it differs. |
| A5 | clean | tombstone | Delete the file. Drop `docs[d]`. |
| A6 | edited | live | Content: rule M. Path: `R.path` wins unless this device also renamed (A9). |
| A7 | edited | tombstone | **The edit wins.** Keep the file and make the pending edit a re-create: commit with `base = R`. |
| A8 | deleted | live | **The edit wins.** Write `R` (W) and drop the pending delete. |
| A9 | renamed | live | The content follows rule M. If `R.path == base.path`, keep the local path and push the rename. If `R.path` differs, **the server's path wins**: move the file to `R.path` and drop the local rename. |
| A10 | renamed | tombstone | **The rename counts as an edit, so it wins.** Keep the file at its new path and re-create it (`base = R`). |
| A11 | deleted | tombstone | Drop the pending delete. |

After every row, set `base = R` (rows A2, A5 and A11 drop the document instead).

**Rule M: content merge** (local text `L`, remote `R`, base `B`):
- **`TEXT`:**
  - If `L` and `R` are equal after normalizing line endings (and ignoring the trailing newline), take `R`.
  - Otherwise, run a three-way merge (`B`, `L`, `R`). If it is clean, write the merged result and make it a pending edit based on `R`.
  - If it conflicts, write `R` at the path and save `L` as a conflict copy (C).
  - If `B` is unavailable because it was pruned from history: when `L == B`, the local side is unchanged, so take `R`. Otherwise, write `R` and save `L` as a conflict copy.
- **`BLOB`:** the newer of `L` (its modification time) and `R` (`create_time`) wins at the path. The other is saved as a conflict copy (C). If they are equal, take `R`. If the local side wins, it becomes a pending edit based on `R`.
  - **Merged types (picked by the path's extension, case-insensitively; the kind stays `BLOB`):** first run the type's three-way merge of `B`, `L` and `R` from the table below. If it is clean and its result validates, write it (a pending edit based on `R`, unless it equals `R`) with no copy; when the merged value equals one side's, that side's bytes are kept. If `B` is unavailable, any side fails to parse or validate, the merge conflicts, the result fails validation, or the merge fails in any other way, apply the `BLOB` rule above to the whole file. Conflict markers are never written. The structured strategies share one tree-merge core (`plugin/src/core/merge/tree-merge.ts`): maps merge per key (a change on one side is taken, identical changes are accepted, maps changed on both sides merge recursively); two different changes to one value, or a deletion on one side and a change on the other, are a conflict.

    | Type | Extensions | Strategy | Falls back to the `BLOB` rule when |
    | --- | --- | --- | --- |
    | Obsidian Bases | `base` | YAML tree merge validated against the Bases schema (`plugin/src/core/merge/bases-schema.ts`); `views` match by `name` (missing or duplicate names make the list one value); the `and`/`or` lists of `filters` merge as sets; any other list, such as `order`, `groupOrder` or `sort`, is one value. Written by js-yaml (key order kept, comments dropped). | a conflict; a side that does not parse or validate; an invalid result |
    | JSON Canvas | `canvas` | JSON tree merge validated against JSON Canvas 1.0 (`plugin/src/core/merge/canvas-merge.ts`); `nodes` and `edges` match by `id`, never by position, and their fields merge as maps; unknown fields are kept. Order: the base's items, then local additions, then remote additions. | a conflict; a side that reorders the items all three sides keep (a z-order change); a side or result that is not a valid canvas (bad schema, duplicate ids, an edge whose `fromNode` or `toNode` is missing, as when one side deletes a node the other links to) |
    | JSON | `json` | JSON tree merge; an array is one value. Written with the local side's indentation. | a conflict; a side that is not UTF-8 JSON |
    | Plain text | `txt`, `csv`, `tsv`, `css`, `js`, `ts`, `py`, `sh`, `html`, `xml`, `tex`, `org`, `rst`, `yaml`, `yml`, `toml` (`lineMergeExtensions`) | Line-based diff3 merge (node-diff3): changes to separate lines combine; overlapping or adjacent changes, including different insertions at one place, refuse the merge. | any overlapping or adjacent change; a side over 1 MiB or not valid UTF-8; for `yaml`/`yml` (js-yaml) and `toml` (smol-toml), a result that does not parse |
    | Anything else (binary) | | none | always |
- **`FOLDER`:** there is no content, so only the path rules apply.

**Rule W: writing at a path** (when the target path is occupied on this device):
- **Free:** write (via a temporary file, then rename; see §8).
- **A file with the same content:** treat it as the document's file and bind it (`docs[d]`). Write nothing, and push no create.
- **An untracked file, or the file of a document with a pending local rename onto this path:** move the local file to a conflict copy name (C). Then write `R`. The local file stays a pending create under the copy name.
- **A folder where a file must go, or the other way round:** the local item moves to a conflict copy name (C).

**Push rules:**

| # | Server answer | Action |
|---|---|---|
| P1 | `FAILED_PRECONDITION` (the head moved) | Keep the operation. The next pull resolves it through rows A6–A10. |
| P2 | `ALREADY_EXISTS` (another document holds the path) | Keep the operation and pull. The other document arrives and meets the local file through rule W: same content binds it and drops the pending create; different content moves the local file to a conflict copy name (C), and that is pushed as a new document. |
| P3 | The name is refused as unportable (§6) | Keep the file untouched, list it in the conflict view with the reason, and don't retry until it is renamed. |

**Rule C: conflict copies.**
- The name is `<name> (Conflicted copy <user> <device name> <YYYYMMDDHHMM>).<ext>`, in the same folder, after the local user and device (`sharing.md`, Attribution). If that is taken, append ` 2`, ` 3`, and so on.
- If the name would exceed the path limits (§6), shorten `<name>`. The copy is never dropped.
- A conflict copy is an ordinary new document. It syncs everywhere and is listed in the conflict view until the user deletes or renames it.
- Only the device that resolves the conflict creates the copy, so there is one copy per conflict.

## 6. Names and paths

**Portable names.** The server and the device refuse a path, with a clear reason, if:
- any part contains `< > : " / \ | ? *`, a control character, or a leading or trailing space;
- any part ends in `.`;
- any part is a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9` or `LPT1`–`LPT9`, with or without an extension);
- any part is `.` or `..`, or is longer than 255 UTF-8 bytes;
- the whole relative path is longer than 1024 UTF-8 bytes.

**Unicode version.** Names may only use code points assigned in **Unicode 15.0** (owner decision, 2026-10-29), so that the Go and JavaScript standard libraries normalize and fold them identically. Other names are refused like any unportable name.

**Libraries, not hand-written code** (owner decision, 2026-10-29): NFC through `golang.org/x/text/unicode/norm` and `String.prototype.normalize`; case folding through `golang.org/x/text/cases` and a maintained JavaScript Unicode data package; the three-way merge through `diff-match-patch` (what Obsidian Sync uses); the OAuth/OIDC client through `oauth4webapi`; UUIDs through the `uuid` package.

**Normalization.** Paths are stored and compared in Unicode NFC. The device converts names it reads from disk to NFC, which covers macOS respelling names as NFD.

**One name per key.** `path_key` = NFC, then Unicode case folding, then the NTFS upcase mapping (dotless `ı` and `I` become the same key). Two live documents can't share a key: the server refuses the second (P2 or P3). A case-only rename of a document is a rename of that document, and is allowed.

**Device path length.** Before writing, the device checks the full path (vault folder plus relative path) against its platform's limit: 260 characters on Windows unless long paths are enabled, and the OS limit elsewhere. A file it can't write is skipped and listed in the conflict view with the reason. It stays on the server and on other devices, and the rest of the pull continues. When the user creates a path longer than 200 characters relative to the vault, the device warns them.

**The server never sends** a path that fails these rules. If the device receives one anyway (`..`, invalid UTF-8), it refuses to write it and reports it.

## 7. Size limits

The server has a configurable maximum file size (default 200 MiB). Files over the limit are not uploaded and are not downloaded. They are listed in the conflict view with the reason, and other files keep syncing.

## 8. Crash safety

- **Writes.** Write to a temporary file in the same folder, then replace the target with it. A crash leaves the old file or the new one, never half of one.
  - **Desktop:** the file system's atomic rename over the target.
  - **Mobile** (no atomic replace): write the temporary file completely, delete the target, then rename the temporary file to the target. At startup, a temporary file whose target exists is deleted, because it may be partial. A temporary file whose target is missing is complete, so it is renamed into place as the engine's own write.
  - **A file open in Obsidian's editor:** the §4 editor-safe write in place, which is Obsidian's own save path.
- **Order.** Change the file first, then the journal. After a crash between the two, the startup scan sees a file that differs from `base` (or is missing), and the rules above treat it as a local change. That is safe: the result is merged against the server, never lost.
- **Commits.** `revision_id` is stored in `pending` before the first attempt, so a retry after a crash or a lost reply is the same commit (the server is idempotent).
- **Uploads.** Uploads resume, and content the server already has is skipped (SPEC §6.2).
- **Journal write failure.** Stop syncing, show the error, and retry the cycle with backoff. Never push a guess.

## 9. Server restore (offline snapshot)

The operator restores PostgreSQL and S3 with the app offline. Because the server writes blobs before revisions and never deletes a blob that a revision still references, snapshotting PostgreSQL first and S3 second gives a consistent pair. The device detects a restore through `diverged` (anchors, SPEC §6.1). Then it does a **resync**:

1. Pull the whole change list from `seq` 0, so the device has every document's head on the restored server.
2. For each document on the server:
   - The local file is equal to the head: set `base = head`.
   - The local file differs, or the head is unknown to the journal: apply rule M against the head, with no base. Equal content is taken as is; otherwise the server version goes at the path and the local version becomes a conflict copy.
   - The local file is missing and the journal had no pending delete: write the head.
3. For each local file or pending operation that the server doesn't know: push it, using the document id from the journal and an empty base, so it is created again.
4. Keep pending deletes and renames. Re-apply them as normal pending operations against the restored heads.
5. Then continue normal cycles.

If the device crashes mid-resync, it restarts the resync from step 1. The resync is idempotent.

**Markdown import** is a CLI client of the server's API (`vault-sync-server import <server> <vault> <dir>`) that signs in and commits like any device. It creates one document per file, with no history.

## 10. Status and user interface

Keep the existing Obsidian UI:
- the status in the status bar on desktop and a ribbon icon on mobile, showing synced, syncing, offline or error;
- sign-in, settings and the device list;
- the conflict view, listing conflict copies, files that can't be held and refused names;
- per-note history and restore. A restore is a new revision based on the head.

## 11. Why this converges

1. **The server orders every change.** Each document's history is one chain of revisions (optimistic commits). There is never a fork to reconcile.
2. **Only one device resolves each conflict.** A device resolves local changes only against the server's head, and only the device whose commit was refused does so. It then commits the result on top of that head. So each conflict is resolved once, and produces at most one conflict copy.
3. **Every rule is decided by inputs that every device sees in the same order:** the revision, `base`, and this device's own local state. No rule depends on another device's unsynced state.
4. **No rule pushes a change in response to a change unless the device has a local change of its own.** Rows A1–A5, A8 and A11 push nothing, and rows A6, A7, A9 and A10 push only on top of a local change. So when users stop editing, each device's queue empties after finitely many cycles, and every device ends at the server's heads. Two devices cannot keep re-pushing to each other.
5. **Paths can't collide on the server** (one name per key), so rule W and P2 run once per collision, and the copy is a new document with a free name.

A rule that breaks any of points 1–5 is a design change and needs the owner.

## 12. Settled questions from the old engine's tests

These are the open questions from the review of the old engine's tests (`docs/design/engine-situations.md`). Settled here:
- **Edit vs delete** (E5, R18, S8): the edit or rename wins, and the note stays at its (new) path.
- **Which side stays in place** (C2): the server's version stays at the path, and the local version becomes the conflict copy.
- **Rename identity** (R1, R7, R9, K4): a live rename event keeps the document; a path freed and reused by a new file is a new document; an offline rename is detected by hash where it matches one-to-one, and otherwise syncs as a delete plus a create.
- **Two devices rename the same note** (R2): the server's path wins, and the content is merged.
- **Non-Markdown text and canvas** (E7, C5): the newest wins, plus a conflict copy. Merging these is backlog #1105.
- **Line endings** (C6): the content is equal after normalization, so take the remote version with no copy.
- **Same path created on two devices** (C7): rule W. Same content is bound as one document; otherwise the local file becomes a conflict copy.
- **Conflict copy name too long** (C9): shorten it; never drop the copy.
- **Pruned merge base** (C12, O2): rule M without a base. The server never prunes a head, so catching up always works.
- **Journal storage failure** (K8): stop, report, retry.
- **Download size limit** (A6): §7.
- **Pending delete or rename at a restore** (S6): re-applied after the resync.
- **Unportable rename of a synced note** (N2): refused with a reason. A later delete of that file syncs as a delete.
- **NTFS and Unicode equivalence** (N4, N5): `path_key` and NFC (§6).
- **Path limits** (N6): §6.
- **Realtime notification** (O5): keep the realtime channel; it triggers a pull.
- **Connecting a vault that already has files** (X2): warn first, then treat every existing file with rule W (same content binds; different content becomes a conflict copy).
- **Sign-in and devices** (X3–X5): unchanged.
- **Per-note history** (X7): kept.
- **Config-folder sync and selective sync** (X8, X9): out of Phase 2. They are hidden in the settings.
- **Old journals and legacy server data** (K11, N12): none exist. Start fresh.
