# Live editing design

For: developers and agents. You know `SPEC.md`, the engine design (`docs/design/engine.md`) and the encryption design (`docs/design/encryption.md`, `docs/design/crypto.md`).

Status: approved by the owner on 2026-11-02 (the model and its goals). Revision 2, after the Phase 5 design review, answers its critical and high findings with three structural rules (§2): one fenced writer, one rule for bases, and a closed list of transitions. The earlier `SPEC.md` §10 plan (permanent Yjs documents, a conversion lease, a server update log and compaction) is replaced.

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
- **I2, bases follow the disk.** A device's journal base for a note (engine §2) is always a revision whose text the file on disk contains. While a note is in a session, the base moves forward only after Obsidian saved a file that holds that revision's edits (§5.5). A base can lag behind. It is never ahead.
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

- **Heartbeat.** Each replica sets `last_seen = now()` (the database clock) every 10 seconds for the participants connected to it. A participant whose `last_seen` is older than 30 seconds is **expired**.
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
- The server moves the role when the writer leaves or expires, or when no writer exists and an editing participant joins. It sends `live_writer{room_id, device_id, token}` to every participant.
- A device acts as the writer only while the newest `live_writer` that it received names it. It sends its token with every commit.
- `CommitRevision` with a `live_mark` locks the room row and checks that the room is the document's current room and that the token is the current `writer_token`. Otherwise it refuses with `FAILED_PRECONDITION` and the reason `ERROR_REASON_LIVE_NOT_WRITER`. A device that gets this reason stops acting as the writer at once and never retries the commit. Its edits are still in its document, and the current writer commits them (§5.3).
- So at most one device's mark commit can succeed for each token, and absorbing (§5.4) happens exactly once per outside revision.

## 5. Life of a participant

### 5.1 Join

A device joins when it opens a `TEXT` note of at most 512 KiB in an editor (desktop or mobile, source or live preview mode) in a subscribed vault.

1. **Read-only while joining.** The editor opens read-only with a short "Connecting" notice. The user cannot type until step 6, so no text can be typed between the file and the room.
2. **Settle.** If the device has a pending local operation for the note, it runs a sync cycle first. It continues only when nothing is pending for the note. Its journal base is then `B`.
3. **Join.** It sends `live_join`. The server checks the caller's role (§9) and answers `live_joined{room_id, seed_rev_id, latest_mark_rev_id, read_only}`. From now on the note is **held** (§5.5).
4. **Seed and sync.** It builds the seed state (§3) and sends a sync step 1 (its state vector). Participants answer with sync step 2, addressed to it alone.
5. **Wait until complete.** The device fetches the mark of `latest_mark_rev_id` (a revision's mark comes with `GetRevision`). It waits until its document holds that mark (I3), and until the latest mark is `B` or a later revision. If `B` is newer than the latest mark (an outside revision, or the device's own push in step 2), the writer absorbs it (§5.4), which produces a newer mark.
6. **Bind.** It replaces the editor text with the document text in one editor transaction, binds the editor with `y-codemirror.next`, and makes the editor writable.

If any step fails, or steps 3 to 6 take longer than 10 seconds, the device sends `live_leave`, the note is no longer held, and the editor becomes writable under file sync. It tries again the next time the note is opened, or after the socket reconnects. A device that is the only participant of a room whose latest mark is newer than the seed, and that cannot get the missing updates, takes this path. The room is then deleted when it leaves.

### 5.2 Marks

A writer commits the text of its session document, not the file on disk. It takes the text and a Yjs snapshot (`Y.snapshot`: the state vector and the delete set) of its document at the same moment. Then it calls `CommitRevision` with that text and the optional field `live_mark{room_id, writer_token, epoch, state}`, where `state` is the encoded snapshot (`Y.encodeSnapshotV2`), sealed in an encrypted vault (§8). It is at most 16 KiB.

- The server stores the mark with the revision, and sets the room's `latest_mark_rev_id`, in the same transaction.
- A revision with a mark is a **room revision** of that room. It is a normal revision in every other way. `ListChanges` and `GetRevision` return the mark.
- A document **holds** a mark when every item in the mark's state vector is in the document and every deletion in its delete set is applied (`Y.isDeleted`).
- A mark that cannot be opened (for example, its epoch was retired after the re-key job moved the revision) is treated as absent: the revision counts as an outside revision.

### 5.3 Committing

