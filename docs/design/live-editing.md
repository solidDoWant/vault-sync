# Live editing design

For: developers and agents. You know `SPEC.md`, the engine design (`docs/design/engine.md`) and the encryption design (`docs/design/encryption.md`, `docs/design/crypto.md`).

Status: approved by the owner on 2026-11-02 (the model and its goals). Revision 2 answered the first design review with three structural rules (§2): one fenced writer, one rule for bases, and a closed list of transitions. Revision 3 answers the second review: the hand-off between a session and file sync is now a `held` state of the engine, with its own rows in the decision table and two defined transitions (§5). The earlier `SPEC.md` §10 plan (permanent Yjs documents, a conversion lease, a server update log and compaction) is replaced.

Agents implement this design. They do not change it. If it does not decide a case, ask on the issue. Every answer must keep the invariants in §2 true.

## 1. Goals

- **Live co-editing of open notes.** When two or more devices have the same Markdown note open, each person sees the edits of the others within about a second.
- **Presence.** Each person sees the cursors and selections of the others, with the user's name and a color, and who else has the note open.
- **Desktop and Android.** Live editing works on every platform that the plugin supports.
- **Encrypted vaults too.** In an encrypted vault, the server relays only ciphertext.
- **Nothing new to store or back up.** The note is saved through the revision log, as today. History, conflicts, export, retention and restore do not change.

### Outcomes

The design promises two levels of outcome. Tests hold it to both.

| Situation | Promise |
|---|---|
| Normal operation: devices join, edit, leave, and outside edits arrive, with no crash, no outage longer than 30 seconds and no room replacement | No text is lost or duplicated, and nobody gets a conflict copy for edits made in the session. |
| A failure: an app is killed, a device is offline for longer than 30 seconds, or a room is replaced | No text is lost. The note can get one conflict copy per device that failed, from file sync's merge. |

Duplicated text outside a failure, or lost text in any case, is a defect. A conflict copy after a failure is not.

### Reference behavior

The reference is a shared document in Google Docs, or the Relay plugin for Obsidian, while the document is open. A note that is not open on two devices syncs as today, within a few seconds.

### Not planned

- Live editing of files other than Markdown notes (`TEXT` documents), and of notes larger than 512 KiB.
- A live view of a note that is not open in an editor.
- Per-character authorship ("who typed this"). History shows who saved each revision, as today.
- Comments, suggestions, or a "follow this user" mode.
- Undo of another person's edits. Undo only undoes your own edits.
- Live editing with devices that run plugin or server versions without live editing. Those devices keep file sync.
- Live editing while the server is unreachable for longer than 30 seconds. Such a device falls back to file sync (§5.6).

## 2. Model and invariants

A **live session** is the set of devices that have the same note open in an editor at the same time. A **participant** is one device in a session.

- Each participant keeps the note as a Yjs document in memory. Yjs is a library that merges concurrent edits without conflicts (a CRDT, or conflict-free replicated data type).
- The server relays Yjs messages between the participants. It never parses them, and it stores no update and no snapshot.
- The revision log stays the only durable copy of the note (principle 2).
- Text moves between two worlds: the Yjs document, where edits have identities, and files and revisions, where only text exists. Every bug class in the first review came from a crossing between the two. So the design allows only the crossings below, each with one owner.

Three invariants hold at all times:

- **I1, one bridge.** Only the **writer** of a room moves text from revisions into the Yjs document (absorbing, §5.4) or from the Yjs document into revisions (committing, §5.3). The server grants the writer role and fences it with a token (§4). A device that is not the current writer never does either.
- **I2, bases follow the disk.** A device's journal base for a note (engine §2) is always a revision whose text the file on disk contains. While a note is held, the base moves forward only after Obsidian saved a file that holds that revision's edits (§5.5), and a rename or a pulled revision never moves it. A base can lag behind. It is never ahead. When the note stops being held, the engine applies the note's head against that base (§5.6), so a lagging base always resolves.
- **I3, holds are complete.** A device binds its editor to a room, or commits from it, only when its document holds the room's latest mark (§5.2). "Holds" compares Yjs snapshots, which include deletions, not only state vectors.

