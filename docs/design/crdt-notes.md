# Design proposal: notes as CRDT documents

For: developers and agents, and the owner when deciding whether to build it. You know `SPEC.md` and the engine design (`docs/design/engine.md`).

Status: proposal, not scheduled. The owner asked for this design on 2026-11-02 and chose to keep the current file sync until live editing matters enough to build it. Do not implement it without an owner-approved checklist and a `/pm` instruction. When work starts, it gets the usual independent design review first.

## 1. Why this design

vault-sync syncs a Markdown note by comparing texts. A device commits a revision, and a device whose commit is refused merges three ways (engine §5, rule M). Live co-editing needs a CRDT (a conflict-free replicated data type). A CRDT gives every inserted character an identity, so concurrent edits merge without conflicts and an edit that arrives twice is applied once.

The first Phase 5 design kept text revisions as the durable copy and used a CRDT only while a note was open. Two design reviews (issue #1496) showed the cost of that split. Text moves between the two models at every session start and end, and an identity is lost each time text leaves the CRDT. Turning text back into edits is a guess, so the same keystroke can come back as duplicated text, or a stale text can be read as a deletion. The design can be made safe, but at a permanent price. Each failure (a crash, a long outage) falls back to a text merge that can make a conflict copy, and the hand-over needs its own states in the engine.

This design removes the split. **For a Markdown note, the CRDT is the only way content moves between devices.** Files on disk are a local view of the CRDT on each device. Revisions of a note become read-only checkpoints of the CRDT, for history and export. No device ever merges two texts of a note. Text only moves out of the CRDT to the file and to checkpoints, and back in by a diff on one device against a base that is exact (§5).

## 2. Goals and limits

Goals:

- Live co-editing: people with the same note open see each other's typing within about a second, with cursors and names.
- Offline editing merges by the CRDT. A Markdown note never gets a conflict copy, after any outage or crash.
- No text that a device acknowledged is ever lost (principle 1).
- Desktop and Android. Plaintext and encrypted vaults.
- History, restore, retention, export and import keep working, with the same user-visible behavior.

Limits, accepted:

- The same outside change made independently on several devices (for example, a plugin that writes a "last modified" field on every device) becomes several CRDT edits, so the text can hold it twice. Every CRDT editor shares this limit.
- Files other than Markdown notes keep file sync and the engine's decision table unchanged.
- Devices that run a plugin without CRDT notes cannot edit notes in a vault that uses them (§10).
- An export is only as current as the newest checkpoint (§7).

## 3. Model

| Concern | Today | With CRDT notes |
|---|---|---|
| A note's content between devices | Revisions, merged three ways on a refused commit | An append-only log of CRDT updates per note, with periodic snapshots |
| A note's path and existence | Revisions | Unchanged: revisions with a path change or a tombstone, under the engine's rules |
| A note's history, restore, export | Revisions | **Checkpoint revisions**: ordinary revisions whose content a client renders from the CRDT, never merged |
| Other files | Revisions, decision table | Unchanged |
| A device's durable state | The journal (IndexedDB) | The journal, which also holds each note's CRDT state |

The CRDT library is `yjs`, with `y-protocols` for sync and awareness messages and `y-codemirror.next` for the editor binding. The server never parses CRDT data, in every vault type. Nothing in Yjs is written by hand.

Principle 2 (one source of truth per concern) holds. The update log is the only source of a note's content. Checkpoints are derived from it in one direction only, like a cache, and no rule ever reads a checkpoint back into the CRDT except a user's restore (§7), which is an edit.

## 4. Server

### 4.1 Storage

```
note_updates   (document_id, seq, update_ref, size, device_id, epoch, created_at)
               -- seq is per document, gapless, assigned by the server
note_snapshots (document_id, upto_seq, snapshot_ref, device_id, epoch, created_at)
documents.kind -- `yjs` for a converted note (the value exists already)
```

- An update or a snapshot is opaque bytes. A small one is stored inline in PostgreSQL. A large one is stored in S3 like a blob and referenced.
- The log holds every update after the newest snapshot. Older updates and snapshots are purged by retention (§7), never while a device can still need them (§4.3).

### 4.2 API

- `AppendNoteUpdates(document_id, updates[])`: appends in order and returns their `seq` values. It is idempotent by a client-chosen `update_id`, so a retry after a lost reply does not append twice (the CRDT would ignore a duplicate anyway, but the log stays tidy). Each request stays under the WAF's 1 MiB limit, and a larger update is uploaded first like a blob chunk.
- `ListNoteUpdates(document_id, after_seq)`: returns the newest snapshot if `after_seq` is older than it, then the updates after it, paginated.
- `PutNoteSnapshot(document_id, upto_seq, snapshot)`: compare-and-set on `upto_seq` (§4.3).
- Realtime: the existing WebSocket gets two frames. `note_update{document_id, seq, update}` is sent after an append, so open editors receive typing at once. `awareness{document_id, payload}` carries cursors and is never stored. `vault_changed` also fires for appends, so devices without the note open fetch updates on their next pull.
- Every call resolves the caller's role first. A viewer cannot append. Sizes and rates are bounded (principle 4).

### 4.3 Compaction

- Any editing client can compact: it encodes its full state (`Y.encodeStateAsUpdate`) after it has applied every update up to `upto_seq`, and sends it with `PutNoteSnapshot`. The server accepts it only if `upto_seq` is newer than the current snapshot's.
- A client compacts after about 1,000 updates or 1 MiB of log since the last snapshot.
- The server deletes updates covered by a snapshot only after the retention window for history, so a device that fetches an old range still gets updates, or the snapshot that covers them.
- The server cannot check a snapshot in an encrypted vault. A member who writes a false snapshot can damage a note. A member can already damage a note by editing it, and the older updates and checkpoints stay until retention purges them, so an owner can restore.

## 5. Client

### 5.1 State per note

The journal keeps, for each CRDT note:

- the CRDT state (the updates the device holds, compacted locally), and the last `seq` it fetched;
- `pending_updates`: local updates not yet acknowledged by an append, each with its `update_id`;
- `projected`: the text that the device last wrote to the file, or last read from it, with its hash.

The device writes `pending_updates` to the journal in the same IndexedDB transaction that applies a local edit, so a crash never loses an acknowledged keystroke on the device. Updates are sent in batches of about 100 ms while someone types.

### 5.2 Files are a projection

- **CRDT to file.** When the note's CRDT text differs from `projected`, the device writes the text to the file (engine §8: a temporary file and a rename, or Obsidian's save for an open file) and sets `projected` to it.
- **File to CRDT.** When the file differs from `projected` (a vault event, or the startup scan), something outside the CRDT changed it: another plugin, an external editor, git. The device diffs `projected` against the new file text with `diff-match-patch` and applies the difference to the CRDT as its own edits. Then `projected` is the file text.
- The base of that diff is exact, because `projected` is the text that this device itself last wrote or read. No other device's text is involved. That is the difference from the first Phase 5 design, where several devices merged texts against bases that were sometimes stale.
- If the CRDT changed between the device's last write and an outside change of the file, the device merges three ways: base = `projected`, local = the CRDT text, remote = the file. It applies the difference between the CRDT text and the merged text. That merge is local and keeps both sides. A conflict, where both changed the same place, keeps both versions in the note, one after the other with no markers, because no text is ever dropped and there is no other device to resolve it.