- The writer commits, debounced by 2 seconds, whenever its document does not equal the head's mark: after local typing, after remote updates, after a refused commit is resolved, and once more before it leaves. The rule ends, because each commit covers more of a finite document.
- It commits with `base` = the head. Before that it makes sure that its document holds the head's mark (I3). If the head is an outside revision, it absorbs it first (§5.4).
- On `FAILED_PRECONDITION` without a live reason (the head moved), it pulls and applies the rules above.
- On `ERROR_REASON_LIVE_NOT_WRITER`, it stops acting as the writer (§4).
- On `EPOCH_NOT_CURRENT` or `VAULT_ENCRYPTED`, it re-seals and retries, as the engine does (`encryption.md`, interaction matrix).
- On `PERMISSION_DENIED` (it was demoted), it stops acting as the writer. The server already moved the role.
- If the text exceeds 512 KiB, it commits once and then leaves the session. File sync takes over the note.

### 5.4 Absorbing outside revisions

An **outside revision** is a revision of the note that is not a room revision of the current room. Examples: an edit on a device where the note is not open, a device with an older plugin, a restore from history on any device that is not a participant, or a file-sync fallback after a failure.

The writer absorbs each outside revision `R` that it pulls, in `seq` order:

1. **Base.** The base text is the text of `R`'s parent revision `P` (the head that `R` was committed on). `P` is a room revision of this room whose mark the document holds, the seed, or an outside revision that this writer just absorbed. If `P` is none of these (for example, a room revision of a deleted room), the base is the newest room revision of this room whose mark the document holds. A room revision of this room whose mark the writer still does not hold after 10 seconds of sync (its updates died with an earlier writer) is absorbed in the same way, as an outside revision.
2. **Merge in a copy.** The writer copies its document into a scratch Yjs document. It merges three ways in text: base, local = the scratch text, remote = `R`'s text (LF-normalized). It applies the difference between the scratch text and the merged text to the scratch document with `diff-match-patch`, under a fresh random client id and the origin `absorb`.
3. **Commit first.** It commits the merged text based on `R`, with the scratch document's snapshot as the mark.
4. **Then broadcast.** Only if the commit succeeds does it apply the scratch update to its session document and broadcast it. If the commit is refused, it drops the scratch document, pulls, and starts again from the new head.
5. **Conflict.** If the merge conflicts, the session text stays. The writer records a pending create of a conflict copy holding `R`'s text in its journal (engine rule C), commits the session text based on `R` with a mark, and then pushes the conflict copy. This differs from engine rule M, which keeps the remote side at the path, because people are typing in the session text. A restore from history on a non-participant follows the same rule: if the session changed the same lines, the restored text becomes the conflict copy.

A restore on a participant is a local edit: the plugin replaces the editor text with the restored text, and the change flows through Yjs.

### 5.5 Held notes and bases

From join step 3 until the device leaves, its engine treats the note as **held**:

- Changes of the file's content create no pending operation. Obsidian still saves the editor to disk as usual.
- A rename or a delete of the note on this device is a pending operation as usual. A rename commits as a path-only revision based on the head (reusing its content reference, `encryption.md` *One epoch per revision*) and retries on the new head after `FAILED_PRECONDITION`. The writer absorbs it as a revision with no content change.
- The engine does not write pulled revisions of the note to disk. The writer absorbs them, and other participants receive the result through Yjs. Rename and tombstone revisions still move or keep the file (engine rows A4, A7, W).
- **Moving the base (I2).** After each save of the note by Obsidian, the device reads the file. If it equals the document text, it sets its journal base to the newest room revision of this room whose mark the document held at that moment, with that revision's content hash. Otherwise the base stays. A base that lags is safe: at worst, file sync later merges again text that the head already has, which takes identical changes once or makes one conflict copy.

### 5.6 Leave and disconnection

- **Clean leave** (the note closes in its last editor, or the app goes to the background on mobile). The device waits up to 5 seconds until the head is a room revision of this room whose mark covers its whole document. Then it writes the head's text to the file as the engine's own write, sets base = head, and sends `live_leave`. If the wait times out, it sends `live_leave` and leaves the note to file sync with the base that I2 allows. The same rule applies to a viewer, which has no local edits, so its file never differs from its base after a session.
- **Short disconnection** (the socket closes while the app keeps running). A killed app is never a short disconnection, because the document is in memory only. The device keeps the note held and keeps its document for up to 30 seconds. The user can keep typing. When the socket is back, it joins again. If it gets the same `room_id`, it sends a sync step 1, and so do the others, which fills both gaps. If it gets another room, or none, or 30 seconds pass, it continues as an unclean leave.
- **Unclean leave** (a crash, a killed app, a disconnection longer than 30 seconds, or `live_ended`). The device discards its document. The note is no longer held. Its file is what Obsidian last saved, and its base is what I2 allowed. File sync handles the rest (engine rows A3 and A6). If it was the writer, the server moves the role when it expires.