Every way a session ends (a clean leave, a crash, an outage, a room replacement, a removal) leaves each edit in a room revision or in a file whose base is not ahead of it (I2). File sync then merges it (engine §5, rule M), and its merge never loses text. That is the argument for the no-loss promise. I1 and I3 are the argument for the no-duplication promise in normal operation: the only crossings into the Yjs document are seeding (§3) and absorbing (§5.4), and each happens exactly once per revision because one fenced writer does it.

Libraries, all maintained and widely used:

| Need | Library |
|---|---|
| CRDT text, snapshots, delete sets | `yjs` |
| Sync and awareness messages | `y-protocols` (`sync`, `awareness`) |
| Editor binding and undo | `y-codemirror.next` (Obsidian's editor is CodeMirror 6) |
| Character diff, to apply an absorbed text to the Yjs text | `diff-match-patch` (already a dependency) |
| Three-way merge | the engine's existing text merge (`plugin/src/core/merge/text-merge.ts`) |
| Encryption | `@noble/ciphers`, `@noble/hashes`, with the existing `subkey` construction (§8) |

No part of Yjs, its sync protocol, its encoding or the merge is written by hand.

## 3. Rooms

A **room** is the server's record of one live session. PostgreSQL holds it. No row holds note content.

```
live_rooms        (document_id PK, room_id, seed_rev_id, latest_mark_rev_id,
                   writer_device_id, writer_token, created_at)
live_participants (room_id, device_id, user_id, read_only, replica_id,
                   last_seen, PRIMARY KEY (room_id, device_id))
```

- **Heartbeat.** Each replica sets `last_seen = now()` (the database clock) every 10 seconds for the participants whose socket is connected to it, and stops when the socket closes. A participant whose `last_seen` is older than 45 seconds is **expired**. So a participant expires at least 35 seconds after its socket closed, after the client's 30-second short-disconnection window (§5.6). The join transaction treats expired rows as absent.
- **Create.** When a device joins a document that has no room, the server inserts one: a new random `room_id`, `seed_rev_id` = the document's head, `latest_mark_rev_id` = the seed.
- **Delete.** When the last participant leaves or expires, the server deletes the room in the same transaction. So a room never outlives its participants by more than 30 seconds, and the next open of the note creates a fresh room from the head.
- **Replace.** The server never replaces a room that has a live participant. A room is only deleted (above) and created again.
- **Serialization.** Every change of a room (create, delete, join, leave, expiry, writer change, commit with a mark) runs in one transaction that locks the `live_rooms` row. So any two changes happen in some order, and the tables in §6 only have to consider orders.
- **Expiry sweep.** Every replica runs a sweep every 10 seconds. It locks rooms with `FOR UPDATE SKIP LOCKED`, removes expired participants, moves the writer role (§4) and deletes empty rooms. The sweep is bounded per run, like the retention jobs.
- **Ending.** Whenever a room is deleted, or a participant is removed from it, the server queues `NOTIFY live` with `live_ended{room_id, device_id?, reason}` in the same transaction. Every replica delivers it to its affected participants.

### Seeding without duplicated text

Two Yjs documents that each insert the same text separately hold that text twice when they merge. Every participant therefore builds the starting state of the room in the same way:

1. It reads the content of the seed revision (from its journal if the hash matches, otherwise with `GetRevision`). It normalizes line endings to LF.
2. It makes a Yjs document whose client id is the first 4 bytes, as an unsigned integer, of SHA-256(`room_id` || `seed_rev_id` || SHA-256(seed text)). It inserts the seed text in one operation, under the origin `seed`.
3. It encodes that state and applies it to its session document. Its own edits use a fresh random client id. A session document is never rebuilt under a client id it used before.

Every participant produces the same item ids for the seed, so Yjs treats them as one insertion. Participants that were given different seeds get different client ids, and `seed_rev_id` is in the associated data (§8), so they cannot open each other's frames. They never corrupt each other.

## 4. The writer

- The server picks the writer: the participant that may edit (not `read_only`) and joined first, among the participants that have not expired. It records `writer_device_id` and increments `writer_token` in the room's transaction.
- The server moves the role when the writer leaves or expires, or when no writer exists and an editing participant joins. It sends `live_writer{room_id, device_id, token}` to every participant, and `live_joined` names the current writer, so a device that rejoins after a disconnection learns a change it missed.
- A device acts as the writer only while the newest `live_writer` that it received names it. It sends its token with every commit.
- `CommitRevision` with a `live_mark` locks the room row and checks that the room is the document's current room and that the token is the current `writer_token`. Otherwise it refuses with `FAILED_PRECONDITION` and the reason `ERROR_REASON_LIVE_NOT_WRITER`. A device that gets this reason stops acting as the writer at once and never retries the commit. Its edits are still in its document, and the current writer commits them (§5.3).
- So at most one device's mark commit can succeed for each token, and absorbing (§5.4) happens exactly once per outside revision.

## 5. Life of a participant

A note in a session is **held**. Held is a local state of the engine, with its own rows in the decision table (`docs/design/engine.md` §5, *Held notes*). The device enters and leaves it only through the two transitions below, and both run under the engine's cycle lock, so no sync cycle runs in the middle of one.

The journal entry of a held note (`docs[d]`) gets two fields:

- `held`: the `room_id`, written when the note becomes held and cleared when it stops being held. It survives a crash, so a restart knows which notes were held.
- `seen_rev_id`: the newest revision of the note that this device pulled or committed. For a note that is not held, it equals `base_rev_id`. For a held note, `base_rev_id` can lag behind it (I2).

### 5.1 Enter held (join)

A device joins when it opens a `TEXT` note of at most 512 KiB in an editor (desktop or mobile, source or live preview mode) in a subscribed vault, or when the socket comes back while such a note is open.

1. **Freeze the editor.** The editor becomes read-only with a short "Connecting" notice. Then the device saves the editor to disk (Obsidian's save) and runs local-change detection (engine §4) on the note. So every keystroke is on disk and in `pending` before anything else happens.
2. **Settle.** If an operation is pending for the note, the device runs sync cycles until nothing is pending for it.
3. **Hold.** Inside the same cycle lock that ended the settle, the device sends `live_join` and writes `held`. From then on the engine applies the held rows to the note.
4. **Join.** The server checks the caller's role (§9) and answers `live_joined{room_id, seed_rev_id, latest_mark_rev_id, writer_device_id, writer_token, read_only, rejoined}`.
5. **Seed and sync.** The device builds the seed state (§3). It sends a sync step 1 addressed to the writer, or to the earliest participant if the room has no writer. That device answers with a sync step 2 addressed to the joiner alone.
6. **Wait until complete.** The device fetches the mark of `latest_mark_rev_id` (`GetRevision` returns it; for a new room the seed state is the first mark, §5.2). It waits until its document holds that mark (I3) and until the latest mark is the journal's `base_rev_id` or a later revision, read at this moment. If the base is newer (an outside revision, or this device's own push in step 2), the writer absorbs it (§5.4), which makes a newer mark.
7. **Bind.** It replaces the editor text with the document text in one editor transaction, binds the editor with `y-codemirror.next`, and makes the editor writable.

If steps 1 to 7 take longer than 10 seconds, or any step fails, the device runs *Leave held* (§5.6) without the wait, and the editor becomes writable under file sync. It tries again the next time the note is opened or the socket comes back.

### 5.2 Marks

A writer commits the text of its session document, not the file on disk. It takes the text and a Yjs snapshot (`Y.snapshot`: the state vector and the delete set) of its document at the same moment. Then it calls `CommitRevision` with that text, the head's current path, and the optional field `live_mark{room_id, writer_token, epoch, state}`, where `state` is the encoded snapshot (`Y.encodeSnapshotV2`), sealed in an encrypted vault (§8).

- The server stores the mark with the revision, and sets the room's `latest_mark_rev_id`, in the same transaction.
- A revision with a mark is a **room revision** of that room. It is a normal revision in every other way. `ListChanges`, `GetRevision` and `GetDocumentHistory` return the mark.
- The seed's state (§3) is the room's first mark. No revision carries it, and every participant computes it.
- A document **holds** a mark when every item in the mark's state vector is in the document and every deletion in its delete set is applied (`Y.isDeleted`).
- A mark that cannot be opened (for example, its epoch was retired after the re-key job moved the revision) is treated as absent: the revision counts as an outside revision.
- A mark is at most 64 KiB. If a writer's snapshot is larger (a very long session with many deletions), it commits once more without a mark and ends the room: it sends `live_leave` with `close_room`, and the server deletes the room and sends `live_ended{too_large}`. Every participant runs *Leave held*, and the next open creates a fresh room from the head.

### 5.3 Committing

- The writer commits at most 2 seconds after the first change that its last commit does not cover (a throttle, not a debounce), whenever its document differs from the head's mark: after local typing, remote updates, a refused commit, and once more before it leaves. The rule ends, because each commit covers more of a finite document.
- It commits with `base` = the head. Before that, its document must hold the head's mark (I3). If the head is an outside revision, it absorbs it first (§5.4).
- **Becoming the writer.** A device that becomes the writer lists the note's revisions newer than the room's latest mark (`GetDocumentHistory`, newest first, until the latest mark) and absorbs every outside revision among them, oldest first, before its first commit.
- Answers to a mark commit:
  - `FAILED_PRECONDITION` without a live reason (the head moved): pull, then apply the rules above.
  - `ERROR_REASON_LIVE_NOT_WRITER`: stop acting as the writer at once and never retry (§4).
  - `EPOCH_NOT_CURRENT` or `VAULT_ENCRYPTED`: re-seal and retry, as the engine does (`encryption.md`, interaction matrix).
  - `PERMISSION_DENIED` (the device was demoted): stop acting as the writer. The server already removed it (§6.1).
  - `ALREADY_EXISTS` on a re-create after a tombstone (another document took the path): re-create the note under a conflict-copy name (engine rule C) and continue the session there.
  - Any other error: keep the commit, back off as the engine does, and show the error in the status.
- If the text exceeds 512 KiB, the writer commits once and ends the room as for an oversized mark (§5.2).

### 5.4 Absorbing outside revisions

An **outside revision** is a revision of the note that is not a room revision of the current room, or a room revision of the current room whose mark the writer cannot hold (its updates died with an earlier writer: the writer waits 10 seconds of sync for them first). Examples: an edit on a device where the note is not open, a device with an older plugin, a restore from history on any device that is not a participant, or a file-sync fallback after a failure.

The writer absorbs each outside revision `R`, in `seq` order:

1. **Base.** The base text is the text of `R`'s parent revision `P` (the head that `R` was committed on) if `P` is a room revision of this room whose mark the document holds, the room's seed, or an outside revision that this writer already absorbed. Otherwise the base is the newest room revision of this room whose mark the document holds, or the seed.
2. **Merge in a copy.** The writer copies its document into a scratch Yjs document. It merges three ways in text with the engine's text merge: the base, local = the scratch text, remote = `R`'s text (LF-normalized). It applies the difference between the scratch text and the merged text to the scratch document with `diff-match-patch`, under a fresh random client id and the origin `absorb`.
3. **Commit first.** It commits the merged text based on `R`, with the scratch document's snapshot as the mark.
4. **Then broadcast.** Only if the commit succeeds does it apply the scratch update to its session document and broadcast it. If the commit is refused, it drops the scratch document, pulls, and starts again from the new head.
5. **Conflict.** If the merge conflicts, the session text stays. The writer commits the session text based on `R`, with a mark. Only after that commit succeeds does it record a pending create of a conflict copy holding `R`'s text (engine rule C), and push it. A crash between the two loses no text, because `R` stays in the note's history. This differs from engine rule M, which keeps the remote side at the path, because people are typing in the session text. A restore from history on a non-participant follows the same rule.

A restore on a participant is a local edit: the plugin replaces the editor text with the restored text, and the change flows through Yjs.

### 5.5 Held notes and bases

While a note is held, the engine applies the held rows (engine §5, *Held notes*). In short:

- **Content.** Changes of the file's content create no pending operation, and the engine writes no pulled content to the file. Obsidian saves the editor, and the writer absorbs pulled revisions.
- **Path.** A rename made on this device is a pending operation. It commits a path-only revision based on `seen_rev_id`, reusing that revision's content reference (`encryption.md` *One epoch per revision*), and retries on the new `seen_rev_id` after `FAILED_PRECONDITION`. A pulled revision with a new path moves the file (rule W). In both cases only `path` changes in the journal, never `base_rev_id` or `base_hash`.
- **Tombstones.** A pulled tombstone keeps the file, pushes nothing and leaves the journal unchanged. Only the writer acts on it: it re-creates the note from the session text, based on the tombstone, with a mark (§6.1).
- **Every pulled or committed revision** of the note sets `seen_rev_id`.
- **Moving the base (I2).** After each save of the note by Obsidian, the device reads the file. If it equals the document text, it sets `base_rev_id` to the newest room revision of this room whose mark the document held at that moment, with that revision's content hash. Otherwise the base stays.

### 5.6 Leave held

A device leaves when the note closes in its last editor, when the app goes to the background on mobile, on `live_ended`, when a short disconnection runs out (below), or when a join fails. Leave held always runs these steps, under the cycle lock:

1. **Unbind.** The device destroys the editor binding and stops sending. If the editor is still open (mobile background, a failed join, a disconnection), it saves the editor to disk and makes it read-only until step 5. From now on no write to the file can reach the document.
2. **Target.** It takes the snapshot `T` of its document at this moment.
3. **Wait** (clean leave only: a close, a background move, or `close_room`). If this device is the writer, it commits `T` with a mark. Otherwise it waits up to 5 seconds until the head is a room revision of this room whose mark covers `T`. A viewer waits the same way.
4. **Settle the file.**
   - If the user deleted the note, the device commits its tombstone based on `seen_rev_id`, the newest revision it saw, and writes nothing back. If the commit is refused because others kept editing, the normal rows apply, and an edit wins over a delete (engine row A8). Their writer also re-creates the note from the session (§6.1).
   - Else, if the wait succeeded, the device writes the head's text to the file as the engine's own write, and sets `base_rev_id = seen_rev_id = head`.
   - Otherwise (no wait, a timeout, or a crash recovered at startup), it fetches the note's head (`GetDocumentHistory`, newest entry) and applies it to the note as a pulled revision against the journal base, with the normal rows (engine rows A3 and A5 to A10). A file that equals the base takes the head (A3). A file that differs merges three ways (A6), which keeps every edit and at most makes one conflict copy.
5. **Release.** It clears `held`, sends `live_leave` (if the socket is up), and makes the editor writable under file sync.

**Short disconnection.** If the socket closes while the app keeps running, the device does not leave at once. It keeps the note held, keeps its document, and lets the user keep typing, for up to 30 seconds. When the socket is back, it joins again. If `live_joined` returns the same `room_id` with `rejoined = true`, it sends a sync step 1, and so do the others, which fills both gaps. Otherwise, or after 30 seconds, it runs *Leave held* without the wait, then joins the current room fresh through *Enter held*.

**Crash.** A killed app loses the document, which is only in memory. At startup the engine finds `held` set on the note and runs *Leave held* from step 4, without the wait. If it was the writer, the server moves the role when it expires.

## 6. Interaction matrix

Every change of a room is serialized (§3), and the enter and leave transitions are serialized with sync cycles by the cycle lock (§5). So the matrix lists each change against each state of a participant. "Covered" names the acceptance scenario or the test, named after the row, that covers it. The held rows of the engine's decision table have their own table tests (engine §5).

### 6.1 Changes against a bound participant

| Change | Result | Covered |
|---|---|---|
| Another device joins | The joiner seeds from the same revision with the same client id and gets the state from the writer's step 2. | P5-02 |
| A participant leaves cleanly | Its edits are in a room revision (§5.6 step 3). Its awareness entry goes on `live_left`. | P5-01, P5-07 |
| A participant expires | The server removes it and sends `live_left`. If it was the writer, the role moves. | P5-09 |
| The writer role moves to this device | It absorbs the outside revisions since the latest mark, then commits by §5.3. | Core test |
| An outside revision is committed | The writer absorbs it once (§5.4). Others receive the edits through Yjs. | P5-05 |
| A tombstone is committed on another device | Held tombstone row: no device deletes its file. The writer re-creates the note from the session text, based on the tombstone. The session continues. A join in between is refused with `ERROR_REASON_LIVE_DOCUMENT_DELETED` and retried. | P5-13 |
| A rename is committed on another device | Held rename row: each device moves its file and changes only the journal path. The session continues. | P5-13 |
| The user renames the note on this device | A path-only commit based on `seen_rev_id` (§5.5). The base does not move. | P5-13 |
| A member is removed | The server removes the participant and sends `live_ended{removed}`. The device runs *Leave held* without the wait. File sync then finds the device is no longer a member (`SPEC.md` §9.2). | P5-14 |
| A member is demoted to viewer | The server removes the participant and sends `live_ended{demoted}`. The device runs *Leave held* without the wait. Its unsaved edits follow file sync, which refuses a viewer's commit and keeps a local copy. It may then join again as a viewer. | P5-12 |
| The vault key rotates | New frames use the new epoch. Frames under the previous epoch are accepted for 10 minutes after the receiver learned the new one. | P5-15 |
| The room's mark or text grows too large | The writer ends the room (§5.2). Every participant runs *Leave held* without the wait. | Core test |
| A server restore below the latest mark | Sockets close during the restore. The join transaction treats expired participant rows as absent, and the sweep deletes the restored rooms. Each device runs *Leave held* without the wait, then the engine's resync (engine §9). | Core test |

### 6.2 Changes against a joining device (Enter held)

| Change | Result | Covered |
|---|---|---|
| The user was typing when the join started (a reconnect, a retry) | Step 1 saves the editor and detects the change, and step 2 pushes it, before anything is bound. | P5-08 |
| An outside revision is pulled before step 3 | The engine applies it with the normal rows (the note is not held yet), so the file and the base move together. | P5-05 |
| An outside revision is pulled after step 3 | Held rows: nothing is written. The writer absorbs it, and step 6 waits for the newer mark. | P5-05 |
| Another device joins at the same moment | One transaction creates the room and the other joins it. Both seed from the same revision. | P5-02 |
| The only other participant expires | The joiner becomes the writer if it may edit. If its document cannot hold the latest mark, it leaves after 10 seconds. | Core test |
| The join takes longer than 10 seconds | *Leave held* without the wait. Nothing was typed after step 1, because the editor was read-only. | Core test |

### 6.3 Changes against the writer during a commit or an absorb

| Change | Result | Covered |
|---|---|---|
| Another commit lands first | `FAILED_PRECONDITION`. The writer pulls. A room revision with a newer token cannot exist while it holds the role. An outside revision is absorbed. | P5-05 |
| The writer role moves away (it expired in the server's view) | `ERROR_REASON_LIVE_NOT_WRITER`. It drops the scratch document, so nothing is broadcast twice. The new writer commits the document. | Core test |
| The device crashes after the commit, before broadcasting the absorb | The new writer cannot hold that room revision's mark, so after 10 seconds it absorbs it as an outside revision (§5.4). The text arrives once. | Core test |
| The device crashes before the commit | Nothing was committed or broadcast. The new writer absorbs the outside revision. | Core test |
| The conflict branch is refused | The pending conflict copy was not recorded yet (§5.4 step 5), so no second copy appears on the retry. | Core test |

### 6.4 Changes against a leaving or disconnected device

| Change | Result | Covered |
|---|---|---|
| Clean leave while another person keeps typing | The target is the snapshot at unbind. The writer's throttle commits within 2 seconds, and the wait ends. The device writes the head and sets base = head. No conflict copy. | P5-01 |
| Clean leave on mobile with the editor still open | The binding is destroyed before the file is written, so the write does not reach the document. | P5-11 |
| Clean leave by deleting the note | No text is written back. The tombstone is based on `seen_rev_id`. | P5-13 |
| A viewer leaves | Same as a clean leave. Its file then equals its base, so no local copy is made. | P5-12 |
| Disconnection under 30 seconds | It rejoins the same room (`rejoined = true`) and the step 1 messages fill the gaps. `live_joined` names the current writer. No text is duplicated, because the document was kept and the note stayed held. | P5-08 |
| Disconnection over 30 seconds | *Leave held* without the wait. The head is applied against the base. One conflict copy at most. Then *Enter held* again. | P5-08 |
| App killed | At startup, *Leave held* from step 4. | P5-09 |
| A replica stops | Short disconnection on every participant of that replica, which reconnect to another replica. The room is in PostgreSQL. | P5-10 |

### 6.5 Edits that do not come through Yjs

| Edit | Result | Covered |
|---|---|---|
| Another plugin (`processFrontMatter`) or an external editor changes the file on a participant | The binding turns the editor change into this participant's own Yjs edits. This relies on Obsidian merging a change on disk into an open editor that holds unsaved remote text. The first editor-binding task checks this with an e2e test, with remote text arriving in the 2 seconds before the change. If Obsidian replaces the buffer instead, the plugin applies the change itself: a three-way merge of the last saved text, the document text and the new file, applied to the document as its own edits. | P5-06 |
| The same change made by a plugin on every participant at once (for example, a "last modified" field) | Each change becomes separate Yjs edits, so the text can hold the change twice. Nothing is lost. A known limit, listed in the user docs (P5-17). | User docs |
| A device without live editing, or with the note closed, edits the note | An outside revision, absorbed once. | P5-05 |
| A restore from history on a non-participant | An outside revision. If the session changed the same lines, the restored text becomes a conflict copy. | P5-03 |
| A restore from history on a participant | A local edit through Yjs. | P5-03 |

A case outside these tables is a design gap. Ask on the issue.

## 7. Protocol

The live frames use field numbers 100 to 199 of `ClientFrame` and `ServerFrame` (`proto/vaultsync/v1/realtime.proto`). The proto change assigns the numbers.

| Direction | Frame | Purpose |
|---|---|---|
| Client to server | `live_join{vault_id, document_id}` | Join or create the room of a document. |
| Server to client | `live_joined{vault_id, document_id, room_id, seed_rev_id, latest_mark_rev_id, writer_device_id, writer_token, read_only, rejoined}` | The room to use. `rejoined` is true when the device was still a participant. |
| Client to server | `live_leave{room_id, close_room}` | Leave. `close_room` (writer only) deletes the room (§5.2). |
| Both | `live_message{room_id, kind, epoch, message_id, part, parts, to_device_id?, payload}` | One Yjs message, split into parts. The server adds `sender_user_id` and `sender_device_id`. |
| Server to client | `live_writer{room_id, device_id, token}` | The current writer. |
| Server to client | `live_left{room_id, device_id}` | A participant left or expired. |
| Server to client | `live_ended{room_id, reason}` | This device's participation ended. Reasons: `removed`, `demoted`, `vault_deleted`, `too_large`. |
| Server to client | `live_error{document_id, room_id?, code, reason}` | A refused live request. It never affects the vault subscription, unlike `ErrorFrame` (`SPEC.md` §6.4). |

Rules:

- **Kinds.** `kind` is `sync_step1`, `sync_update` (step 2 and updates) or `awareness`. Receivers check that the decoded y-protocols message type matches `kind`, and drop a mismatch. The server refuses `sync_update` from a read-only participant (`live_error` with `PERMISSION_DENIED`). Receivers also drop `sync_update` from a sender that their member list shows as a viewer.
- **Parts.** A message is split into parts of at most 3 KiB of payload, so a sealed part with its envelope fits the realtime channel's 4 KiB frame limit. Parts are numbered from 0. A whole message is at most 1 MiB (so `parts` is at most 342). `message_id` is a random 64-bit value. Receivers reassemble per sender and `message_id`, and drop incomplete messages after 30 seconds.
- **Addressing.** A joiner's sync step 1 is addressed to the writer, or to the earliest participant if the room has no writer, and only that device answers. Every sync step 2 carries `to_device_id` = the device that sent the step 1, and the server relays it only there. The periodic step 1 (below) goes to every participant. Every other message goes to every other participant. Nothing goes back to the sender.
- **Senders.** The server relays a `live_message` only from a current participant of its `room_id`. Receivers drop a `sync_update` whose stamped sender is not an editing member in their member list.
- **Delivery.** Best effort. Yjs updates are idempotent and commutative, so lost or repeated messages do not corrupt a document. Every participant sends a sync step 1 every 15 seconds and after every reconnect.
- **Fan-out between replicas.** A replica publishes each relayed part with PostgreSQL `NOTIFY` on a `live` channel, and every replica `LISTEN`s on it on the connection that it uses for `vault_changed`. A 3 KiB part with its header is under the 8000-byte payload limit after base64. Room changes (§3) queue their notifications in their own transactions. Expected scale: a few rooms with a few participants each. The design does not target hundreds of concurrent rooms.
- **Membership.** The membership check before delivery (`SPEC.md` §6.4) is cached per room, and the cache is dropped by the `vault_changed` that removals and role changes already queue.
- **Awareness.** Awareness is the `y-protocols` awareness state: cursor, selection and color. It is never stored. Each participant sends only its own state, at most 5 times per second, and every 10 seconds while idle. A receiver binds one awareness client id to each stamped `sender_device_id` and drops entries for any other client id. On `live_left` it removes that device's state at once (`removeAwarenessStates`). A state that is not renewed for 25 seconds is removed. So presence disappears within 30 seconds of a close or a connection loss.
- **Names.** A receiver shows the name of the member whose `sender_user_id` the server stamped, from the member list, never a name from the payload.
- **Origins.** Seeding, absorbing and remote updates use the origins `seed`, `absorb` and `remote`, which the `Y.UndoManager` of `y-codemirror.next` does not track. Undo only undoes local typing.
- **Line endings.** Text enters Yjs with LF line endings. Files saved from a live session use LF.

## 8. Encryption

In an encrypted vault, the payload of every `live_message` part and the state of every mark are sealed:

```
live_key  = subkey(epoch_key, "live")
live_aad  = "vault-sync/v1/live" || vault_id (16) || document_id (16) || room_id (16)
            || seed_rev_id (16) || sender_user_id (16) || sender_device_id (16) || kind (1)
            || epoch (u64) || message_id (u64) || part (u32) || parts (u32)
mark_key  = subkey(epoch_key, "live-mark")
mark_aad  = "vault-sync/v1/live-mark" || vault_id (16) || document_id (16) || room_id (16)
            || revision_id (16) || epoch (u64)
sealed    = the sealed format of crypto.md
```

- `live` and `live-mark` are new `subkey` labels. They need cross-language vectors in `testdata/crypto/`.
- The sender seals with the newest epoch that it holds. `epoch` travels outside the ciphertext. A receiver that does not hold that epoch fetches it the usual way. A frame under the previous epoch is accepted for 10 minutes after the receiver learned the newer one, then refused.
- A frame whose stamped user, device, room, seed, kind, message id or part does not match its associated data fails to open and is dropped. So the server cannot splice parts, mix seeds, or pass one member's frame off as another's.
- Accepted limit: the writer fence (§4) relies on an honest server. A malicious server can grant two tokens, so that two writers absorb the same outside revision and duplicate its text. It cannot make text disappear without a trace, because every commit stays in history.
- Accepted limit: any holder of `live_key` (a member, or a removed member until the next rotation) can seal a frame under any device id if the server colludes. The rotation on removal (`SPEC.md` §9.2) bounds this, together with the 10-minute rule.
- A plaintext vault sends payloads unsealed.

What the server learns: which devices have which notes open and when, the size and timing of edits, and cursor activity. It learns no content, no cursor position and no path. This is accepted.

## 9. Authorization and bounds

- **Join.** The server resolves the caller's role in the vault before anything else. A non-member, a missing vault and a missing document get the same `live_error` `NOT_FOUND`. A document that is not `TEXT` gets `ERROR_REASON_LIVE_NOT_TEXT`. A tombstone gets `ERROR_REASON_LIVE_DOCUMENT_DELETED`. A note whose head content is over 512 KiB gets `ERROR_REASON_LIVE_TOO_LARGE`. A full room or too many rooms on the connection gets `ERROR_REASON_LIVE_LIMIT`. The plugin keeps file sync for that note and tries again when the note is opened again.
- **Viewers** join with `read_only = true` (§7, *Kinds*). A room that holds only viewers has no writer, so nobody absorbs outside revisions. A viewer in such a room that pulls an outside revision of the note runs *Leave held* and *Enter held* again. The room is deleted when its last viewer leaves, so they meet again in a fresh room seeded from the new head.
- **Membership changes.** See §6.1.
- **Commits with a mark.** See §4.
- **Bounds** (configurable, with defaults): 32 rooms per connection, 16 participants per room, 3 KiB of payload per part, 1 MiB per message, and live parts in their own token bucket of 200 parts per second with a burst of 400 per connection, and their own send queue of 512 parts per connection. Exceeding the inbound bucket closes the socket with `RESOURCE_EXHAUSTED`. A connection that cannot drain its live queue is closed as a slow client. The channel's existing bounds apply to the other frames.
- **Logs** never contain payloads, marks or paths.

## 10. Plugin structure

- `plugin/src/core/live/`: rooms, seeding, sync messages, awareness, parts, marks and snapshots, the writer, absorbing, held notes and the base rule, leaving, and sealing. It does not import `obsidian`. Core tests drive it with the in-memory server and an in-memory relay, one test per row of §6.
- `plugin/src/obsidian/live-editor.ts`: the editor binding (`y-codemirror.next`), the read-only join, the remote cursors and the list of people in the note.
- The engine gets one new input: the set of held document ids, with the writer's commit and absorb paths and the base rule of §5.5. This is a narrow change to `docs/design/engine.md` §4 and §5, approved with this page.