### 5.3 The editor

- An open note's editor is bound to the CRDT text with `y-codemirror.next`. Typing becomes CRDT edits directly. Remote updates change the editor directly.
- Obsidian saves the editor to the file. The device recognizes that save as its own projection, because the file then equals the CRDT text.
- Undo with `Y.UndoManager` undoes only the user's own typing. Remote updates, outside edits and restores use origins that undo does not track.

### 5.4 Conversion

A vault's existing notes are `TEXT` documents. Each is converted to a CRDT note once, when the vault uses CRDT notes (§10):

- The converting device seeds a Yjs document from the head revision's text. The client id of that first insertion is derived from the document id, the revision id and a hash of the text, so two devices that convert the same revision produce identical items, and Yjs treats them as one insertion.
- The server records the conversion with a compare-and-set on `documents.kind`, naming the seed revision. A device that converts from another revision loses the compare-and-set, discards its seed, and fetches the winner's.
- So conversion needs no lease, and a race cannot duplicate text.
- A local edit that a device made before it learned of the conversion is a pending text edit. The device converts it the same way as an outside change: a diff from its base revision's text to its file, applied as its own CRDT edits after it has the seed.

## 6. Paths, deletes and the engine

- A note's path and its existence stay in revisions under the engine's rules: a rename is a path-only revision, a delete is a tombstone, and rule W handles name collisions. A checkpoint revision never changes the path.
- An update appended after a tombstone means someone edited a deleted note. Like engine row A7, the edit wins: the device that appended it re-creates the note with a revision based on the tombstone.
- The engine's decision table drops rule M for CRDT notes. The rows that decide content (A3, A6 and the content half of A8 to A10) do not apply to them, because their content never comes from a revision. The path and existence rows stay. This is a narrow change to engine §5, and the table tests change with it.

## 7. History, restore, retention and export

- **Checkpoints.** A device that edited a note commits a checkpoint revision when the note has been quiet for about 10 seconds, and before the app goes to the background or quits. The checkpoint's content is the CRDT text. It carries the `upto_seq` that it renders, and the server records which users and devices appended updates since the previous checkpoint, so history keeps showing who changed the note (P3-02).
- A checkpoint commit uses the head as its base. If it is refused because another device checkpointed first, the device drops its checkpoint: it is derived data and needs no merge.
- **History** shows checkpoints, as today.
- **Restore** is an edit: the device diffs the current CRDT text against the old checkpoint's text and applies the difference as its own CRDT edits. Then it checkpoints. Others see the restore live.
- **Retention** applies to checkpoints exactly as to revisions today. Updates and snapshots are purged with the checkpoints that cover them.
- **Export** reads the head checkpoint, as today. It is as current as the newest checkpoint. While any editing device is online, that is at most a few seconds behind. Edits made on a device that went offline before checkpointing reach the export after that device next syncs. The export job never parses CRDT data.
- **Import** creates `TEXT` notes, which are converted like any other note.