## 6. Interaction matrix

Every change of a room is serialized (§3). So the matrix lists each server-side change against each in-flight operation of a participant. "Covered" names the acceptance scenario or the core test (named after the row) that covers it.

### 6.1 Changes against a participant that is idle (bound, not committing)

| Change | Result | Covered |
|---|---|---|
| Another device joins | The joiner seeds from the same revision with the same client id and gets the state through step 2. | P5-02 |
| A participant leaves cleanly | Its edits are in a room revision (§5.6). Awareness entry removed by `live_left`. | P5-01, P5-07 |
| A participant expires | The server removes it and sends `live_left`. If it was the writer, the role moves. | P5-09 |
| The writer role moves to this device | It commits by §5.3 from the next debounce. | Core test |
| An outside revision is committed | The writer absorbs it once (§5.4). Others receive the edits through Yjs. | P5-05 |
| A tombstone is committed on another device | The edit wins (engine row A7): the writer re-creates the note from the session text, based on the tombstone. The session continues. A join between the tombstone and the re-create is refused with `ERROR_REASON_LIVE_DOCUMENT_DELETED` and retried. | P5-13 |
| A rename is committed | The session continues. The room belongs to the document id. Each device moves its file (rule W). | P5-13 |
| A member is removed or demoted | The server removes the participant and sends `live_ended` (removed) or a read-only `live_joined` (demoted). The device leaves uncleanly, so its unsaved edits follow file sync, which refuses a viewer's commit and keeps a local copy (`SPEC.md` §9.2). | P5-14 |
| The vault key rotates | New frames use the new epoch. Frames under the previous epoch are accepted for 10 minutes after the receiver learned the new one. | P5-15 |
| A server restore below the latest mark | Sockets close during the restore. The rooms of the restored database have expired participants, so the sweep deletes them. Each device's engine runs its resync (engine §9) after an unclean leave. | Core test |

### 6.2 Changes against a joining device (steps 2 to 6)

| Change | Result | Covered |
|---|---|---|
| Another device joins at the same moment | One transaction creates the room and the other joins it. Both seed from the same revision. | P5-02 |
| An outside revision lands before bind | The writer absorbs it. The joiner waits for the newer mark (step 5). | P5-05 |
| The only other participant expires | The joiner becomes the writer if it may edit. If its document does not hold the latest mark, it leaves after 10 seconds (step 5). | Core test |
| The join takes longer than 10 seconds | It leaves and keeps file sync. Nothing was typed, because the editor was read-only. | Core test |

### 6.3 Changes against the writer during a commit or an absorb

