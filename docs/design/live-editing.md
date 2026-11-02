# Live editing design

For: developers and agents. You know `SPEC.md`, the engine design (`docs/design/engine.md`) and the encryption design (`docs/design/encryption.md`, `docs/design/crypto.md`).

Status: draft for owner approval. It replaces the plan in the earlier `SPEC.md` §10 (permanent Yjs documents, a conversion lease, a server update log and compaction). The owner chose this smaller model on 2026-11-02.

Agents implement this design. They do not change it. If it does not decide a case, ask on the issue. Every answer must keep the safety argument in §9 true.

## 1. Goals

- **Live co-editing of open notes.** When two or more devices have the same Markdown note open, each person sees the edits of the others within about a second. Nobody gets a conflict copy for edits made in the same session.
- **Presence.** Each person sees the cursors and selections of the others, with the user's name and a color. Each person sees who else has the note open.
- **Desktop and Android.** Live editing works on every platform that the plugin supports.
- **Encrypted vaults too.** In an encrypted vault, the server relays only ciphertext.
- **Nothing new to store or back up.** The note is saved through the revision log, as today. History, conflicts, export, retention and restore do not change.

### Reference behavior

The reference is a shared document in Google Docs, or the Relay plugin for Obsidian, while the document is open. A note that is not open on two devices syncs as today, within a few seconds.

### Not planned

- Live editing of files other than Markdown notes (`TEXT` documents). Canvas, Bases and other files keep file sync.
- A live view of a note that is not open in an editor (for example, a hover preview or the reading view of a note that nobody edits in).
- Per-character authorship ("who typed this"). History shows who saved each revision, as today.
- Comments, suggestions, or a "follow this user" mode.
- Undo of another person's edits. Undo only undoes your own edits.
- Live editing between devices that run plugin or server versions without live editing. Those devices keep file sync.
- A guarantee that live editing continues while the server is unreachable. Edits made offline sync when the device reconnects, through the session if it still exists, otherwise through file sync.

## 2. Model

A **live session** is the set of devices that have the same note open in an editor at the same time. The term "participant" means one device in a session.

- Each participant keeps the note as a Yjs document in memory. Yjs is a library that merges concurrent edits without conflicts (a CRDT, or conflict-free replicated data type).
- The server relays Yjs updates between the participants. It never parses them. It stores no update and no snapshot.
- The revision log stays the only durable copy of the note (principle 2). Exactly one participant, the **writer**, commits the text of the session as ordinary revisions.
- If the live layer fails in any way, the note falls back to file sync. File sync merges three ways and makes a conflict copy when the merge fails. So a failure of the live layer can cost a conflict copy, but never an edit (§9).

Libraries, all maintained and widely used:

| Need | Library |
|---|---|
| CRDT text | `yjs` |
| Sync and awareness messages | `y-protocols` (`sync`, `awareness`) |
| Editor binding and undo | `y-codemirror.next` (Obsidian's editor is CodeMirror 6) |
| Character diff, to apply outside edits to the Yjs text | `diff-match-patch` (already a dependency) |
| Encryption | `@noble/ciphers`, `@noble/hashes`, with the existing `subkey` construction (§7) |

No part of Yjs, its sync protocol or its encoding is written by hand.

## 3. Rooms

A **room** is the server's record of one live session. It exists so that every participant starts from the same text.

- The server keeps rooms in PostgreSQL, in a table `live_rooms (document_id primary key, room_id, seed_rev_id, created_at, last_active)`. A row holds no note content.
- A room is **active** while a participant on any replica sent a heartbeat in the last 30 seconds. Each replica updates `last_active` every 10 seconds for each room that has a participant connected to it.
- The **seed** of a room is the document's head revision when the room is created. The server sets it. A client cannot choose it.
- When a device joins a document whose room is missing or inactive, the server replaces the row in one compare-and-set statement: a new `room_id`, and the current head as the seed. Two joins at once therefore get the same room.
- An expired row is deleted by the next join or by a cleanup job on every replica. The cleanup job is bounded per run, like the retention jobs.

### Seeding without duplicated text

Two Yjs documents that each insert the same text separately hold that text twice when they merge. Every participant therefore builds the starting state of the room in the same way:

1. It reads the content of the seed revision (from its journal if it has it, otherwise with `GetRevision`).
2. It makes a Yjs document whose client id is derived from the `room_id` (the first 4 bytes of SHA-256 of the room id, as an unsigned integer). It inserts the seed text in one operation.
3. It encodes that state and applies it to its session document. It then uses a random client id for its own edits, as Yjs normally does.

Every participant produces the same item ids for the seed, so Yjs treats them as one insertion. A different room has a different client id for its seed, so two rooms never pass for one.

Updates of one room are never applied to the document of another room. Every frame names its room (§6).

## 4. Joining and leaving

### Join

A device joins when it opens a note in an editor (desktop or mobile, source or live preview mode) and the note is a `TEXT` document in a subscribed vault.

1. **Settle the note first.** If the device has a pending local operation for the note, it runs a sync cycle first. It joins only when nothing is pending for the note. During that time the editor works as it does today.
2. **Join.** It sends `live_join`. The server checks the caller's role (§8) and answers `live_joined{room_id, seed_rev_id, read_only}`.
3. **Seed and sync.** It builds the seed state (§3) and sends a Yjs sync step 1 (its state vector). Each participant answers with sync step 2 (the updates that the joiner does not have).
4. **Wait until the room holds its revision.** The device knows the last revision it synced, `base_rev_id`. The room holds that revision when the room's latest **mark** (§5) is that revision or a later one. If the device synced a revision that the room does not hold yet (an outside commit, §5), it waits for the writer to absorb it. If no writer is present, the device is the writer and absorbs it itself.
5. **Bind.** It replaces the editor text with the room text in one editor transaction, then binds the editor to the session document with `y-codemirror.next`. From then on, edits flow both ways.

If any step fails or takes longer than 10 seconds, the device leaves the session and keeps file sync for the note. It tries again the next time the note is opened, or after the socket reconnects.

### Leave

A device leaves when the note closes in its last editor, when the app goes to the background on mobile, or when the socket closes.

- **Clean leave.** The device makes sure that its own edits are durable. They are durable when the latest mark covers them (its own client id's clock in the mark's state vector is at least its current clock). It waits up to 5 seconds for such a mark. Then it sends `live_leave`. Its journal base for the note is the latest mark revision that its document holds, and its file is synced again by file sync (§5, *After the session*).
- **Unclean leave** (a crash, a killed app, a lost network). The device does nothing special. Its file on disk is what Obsidian last saved, and its journal base is the latest mark revision that it held. File sync handles the rest (§9).

## 5. Saving: the writer and marks

### The writer

- The writer is the participant with the smallest device id among the participants that may edit, from the awareness states that the participant sees. Every participant computes it locally. No election runs on the server.
- Two participants can each think that they are the writer for a short time, for example while their awareness states differ. Both then commit. The server accepts the first commit and refuses the second (`FAILED_PRECONDITION`). The second writer then pulls the head and finds a mark that its document holds. Nothing is lost and nothing is duplicated (§9).
- The writer commits about 2 seconds after the last change, like the engine's debounce, and at once before it leaves.

### Marks

A writer commits the text of its session document, not the file on disk. It takes the text and the Yjs state vector of its document at the same moment. Then it calls `CommitRevision` with that text and a new optional field `live_mark`:

- `live_mark.room_id`: the room.
- `live_mark.state`: the state vector, encrypted in an encrypted vault (§7). At most 4 KiB.

The server stores the mark with the revision, in the same transaction. A revision with a mark is a **room revision**. It is a normal revision in every other way: history, export, retention and restore treat it like any other.

`ListChanges` and `GetRevision` return the mark with the revision. So every device learns, from the revision itself, which room produced it and which edits it holds. There is no window in which a commit exists without its mark.

### Revisions from outside the session

An **outside revision** is a revision of the note that no room produced, or that another room produced. Examples are an edit on a device where the note is not open, an edit by a device with an older plugin, or a file-sync fallback after a crash.

When the writer pulls a revision `R` of a note in its session:

| `R` is | Writer's action |
|---|---|
| A room revision of its own room, and its document holds the mark's state vector | Set the journal base to `R`. Nothing else. |
| A room revision of its own room, and its document does not hold the mark's state vector yet | Wait for the missing updates (sync step 1 to the room). Then do the row above. If they do not arrive within 10 seconds, leave the session and fall back to file sync. |
| An outside revision | **Absorb** it: merge three ways with base = the journal base, local = the session text, remote = `R`'s text. Apply the difference between the session text and the merged text to the session document, as edits of the writer, with `diff-match-patch`. Then commit the new session text with a mark, based on `R`. |
| An outside revision whose merge conflicts | Keep the session text. Save `R`'s text as a conflict copy (engine rule C), then commit the session text based on `R`. This differs from engine rule M, which keeps the remote side at the path. The session text wins because people are typing in it. |
| A tombstone | The edit wins (engine row A7). The writer re-creates the note from the session text, based on the tombstone, and the session continues. |
| A rename | The session continues, because the room belongs to the document id, not the path. The engine moves the file (rule W). |

Only the writer absorbs. Other participants never apply a pulled revision of the note to their editor or their disk. They receive the result through Yjs.

### Participants that are not the writer

While a device is a participant, its engine treats the note as **held by the session**:

- It does not turn changes of the note's file into pending operations. Obsidian still saves the editor to disk as usual.
- On each pull, it does not apply revisions of the note to disk. It sets its journal base to the newest room revision of its own room that its document holds.
- If it becomes the writer, it takes over the writer's duties from the next change.

### After the session

When a device leaves (clean or unclean), the note is no longer held. The engine treats it like any other note:

- If the file still equals the content of the journal base, the note is clean, and later pulls overwrite it (engine row A3).
- Otherwise the note is edited, and the engine merges it three ways against the head (engine row A6). After a clean leave, the file equals a text that the room held. The head is a later room text that holds the same edits. So the merge takes identical changes once, and normally results in the head.

## 6. Protocol

The live frames use field numbers 100 to 199 of the `ClientFrame` and `ServerFrame` envelopes (`proto/vaultsync/v1/realtime.proto`). All of them name a vault, a document and a room.

| Direction | Frame | Purpose |
|---|---|---|
| Client to server | `live_join{vault_id, document_id}` | Join or create the room of a document. |
| Server to client | `live_joined{vault_id, document_id, room_id, seed_rev_id, read_only}` | The room to use. |
| Client to server | `live_leave{room_id}` | Leave. |
| Both | `live_message{room_id, kind, message_id, part, parts, payload}` | One Yjs sync message (`kind = sync`) or awareness message (`kind = awareness`), split into parts. The server adds `sender_user_id` and `sender_device_id` when it relays. |
| Server to client | `live_ended{room_id, reason}` | The room was replaced, the member was removed, or the document was deleted. |

Rules:

- **Parts.** A message larger than 4 KiB is split into parts of at most 4 KiB. A whole message is at most 2 MiB (a Markdown note is at most 1 MiB, and Yjs adds overhead). The server relays parts as they come. Receivers reassemble parts per sender and `message_id`, and drop incomplete messages after 30 seconds.
- **Delivery.** The server relays a message to every other participant of the room, never back to the sender. Delivery is best effort. A message can be lost when a replica stops or a slow socket is closed.
- **Healing.** Yjs updates are idempotent and commutative, so lost or repeated messages do not corrupt a document. Every participant sends a sync step 1 every 15 seconds and after every reconnect. The answers fill any gap.
- **Fan-out between replicas.** A replica publishes each relayed part with PostgreSQL `NOTIFY` on a `live` channel. Every replica `LISTEN`s on it, on the connection it uses for `vault_changed`, and delivers to its local participants. A part (4 KiB) fits in the 8000-byte limit of a `NOTIFY` payload after base64 encoding with its header. No other infrastructure is needed (principle 5).
- **Awareness.** Awareness is the `y-protocols` awareness state: the cursor, the selection and a color. It is never stored. A participant sends it at most 5 times per second, and every 15 seconds while idle. A state that is not renewed for 30 seconds is removed, which is the `y-protocols` default.
- **Names.** A receiver shows the name of the member whose `sender_user_id` the server stamped on the frame, from the member list. It never shows a name from the payload. So a member cannot pose as another member.

## 7. Encryption

In an encrypted vault, the payload of every `live_message` and the state of every mark are sealed:

```
live_key = subkey(epoch_key, "live")
live_aad = "vault-sync/v1/live" || vault_id (16) || document_id (16) || room_id (16) || sender_device_id (16) || kind (1) || epoch (u64)
sealed   = the sealed format of crypto.md, with live_key and live_aad
mark_aad = "vault-sync/v1/live-mark" || vault_id (16) || document_id (16) || room_id (16) || revision_id (16) || epoch (u64)
```

- `live` and `live-mark` are new labels for `subkey`. They need new cross-language vectors in `testdata/crypto/`.
- The sender seals with the newest epoch that it holds. The frame carries the epoch number outside the ciphertext. A receiver that does not hold that epoch fetches it the usual way. A frame under an epoch older than the receiver's newest is still accepted, because a rotation can happen during a session.
- The associated data binds the sender's device id. A frame whose stamped `sender_device_id` differs from the one in the associated data fails to open, and is dropped. So the server cannot pass one member's frame off as another's.
- Message parts are sealed one by one, after splitting. A receiver opens each part before reassembly.
- A plaintext vault sends payloads unsealed.

What the server learns: which devices have which notes open and when, the size and timing of edits, and cursor activity. It learns no content, no cursor position and no path. This is accepted.

## 8. Authorization and bounds

- **Join.** The server resolves the caller's role in the vault before anything else. A non-member, a missing vault and a missing document get the same `NOT_FOUND` error frame. A document that is not `TEXT`, or is a tombstone, gets `FAILED_PRECONDITION`.
- **Viewers** join with `read_only = true`. They receive sync messages and send awareness. The server refuses their sync messages that are not step 1 (`PERMISSION_DENIED`, not fatal). Their editor stays read-only, as today.
- **Membership changes.** When a member is removed, or their role changes, or the vault is deleted, the server sends `live_ended` to that member's participants and stops relaying to them. The membership check on delivery that already exists for `vault_changed` applies to live frames too. Other participants keep the session. In an encrypted vault, the removal also rotates the epoch key (`SPEC.md` §9.2).
- **Commits with a mark.** `CommitRevision` checks that the mark's room is the document's room, active or not. A mark of another document's room is refused (`INVALID_ARGUMENT`). The server does not check the state vector, which can be ciphertext.
- **Bounds** (configurable, with defaults): 8 rooms per connection, 16 participants per room, 1 MiB per second of live parts per connection with a burst of 4 MiB, 50 live parts per second per connection with a burst of 200, and 4 KiB per part. Exceeding a rate closes the socket with `RESOURCE_EXHAUSTED`, as today. The send queue bound and the slow-client rule of the realtime channel apply.
- **Logs** never contain payloads, states or paths.

## 9. Why nothing is lost

The argument rests on four facts:

1. The revision log is the only durable copy, and only file sync and the writer write to it. Both use `CommitRevision`'s compare-and-set.
2. Every edit that a person typed is in their own session document, and in their file on disk once Obsidian saves it (within about 2 seconds).
3. An edit reaches a revision either through the writer (a room revision that holds it) or through file sync after the device leaves (engine rows A6 and M).
4. Yjs merges are idempotent, and a text merge takes identical changes once.

The interaction matrix lists each event against each state of a participant. "Covered" names the acceptance scenario or the test that covers the row.

| Event | Participant state | Result | Covered |
|---|---|---|---|
| Two devices open a note at once | No room | One compare-and-set creates one room. Both seed from the same revision, with the same client id. | P5-02 |
| Device opens a note with unsynced edits | Pending operation | It syncs the edit first and joins after. The writer absorbs the revision, so the room holds it. | P5-04 |
| Device opens a note that another device edited outside the session | Joining | The writer absorbs the outside revision. The joiner binds when the mark reaches its revision. | P5-05 |
| Two writers at once | Both commit | One commit wins. The other pulls a room revision that its document holds, or waits for its updates. | Unit test |
| A writer commits and stops before others receive its updates | Writer gone | The new writer pulls a room revision whose state vector it does not hold. It waits 10 seconds, then leaves, and file sync merges. Updates that only the old writer had are in the revision. | P5-09 |
| A participant loses the network for less than 30 seconds | Room active | It reconnects, joins the same room, and sync step 1 fills both gaps. | P5-08 |
| A participant loses the network for longer | Room replaced | It gets a different room. It leaves the old session, and its file syncs by file sync (engine row A6). Then it joins the new room. | P5-08 |
| The app is killed during a session | Unclean leave | On restart, file sync merges the saved file against the head. Edits that it had sent are also in room revisions, and the merge takes them once. | P5-09 |
| A replica stops | Sockets close | Participants reconnect to another replica. The room row is in PostgreSQL, so the room stays. | P5-10 |
| Another plugin or an external editor changes the file during a session | Participant | Obsidian reloads the editor from disk. The binding turns the change into the participant's own Yjs edits. | P5-06 |
| The same change made by a plugin on every participant at once (for example, a "last modified" field) | Every participant | Each change becomes separate Yjs edits, so the text can hold the change twice. Nothing is lost. This is a known limit, listed in the user docs. | User docs |
| A device without live editing edits the note | Not a participant | Its commit is an outside revision. The writer absorbs it. | P5-05 |
| The note is renamed | Participant | The room belongs to the document, so the session continues. | P5-13 |
| The note is deleted on another device | Participant | The edit wins (engine row A7). The writer re-creates the note from the session text and the session continues. | P5-13 |
| The note is deleted on a participant | Participant | The editor closes, so the device leaves. If others are still editing, the writer re-creates the note. | P5-13 |
| A member is removed or becomes a viewer | Participant | `live_ended`, or a read-only rejoin. Their unsaved edits follow file sync, which refuses a viewer's commit and keeps a local copy (`SPEC.md` §9.2). | P5-14 |
| The vault key rotates | Participant | New frames use the new epoch. Old frames still open. | P5-15 |
| A merge of an outside revision conflicts | Writer | The session text wins. The outside text becomes a conflict copy. | P5-05 |
| A server restore below the mark | Any | The engine's resync applies (engine §9). The session ends with `live_ended` and every participant falls back to file sync. | Unit test |

Any case outside this table is a design gap. Ask on the issue.

## 10. Plugin structure

- `plugin/src/core/live/`: the session (rooms, seeding, sync messages, awareness, parts, marks, the writer rule, absorbing outside revisions, sealing). It does not import `obsidian`. Tests drive it with the in-memory server and an in-memory relay.
- `plugin/src/obsidian/live-editor.ts`: the editor binding (`y-codemirror.next`), the remote cursors and the list of people in the note.
- The engine gets one new input: a set of document ids held by the session, with the writer's commit path and absorb path. This is a narrow change to `docs/design/engine.md` §4 and §5, approved with this page.