## 8. Encryption

- In an encrypted vault, each update and each snapshot is sealed with `subkey(epoch_key, "note-update")` and associated data that binds the vault, the document, the epoch, the device and the `update_id` (or `upto_seq` for a snapshot). These need new cross-language vectors.
- Awareness payloads are sealed the same way with their own label.
- The server orders and stores opaque bytes. It can withhold, delay or replay updates. Replays are harmless, because the CRDT ignores an update it already holds. It cannot forge or change one.
- A member's removal rotates the epoch key, as today. Updates after the rotation use the new key.

## 9. Why this converges

1. **One merge for note content.** Only the CRDT merges note content between devices. Yjs merges are commutative and idempotent, so devices that hold the same set of updates hold the same text, whatever the order or the repetition.
2. **The server is an ordered, append-only log.** Every acknowledged update is in it until retention, so every device can fetch every update. A device re-sends its pending updates until they are acknowledged.
3. **Text enters the CRDT only on one device, against an exact base:** an outside change of the file against `projected` (§5.2), a restore against the current text (§7), and conversion from a revision that the server fixes (§5.4). No rule merges another device's text into the CRDT.
4. **Text leaves the CRDT only one way:** to the file and to checkpoints. Neither is read back except by the rules in point 3.
5. **Paths keep the engine's convergence argument** (engine §11), because paths and existence still follow its rows.

A server restore below a device's `seq` needs no special case. The device re-sends the updates it holds that the restored server lacks, and the CRDT absorbs them.

## 10. Rollout

- **A vault-level switch.** An owner turns on CRDT notes for a vault after every member's devices run a plugin that supports them. Devices report their plugin version when they register (a new field: registration does not record it today), and the server refuses the switch otherwise, like the encryption conversion (`SPEC.md` §9.3). New vaults can default to it (§13).
- After the switch, the server refuses a text-content commit to a CRDT note from an older plugin with a clear reason, so an old device shows "update the plugin" instead of losing edits.
- Notes convert lazily, the first time a device syncs or opens them after the switch. So a vault of thousands of notes does not convert at once.
- **Memory.** A device loads a note's CRDT only when the note changes or opens. A vault of thousands of notes keeps their states in the journal, not in memory.

## 11. What changes for users

- Several people can edit an open note at once, with cursors and names.
- Notes never get conflict copies. Other files still can.
- History, restore, export and import look the same.
- All devices in a vault need the new plugin before the owner turns the switch on.

## 12. Draft acceptance checklist

These scenarios are a starting point for the owner. They are not approved, and only the owner sets the real list.

1. Two people with the same note open see each other's typing within 2 seconds, and both files and the head checkpoint end with the same text.
2. Two people type at once in the same line and in different lines: no duplicated text, no conflict copy.
3. Each person sees the others' cursors and names, and who has the note open. They disappear within 30 seconds of a close or a lost connection.
4. A device edits a note offline for an hour while others edit it online. When it reconnects, every edit is in the note, with no conflict copy.
5. The app is killed just after typing. After a restart, every typed character that Obsidian or the plugin had stored is in the note on every device.
6. Another plugin or an external editor changes a note on one device: the change reaches every device, once.
7. Turning on CRDT notes for a vault converts its notes without duplicating any text, even when two devices convert at once. It is refused while a member's device runs an older plugin.
8. History shows checkpoints with the users and devices who edited. Restoring a checkpoint works while others edit.
9. The export holds every note's text as of its newest checkpoint.
10. A viewer sees live edits and cursors and cannot change a note, even with a modified client.
11. In an encrypted vault, the server's database, logs and relayed frames hold no note text, cursor position or path.
12. Renaming or deleting a note while others edit it behaves as today: a rename moves it for everyone, and an edit wins over a delete.
13. Live editing works in Obsidian's mobile mode and between mobile and desktop.
14. A server restore loses no edit that a device still holds.

## 13. Open questions for the owner

- Should new vaults use CRDT notes by default, or should every vault need the switch?
- Is an export that is current to the newest checkpoint enough, or must the server read the log itself? That would need a CRDT runtime in Go, such as the Rust `yrs` library compiled to WebAssembly, in plaintext and escrowed vaults only.
- Is it acceptable that notes stop getting conflict copies, which differs from Obsidian Sync?

## 14. Cost and risk

- The work covers a new server log and API, conversion, the client projection, the editor binding, checkpoints, encryption, rollout and the engine change. It is comparable in size to Phase 4, which was about 95 issues, and larger than the session design it replaces.
- The main risks are in the projection (§5.2): Obsidian's handling of an open editor when the file changes on disk, and mobile apps being suspended between a keystroke and its journal write. Both need e2e tests early.
- The first Phase 5 design and its two reviews (#1496) are in git history and on that issue. Their seeding rule and their encryption bindings carry over to this design.