| Change | Result | Covered |
|---|---|---|
| Another commit lands first | `FAILED_PRECONDITION`. The writer pulls. A room revision with a newer token cannot exist while it holds the role. An outside revision is absorbed. | P5-05 |
| The writer role moves away (it expired in the server's view) | `ERROR_REASON_LIVE_NOT_WRITER`. It drops the scratch document, so nothing is broadcast twice. The new writer commits the document. | Core test |
| The device crashes after the commit, before broadcasting the absorb | The new writer pulls a room revision whose mark its document does not hold (the absorbed items exist only in the dead device). It cannot meet I3, so it treats the revision as an outside revision: it absorbs the difference against the newest mark it holds. The text arrives once. | Core test |
| The device crashes before the commit | Nothing was committed or broadcast. The new writer absorbs the outside revision. | Core test |

### 6.4 Changes against a leaving or disconnected device

| Change | Result | Covered |
|---|---|---|
| Clean leave while another person keeps typing | The device waits for a mark that covers its document (at most 5 seconds), writes the head and sets base = head. No conflict copy. | P5-01 |
| Disconnection under 30 seconds | It rejoins the same room and sync step 1 fills the gaps. No text is duplicated, because its document was never discarded and the note stayed held. | P5-08 |
| Disconnection over 30 seconds | Unclean leave: file sync merges its file against the head (I2 keeps its base safe). One conflict copy at most. Then it joins the current room fresh. | P5-08 |
| App killed | Unclean leave on restart. | P5-09 |
| A replica stops | Sockets close. Short disconnection on every participant of that replica, which reconnect to another replica. The room is in PostgreSQL. | P5-10 |

### 6.5 Edits that do not come through Yjs

| Edit | Result | Covered |
|---|---|---|
| Another plugin (`processFrontMatter`) or an external editor changes the file on a participant | Obsidian reloads the editor from disk. The binding turns the change into this participant's own Yjs edits. | P5-06 |
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
| Server to client | `live_joined{vault_id, document_id, room_id, seed_rev_id, latest_mark_rev_id, read_only}` | The room to use. |
| Client to server | `live_leave{room_id}` | Leave. |
| Both | `live_message{room_id, kind, epoch, message_id, part, parts, to_device_id?, payload}` | One Yjs message, split into parts. The server adds `sender_user_id` and `sender_device_id`. |
| Server to client | `live_writer{room_id, device_id, token}` | The current writer. |
| Server to client | `live_left{room_id, device_id}` | A participant left or expired. |
| Server to client | `live_ended{room_id, reason}` | This device's participation ended: removed, demoted to no access, vault deleted, room deleted. |
| Server to client | `live_error{document_id, room_id?, code, reason}` | A refused live request. It never affects the vault subscription, unlike `ErrorFrame` (`SPEC.md` §6.4). |

Rules:

- **Kinds.** `kind` is `sync_step1`, `sync_update` (step 2 and updates) or `awareness`. Receivers check that the decoded y-protocols message type matches `kind`, and drop a mismatch. The server refuses `sync_update` from a read-only participant (`live_error` with `PERMISSION_DENIED`). Receivers also drop `sync_update` from a sender that their member list shows as a viewer.
- **Parts.** A message is split into parts of at most 3 KiB of payload, so a sealed part with its envelope fits the realtime channel's 4 KiB frame limit. Parts are numbered from 0. A whole message is at most 1 MiB (so `parts` is at most 342). `message_id` is a random 64-bit value. Receivers reassemble per sender and `message_id`, and drop incomplete messages after 30 seconds.
- **Addressing.** A sync step 2 carries `to_device_id` = the device that sent the step 1, and the server relays it only there. Every other message goes to every other participant. Nothing goes back to the sender.
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
- Accepted limit: any holder of `live_key` (a member, or a removed member until the next rotation) can seal a frame under any device id if the server colludes. The rotation on removal (`SPEC.md` §9.2) bounds this, together with the 10-minute rule.
- A plaintext vault sends payloads unsealed.

What the server learns: which devices have which notes open and when, the size and timing of edits, and cursor activity. It learns no content, no cursor position and no path. This is accepted.

## 9. Authorization and bounds

- **Join.** The server resolves the caller's role in the vault before anything else. A non-member, a missing vault and a missing document get the same `live_error` `NOT_FOUND`. A document that is not `TEXT` gets `ERROR_REASON_LIVE_NOT_TEXT`. A tombstone gets `ERROR_REASON_LIVE_DOCUMENT_DELETED`. A note whose head content is over 512 KiB gets `ERROR_REASON_LIVE_TOO_LARGE`. A full room or too many rooms on the connection gets `ERROR_REASON_LIVE_LIMIT`. The plugin keeps file sync for that note and tries again when the note is opened again.
- **Viewers** join with `read_only = true` (§7, *Kinds*).
- **Membership changes.** See §6.1.
- **Commits with a mark.** See §4.
- **Bounds** (configurable, with defaults): 32 rooms per connection, 16 participants per room, 3 KiB of payload per part, 1 MiB per message, and live parts in their own token bucket of 200 parts per second with a burst of 400 per connection, and their own send queue of 512 parts per connection. Exceeding the inbound bucket closes the socket with `RESOURCE_EXHAUSTED`. A connection that cannot drain its live queue is closed as a slow client. The channel's existing bounds apply to the other frames.
- **Logs** never contain payloads, marks or paths.

## 10. Plugin structure

- `plugin/src/core/live/`: rooms, seeding, sync messages, awareness, parts, marks and snapshots, the writer, absorbing, held notes and the base rule, leaving, and sealing. It does not import `obsidian`. Core tests drive it with the in-memory server and an in-memory relay, one test per row of §6.
- `plugin/src/obsidian/live-editor.ts`: the editor binding (`y-codemirror.next`), the read-only join, the remote cursors and the list of people in the note.
- The engine gets one new input: the set of held document ids, with the writer's commit and absorb paths and the base rule of §5.5. This is a narrow change to `docs/design/engine.md` §4 and §5, approved with this page.
