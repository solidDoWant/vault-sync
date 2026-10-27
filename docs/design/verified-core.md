# Verified engine core

Status: §1 approved by the owner (#945), §2 added by #947, effect semantics and file contents (§2.3) by #964, the core (§3) by #948, G5 on user steps, `G3_DeleteSeen`, the outbox clause of `CoreInv` and the server's step semantics by #974; part of the verified-core rewrite #944. This document holds the specification of the engine's verified decision core. §1 states the guarantees the core must keep, in plain English. §2 describes the formal model that states them as predicates, which the verified core will prove; it may not weaken them. Changing what a guarantee means needs the owner (#944, "Rules while this runs").

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
| Name of a conflict copy | `<name> (conflict <device> <date>).<ext>`, as `SPEC.md` §7 says | `SPEC.md` §7 (PO-14), which predates the policy. Step 1 would pick Obsidian's `<name> (Conflicted copy <device> <YYYYMMDDHHMM>).<ext>`. The owner kept `SPEC.md` §7's name (delegated on PR #959, logged on #52); no guarantee depends on it |
| One device deletes a file while another edits or renames it | The edit or rename wins; the file stays, with the edit | Step 2 (keeps the edit). Also `SPEC.md` §6.3 |
| Two devices create a file with the same name at the same time | The first to reach the server keeps the name; the other becomes a conflict copy | Step 3 (both outcomes keep all contents, so step 2 does not decide). Also `SPEC.md` §6.3 |
| A file is created where a deleted file used to be, while that device is offline | It becomes the next version of the deleted file, which keeps its history | Step 3 (no data is at stake either way; Obsidian Sync's behaviour is undocumented). Also `SPEC.md` §8 (decision #17) |
| A file is moved or renamed while the app is closed | Recognized as a rename only when its contents match exactly one missing file; otherwise it is a delete plus a new file | Owner decision 4 (2026-10-20, design "Decisions"), which predates the policy. Step 2 agrees: a wrong match would attach one file's history to another, and the fallback loses no contents |
| A file a device cannot hold (name not allowed, too large) | Kept on the server and on other devices unchanged; this device reports it and does not rename it for everyone | Step 3 (no data is lost either way; Obsidian Sync's behaviour is undocumented). Also `SPEC.md` §8 "Platform path rules" |
| Two folders whose names differ only in case, on a device that treats them as one | The device keeps the spelling it already has on disk | Step 3 (no data is at stake). Also `SPEC.md` §8 and design INV-9 (#737) |
| A delete of a note with unsaved changes in an open editor | The changes are saved and the delete is refused, so the edit then wins over the delete | Step 2 (keeps the unsaved text). Also `SPEC.md` §8 "Editor-safe deletes" (#181) |

## 2. The formal model

The guarantees of §1 are stated formally in Dafny, in `plugin/verified/spec/`. The specification describes what the engine's state is, which events change it, which effects the engine may ask for, and what every run must satisfy. It contains no decision logic and no proofs about transitions: those come with the verified core itself. `make verify` checks that the specification is well-formed and proves that the initial state satisfies every guarantee that is a property of one state (`docs/testing/verification.md`). The specification is not compiled into the plugin.

### 2.1 Paths (`Paths.dfy`)

A path is an exact spelling. The engine compares paths in two ways (`engine-path-ownership.md` §3.1, PO-10): `F`, which spellings name one file on a device, depends on the device's platform; `K`, the server key of `SPEC.md` §5, decides server claims and copy-name freedom. Both are abstract functions to a key, so "same key" is an equivalence relation by construction. Their axioms are: normalizing a path keeps its key and normalizing twice changes nothing; the folder relation (`Ancestors`) is proper and transitive; and both keys are compatible with folders, so whether a file lies under a folder does not depend on which spelling of the folder is asked about. That is what disk exclusivity needs of `F`: a collision (§3.2, a name or a folder of it) is a property of key classes. No axiom relates `F` and `K`, because neither implies the other. There are no Unicode tables: a refinement with identity keys (the posix platform) shows the axioms are consistent. The TypeScript implementations satisfy each axiom on every platform: one fast-check property test per axiom, named after it, in `plugin/src/core/pathkey/path-axioms.test.ts` (#951).

### 2.2 State (`Engine.dfy`)

The state is a set of devices and the server.

- **The server** holds every revision, each document's history (a line, its last revision the head), the change feed, and the revisions the retention policy purged. It also records, as bookkeeping that only the guarantees read, every revision it ever accepted, so a restore from backup that loses one is visible.
- **A device** has a platform, whether the app is running, its journal, its disk, the open editors with unsaved text, and the paths it does not sync.
- **The journal** holds one row per document: `base` (the last server revision applied or acknowledged), `ahead` (the newest server revision not applied, with its blocker), `binding` (the file that is the document on this device, with the content last seen there) or the reason it has none (`absence`), and `outbox` (the one commit it will send). With the cursor these are the device's view of the server. The journal also holds the open intents (`apply`, `merge`, `displace`, `detach`, `commit`, `resync`, design §4.4) and the conflict log.
- **The disk** maps spellings to files. A file has its content and, as bookkeeping the engine never sees, its identity (the harness's inode, design §5.4), so the guarantees can say which file is which. The supply of identities is unbounded: for any finite set of identities there is one outside it (`FreshIdentityExists`, an axiom). That is sound because the harness gives every new file a fresh inode number; a refinement with natural numbers as identities (`NatIdentities`) proves the axiom, so it is consistent. Without it a create could have no outcome, and a step that requests one could not follow its effects.

### 2.3 Events and effects (`Engine.dfy`)

An event is one of: a user action on a device's disk (write, delete, rename, an editor's unsaved text), whether the app runs or not; a local file event the vault reports (create, modify, delete, rename), which can be lost; the start-up scan with the vault listing; a remote revision; a push result (accepted, head moved, already exists, invalid argument, unavailable); a restore from backup; a retention purge; a restore of an earlier revision from history; a crash; a restart; and a sync round (a pull, then a push). A sync round's step includes its pull's results: the revisions on the feed after the device's cursor are handed to the core within the step. A remote revision event is one delivered outside a round. The push's answers arrive as later push-result events.

The effects the engine may ask for are: write a file (for a document or as an untracked copy), delete a file, move a file, each with the content the file must still have (or that no file is there); read a file; upload content; commit an outbox; pull from a cursor; persist the journal; and report something to the user.

**What an effect does to the disk.** A disk effect takes effect only when its precondition matches the device's disk, comparing names under the device's `F`; otherwise it does nothing. A write conditional on content overwrites the file that holds that content in place: the same file, with the new content. A write conditional on no file creates a new file at its name, but only if no file collides with that name: none has the same name under `F`, sits where one of its folders would be, or lies under it (design §3.2). A delete removes the file that holds the expected content. A move takes the file that holds the expected content, with its contents, to the new name, but only if no other file collides with that name and neither name is a folder of the other. A rename that only changes upper or lower case is allowed. The other effects do not touch the disk. A step's effects act in the order requested, each on the disk the earlier ones left. In a step that is not a user's action, the event's device's disk after the step is its disk before with the effects applied, and no other device's disk changes (`EffectTakes`, `EffectsTake`, `DisksFollowEffects`). Every sequence of effects has an outcome on every disk (`EffectsCanTake`), so no step's effects leave it without a disk after. A user's step changes the disk by the user's action instead. A crash can cut a step short after the shell performed only some of its effects. That step then never completes. The crash event names the step it cut short, if any: that step's event, an event of the same device that the core handles (not a user's action or another crash), and the effects the core requested for it in the crash step's state before. The crash step lists, as its effects, the ones the shell performed, which are a prefix of the requested ones, and they act on the disk like any step's effects. A crash that cut nothing short performs no effect (`CrashCutsShort`). That the requested effects are what the core asks for in response to that event is a proof obligation of the verified core. What the crash leaves of the journal is crash recovery's business (#950).

**How file contents reach the core.** There is no read-result event. When the shell hands the core a local file event, it reads every path the event names (one, or both names of a rename) and passes, for each, the file's content and kind under `F`, or that no file is there. In the model this read is taken from the step's state before (`ReadAt`, `LocalReads`), the same disk the effects' preconditions are checked against. The start-up scan gets its listing the same way, inside its event. The read-file effect has no result in this model; the core does not need one.

**What a step does to the server.** The server changes only by its own events (`ServerFollowsEvent`). An accepted commit appends one revision to the document's history, to the feed and to what the server accepted, and drops nothing. That revision is the device's sealed outbox of the document, the commit in flight: the outbox's id, path, content, kind and delete flag, from that device, with the outbox's base as its parent. The parent must be the document's current head (none for a new document), because the server accepts a commit only on the head it was based on (`SPEC.md` §6.2). The id must be one the server never used, and a live revision's path must not collide under `K` with another document's live head (`SPEC.md` §5). A restore from history appends a live revision with the restored revision's content and kind, under the same rules. A purge marks revisions purged that are not a document's head, and changes nothing else. A restore from backup leaves the server it names. A remote revision delivered to a device is one on the feed. Every other event leaves the server unchanged: a push the server refused or could not answer, a sync round (its pull only reads), a user's action, a local event, the scan, a crash and a restart. That the accepted revision is the sealed outbox is part of the model, not a core obligation: it describes the server answering the commit the device sent. It holds for a real run only if the core persists a sealed outbox before it requests the commit, and keeps it until the commit is answered, which #949 must prove (§3.2).

A step is a state, an event, the effects requested and the next state. A trace is a sequence of connected steps, and a run is a trace from the initial state (every device running, with an empty vault and journal, and an empty server).

### 2.4 Guarantees as predicates (`Guarantees.dfy`)

Each guarantee is a predicate, with a comment quoting the sentence of §1.1 it formalizes. A guarantee about one moment is a predicate on a state, one about what a single step may do a predicate on a step, and one about the order of things a predicate on a trace. `StateInvariants` collects the state predicates and `TraceGuarantees` the trace predicates. G8's "as if it had not crashed" relates two runs, one with crashes and one without, and is the separate predicate `G8_AsIfNoCrash`.

| Guarantee | Predicates |
|---|---|
| G1 | `G1_Retained`, `G1_LatestNeverPurged` (state), `G1_OnlyRetentionRemoves` (step), `G1` |
| G2 | `G2_OnlyWhatItSaw`, `G2_Conditional`, `G2_NoUntrackedDelete`, `G2_UnsavedSafe` (step), `G2` |
| G3 | `G3_DeleteSeen` (step), `G3` with `UserRemovedFileOf` and `JustifiedTombstone` (trace) |
| G4 | `G4` (trace) |
| G5 | `G5_RenameKeepsDocument`, `G5_NeverMixedUp` (step), `G5_NeverJoined` (state), `G5` |
| G6 | `G6_Settle` (step), `G6` |
| G7 | `G7_OneFilePerName` (state), `G7_MoveKeepsContents` (step), `G7` |
| G8 | `G8_Recovers`, `G8_PicksUpOfflineChanges` (step), `G8`, `G8_AsIfNoCrash` (two traces) |
| G9 | `G9` (state), with `FinishedSyncing` and `InStep` (`Engine.dfy`) |
| G10 | `G10_SettledOrReported` (step), `G10_NoLoop` (two consecutive steps), `G10_NeverStalls` (trace), `G10` |

G10's "never … stalls forever" is stated as a safety property: two sync rounds of a device with nothing in between but answers to its own commits and revisions delivered to it leave it finished, apart from what a user has to act on and user changes whose local events have not reached the engine yet (`G10_NeverStalls`; local events lag the disk, design §4.3). That a single round ends is a property of the core's code, proved with it. `G10_SettledOrReported` accepts a deferral left after a round only where a user must act. The model has no download effect, so a merge that cannot fetch the remote bytes because the server became unavailable mid-round is not represented yet. When the core models downloads, that case needs its own exception, through a `design` issue. G3's "a missed notification never counts as a delete" also binds what a step records, not only what the server accepts: a step that is not the user's records a user's delete of a document (drops its binding with `absence = UserDeleted`) only when no file is at the binding's name, or the vault reported another file renamed onto that name (`G3_DeleteSeen`). A file still at its name was not deleted, whatever event arrived. G5's "never mixed up" is about what sync does: in a user's own step a document's bound file may change only because the user changed the disk under a binding the step left as it was, by writing at its name or renaming another file onto it (clause (g) of `G5_NeverMixedUp`). The engine learns of that change from the vault's report or the start-up scan, whose steps clauses (a)–(f) judge as before. That an outbox carries the change it records is not a guarantee predicate: a stale outbox holds a version the user had, so by itself it loses nothing, and its visible effect, the server lagging the file, is G9's and G10's over a run. It is the core's invariant instead (§3.2), so every step of the core must keep it. G6's "stays in place" and "saved next to it" are read as the content the document keeps and an untracked file on the device, whatever its name: the copy's name and the result's path are `SPEC.md` §7's rules, not guarantees.

`Witnesses.dfy` checks the predicates both ways. Its witnesses show that a non-trivial state (two devices holding the same synced file) and run (a user's write) satisfy them, so they rule out no correct core. A third witness, two sync rounds that pull and apply a revision while a user's write has not been reported yet, satisfies `G10_NeverStalls`. A fourth, a user's rename of an untracked file over a bound one, satisfies `G5`, so G5 can be met on user steps. Its rejections show that a predicate fails on the failure its sentence rules out: a revision dropped from the server (G1), a delete nobody made (G3), a reported delete recorded although the file is still at its name (G3), a user's step whose journal rebinds a document to another file (G5), the deleting device's own overruled edit resurrecting a file (G4), a remote create joined to another file of the same name (G5), a missing file forgotten at start-up (G8), devices that disagree (G9), and a conflict merely reported (G10). A broken core therefore cannot pass them. `Guarantees.dfy` has three more rejections (G2, G5, G7). For the server's step semantics, a witness shows an accepted create appending the device's sealed outbox, and rejections show that an accept that also drops another revision, and a server that changes on a "head moved" answer, both fail `ServerFollowsEvent`. For the effect semantics, a witness shows a conditional write that applies, a step whose disk follows its effects and that keeps G2's step predicates. Two rejections show a write performed although its file no longer held the expected content, and a write silently dropped although it did, both failing `DisksFollowEffects`. A lemma proves that a step whose disks follow its effects keeps `G2_Conditional`, so the semantics and that guarantee agree. The collision rules are pinned both ways: a rename that only changes case takes effect, a move into a folder of its own name or onto one of its folders does not, a create next to a file it does not collide with takes effect with a fresh identity, and a create that collides with another spelling, a folder or a name under it does not. `EffectsCanTake` proves every effect sequence has an outcome. For crashes, a witness shows a crash step that lists the first of two requested effects, and rejections show that one listing the second without the first, an effect although nothing was cut short, or another device's step's effects all fail `CrashCutsShort`. So does a crash that lists a prefix of the requested effects but claims to have cut short a user's action or another crash.

### 2.5 Changing the specification

The specification is changed only through `design` issues (`docs/agents/engine-designer.md`), never by a fix or refactor PR. A change to what a guarantee's predicate means, or to the guarantees themselves, needs the owner, as §1 does. A predicate may be made more precise only where its English sentence already says so, and a reviewer checks every predicate against its sentence.

## 3. The core

The verified core lives in `plugin/verified/core/`. It refines the specification of §2: it adds code and proofs, and never changes a predicate. `make verify` proves it. Compiling it to JavaScript and running it against the engine's tests is #965; the shell that executes its effects is #952.

### 3.1 Shape

Each handler is a non-ghost function from what the shell hands the core to the new journal and the effects. The input is the device's platform and journal, the event, the event's input (§2.3: for a local event, the shell's read of every path it names; for the start-up scan, the listing), and the revision id the shell assigns to each document's next outbox. A step of the core is the state before, the event, the effects, and the state after, in which only the event's device's journal is replaced, every disk follows the effects (`DisksFollowEffects`), and the server follows the event (`ServerFollowsEvent`).

### 3.2 The core's invariant

`CoreInv`, which every handler keeps and which #949 and #950 must keep too, has two clauses:

- **A user's delete is never forgotten.** A document whose binding is gone with `absence = UserDeleted` has an outbox, or a base that is a tombstone. The one commit a document sends therefore carries the delete until the server has it.
- **An unsealed outbox is the document as the device last saw it** (`OutboxCurrent`). A bound document's unsealed outbox is live and carries `seen`, the content last seen in its file; a user-deleted document's is a tombstone. A sealed outbox, a commit in flight, carries what it carried when it was sealed. So an outbox not yet in flight never holds content older than the last change the core recorded.

Every step of #949 and #950 must also satisfy `G3_DeleteSeen` (§2.4) and `ServerFollowsEvent` (§2.3), as part of `StepGuarantees`. #949 must also show that the commit it requests for a document is its sealed outbox, persisted before the request and kept until the answer, so an accept in the model always answers it.

### 3.3 Local events and the start-up scan (`LocalEvents.dfy`, #948)

A local file event or the scan reports a change the user already made on disk, so the core requests no disk effect for them, only `PersistJournal`. Every document row the core changes gets an outbox (a sealed outbox, a commit in flight, is never edited, but it counts as one). Base and ahead are never changed here.

- **Created / Modified** of a bound file whose content differs from `seen`: `seen` becomes the new content, and the outbox carries it. A new file stays untracked: the push creates its document (#949), and `PendingPush` counts untracked files.
- **Deleted** of a bound file that is gone: the binding goes, `absence = UserDeleted`, and the outbox carries the tombstone. If the read finds a file again (a new one was created there before the event arrived), nothing changes, and the later create event decides.
- **Renamed:** the document bound to the old name is bound to the new one, with the content read there (G5_RenameKeepsDocument). Another document bound to the new name had its file replaced by the user, so it is unbound as a user's delete, as above.
- **Start-up scan:** a bound file present in the listing whose content differs from `seen`, or that the server does not have as it is, gets an outbox. A bound file missing from the listing is matched to another file only by the one-to-one exact-content rule (E7, §1.3, owner decision 4): exactly one untracked listed file holds exactly `seen`, and no other document whose file is missing last saw that content. Otherwise the document counts as deleted by the user while the app was closed (G8_PicksUpOfflineChanges).

The theorems `LocalEventSafe` and `ScanSafe` prove that from any state satisfying `StateInvariants` and `CoreInv`, the step keeps both and satisfies every step predicate of `Guarantees.dfy` (`StepGuarantees`). `G10_NoLoop`, which relates two sync rounds, does not apply to these steps. The trace guarantees (G3, G4, G6, G10, `G8_AsIfNoCrash`) are proved over whole runs once every transition exists (#966).
