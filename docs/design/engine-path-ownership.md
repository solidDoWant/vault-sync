# Engine path-ownership model and refactor plan

Status: **implemented** (#552; refactor steps R0–R12 of §9.2 have landed, R12 in #576). `SPEC.md` §7/§8 state the user-visible rules by the ids of §4.9 and §5.1, and this document is the reference for the engine's path-ownership state, decisions and invariants. The amendments below record where implementation refined the model. Where the text describes the engine before the refactor, it cites `plugin/src/core/engine/engine.ts` at `cf0bb04` (2,872 lines).

## Decisions (accepted 2026-10-20)

The owner accepted every recommendation below. Refactor steps R0–R12 (§9.2) are tracked as issues under the Phase 2 epic.

1. **Rewrite the engine's ownership core, migrated in steps, instead of more point fixes.** The core is local file identity, path claims, the remote-revision decision and the crash recovery of multi-step changes: about 1,500 of the 2,872 lines (§8.1). The protocol client, upload, merge hook, history/restore, echo suppression, resync/anchors and the journal's IndexedDB layer stay. *Recommended: yes.* The alternative is to keep fixing seeds one at a time. The evidence (§1) says that does not converge.
2. **Keep the point-fix freeze until refactor step R7 lands.** Engine-bug issues stay blocked. *Recommended:* merge #530 (it fixes a real identity bug and adds a regression). Do **not** merge #535's widening of the phantom-delete excuse to edits of existing documents (seed 100117), because the model counts that as an identity violation (§5.5 X-8). Its harness-side tracking of engine writes may merge on its own. #531/#540/#503/#551 fold into refactor step R10.
3. **Journal v3 is migrated from v2, not reset.** *Recommended: migrate (§6.2).* It is cheap, and a reset would turn every edited note into a resync merge.
4. **Detect renames the engine never saw by unique content match on startup.** This covers a rename made while the app was closed, or one lost to a kill before its event was persisted. *Recommended: yes, restricted* to one missing bound file and one new untracked file with the same hash and kind, matched one-to-one (§4.3 E7). It shrinks SPEC §13's last phantom-delete excuse to the case of two identical files, and it preserves history continuity (#167 item 2, #349). If declined, the excuse stays but becomes exact (§5.5 X-2).
5. **Add `fast-check` as a plugin devDependency** for the property-based suite (§9). *Recommended: yes.* Nothing similar is in `plugin/package.json` today.
6. **Separate path merging from the merge hook.** The hook merges content only, and the ownership core decides the result path. This changes the `MergeHook` contract in `plugin/src/core/engine/merge.ts` and the sim's wrapping hook (`sim/engine-observer.ts:457`). *Recommended: yes* (refactor step R9).
7. **Treat Android shared storage as its own case-insensitive file-key platform.** This is #544. *Recommended: yes, as an `F` function (§3.1) behind the same component.* It is a one-function change once the component exists. The decision is whether the fold should follow FAT/sdcardfs case-insensitivity.
8. **Phase 2 exit bar (§10.2):** 7 consecutive green nightly runs at 100 seeds × 3,000 steps with the faithful-filesystem vault and all three platforms, no checker excuse beyond the exact crash window, the property suite green at 100,000 cases a night, and the subsumed identifiers in §8.2 deleted. *Recommended: adopt as written, or name other numbers.*
9. **No server change is required.** One optional change would help: an `ALREADY_EXISTS` error detail naming the live document that holds the path, as `FAILED_PRECONDITION` already carries a `Document` (§6.3). *Recommended: defer to Phase 3.*

## Executive summary

Phase 2 has produced 93 engine and simulation issues in three days (§7), and 1,370 of `engine.ts`'s 2,872 lines are point fixes added after the feature work ended at #217. The root cause is that the engine has no explicit record of which document owns which local file and path. Every decision re-derives ownership from up to eight sources, and four of them are in memory and lost on a crash: the journal's synced path, the pending operations, deferrals and their `merging` marker, `path-taken` conflict records, the in-memory `changes.renames`/`deleted`/`vacated`/`held` sets, `roundRenames`/`roundDeleted`, and the vault listing compared by `pathKey`.

This document replaces that with three durable relations kept in one journal transaction per step:

- what the server has for each document (`base`, `ahead`);
- which local file *is* each document (`binding`);
- what each document will commit (`outbox`).

Ownership of a path is a pure function of those relations and the vault listing. One component answers every "who holds this path" question, under two equivalences: the server's path key `K` and the filesystem's file key `F`. One rule settles collisions: the server's assignment wins the path, and the loser is moved, never overwritten. Multi-step changes are journaled as intents with idempotent recovery.

The model defines 10 invariants (§5), each mapped to a sim check. §5.5 gives a verdict on each of the 18 checker exceptions: 8 keep, 6 narrow, 1 keeps its outcome on a new mechanism, 1 narrows and is later removed, and 2 are removed. Two of them mask real identity violations. The rules are citable as PO-1 to PO-14 (§4.9), and a future exception must cite one. The model also shows that the sim's case-insensitive vault cannot represent the ß/SS cases the engine special-cases. Of the 93 issues classified, 67 violate one of five model concepts (§7). The model subsumes 47 special-case helpers and fields, 64 identifiers in all (§8). The plan is 13 PR-sized steps, each keeping `make test test-sim` green (§9). Rewrite the ownership core in steps, not the whole engine.

## 1. Evidence

- **Growth.** `engine.ts` was 1,498 lines after the last Phase 2 feature PR (#217, platform rules, 2026-10-18). It reached 2,872 lines through 44 commits in the 50 hours after that, all titled `fix(engine): …` except three feature or test commits (`git log --follow`). Every special state named in #552 (parked, held, kept, deferred, vacated, path-take, released) was added in that window (§8 has the commit for each).
- **Accretion pattern.** Ownership questions are answered by 31 private helpers. Each consults a different subset of the sources and has a different folding rule: exact spelling, `pathKey`, `fileKey`, `sameFilesystemName`, or "the vault lists both". Examples: `localMoveAt` (engine.ts:1246), `movedAway` (:1282), `documentAt` (:1307), `followRename` (:1803), `ownFileAt` (:2643), `deletedFile` (:2661), `belongsToDocument` (:1652), `takenByAnother` (:2544), `knownFileKeys` (:1769). Fixes add a clause to one helper. Reviewers then find that a neighbouring helper lacks it (#435, #444, #448, #478, #486, #491, #513, #517 are all "cover/pin helper X's branches" follow-ups).
- **Crash fragility by construction.** Local renames and deletes live in memory (`changes.renames`, `changes.deleted`, `changes.vacated`, `roundRenames`, `roundDeleted`, engine.ts:300–311) until a push turns them into pending operations. Every crash between the user's action and that push loses them, so the engine re-infers identity from paths and contents after restart. That produced the SPEC §13 phantom-delete excuse and the seeds that keep stretching it (#280, #485, #509, #531, #540, #551).
- **The SPEC grew the same way.** SPEC §7 "Conflict copies" and the §8 platform-rules paragraph are single paragraphs of about 2,100 and 1,900 words. Each is a list of `(#NNN)` exceptions, not a rule.
- **The nightly has never been green.** Its only recorded run (2026-10-20) failed. #471 had 10 of 50 seeds failing, and #526 had 7 of 134 retention seeds failing on master after the fixes.

## 2. Scope and principles the model must serve

SPEC §2 principle 1 (no acknowledged write lost; never silently overwrite or drop a user edit), principle 2 (one durable journal), SPEC §6.3 (rename/delete/create semantics), §7 (merge and conflict copies), §8 (client durability, platform rules). The model keeps every user-visible rule in those sections except where §6.4 lists a deliberate change. It does not change the protocol.

## 3. Vocabulary

### 3.1 Three ways to compare paths

| Name | Definition | Who uses it | Where it lives |
|---|---|---|---|
| spelling | the exact string | the vault's listing; what an event reports; what a commit sends | — |
| `K(p)`, the server key | `pathKey(p)` (SPEC §5): NFC, full case folding | server uniqueness and the folder rule; conflict-copy freedom | `plugin/src/core/pathkey` |
| `F(p)`, the file key | the platform filesystem's name equivalence: identity on `posix`; per-UTF-16-unit simple upper case on `windows` (NTFS) and on `android`, Android's shared storage (FAT/sdcardfs, decision 7; a platform of its own since R7a); NFD plus simple upper case on `macos` (APFS) | which spellings name one file on this device | `filesystemKey` in `plugin/src/core/vaultpath/platform.ts`, behind `PathSpace` |

Facts the code base gets wrong today:

- **`K` and `F` are not ordered.** `F` is mostly finer than `K` (`Straße.md`/`STRASSE.md` are one key but two NTFS or APFS files). It is also sometimes coarser: `ı.md` and `I.md` have different keys (`ı` folds to itself), but `sameFilesystemName("ı.md", "I.md", "windows")` is true because `"ı".toUpperCase() === "I"`. The engine uses `fileKey = pathKey` (engine.ts:349) as its file equivalence on `windows`/`macos` and refines it with `sameFilesystemName` in about six places. It therefore has no notion of two different keys that are one file. The server accepts both such documents, the device can hold only one, and the engine believes it holds two. The model needs both relations, and the claim table (§4.2) indexes both. (Amended for #736, decision #52.) Of two live documents with one `F` and two `K`s, an **`F`-alias**, the one whose binding holds the file keeps it. The other is `unmaterializable(alias)` on this device (§4.5 step 3): a non-disk blocker that claims no path, listed with the other unmaterializable documents, and applied once the server moves or deletes the holder. A write through the alias spelling lands in the holder's file and is the holder's edit (PO-10).
- **`K` of `F` is not the exact join of the two (#585, amended in R7a).** The engine's file key on a case-insensitive platform, `PathSpace.fileKey = K∘F`, gives one key to any two spellings with one `F`. It gives one key to two spellings with one `K` except where `F` changes canonical order: on `windows` and `android`, which upper-case without normalizing, U+0345 COMBINING GREEK YPOGEGRAMMENI (combining class 240) becomes U+0399 (class 0), so `α` U+0345 U+0301 and its canonical equivalent `α` U+0301 U+0345 get two file keys. The filesystem holds them as two names as well, so the engine treats them like a `posix` case pair: one `K`, two files. `α` U+0345 U+0301 also shares an `F` with `α ι` U+0301, whose `K` differs, an alias of the `ı`/`I` kind. `macos` decomposes before upper-casing and has no such pair. Per PO-10, code that needs `K` or `F` uses that relation, not the file key.
- **The simulation cannot represent `F` ≠ `K`.** `InMemoryVault` keys files by `pathKey` under `windows`/`macos` (`plugin/src/core/vault/memory.ts:56`). It can never hold `Straße.md` next to `STRASSE.md`, so every engine branch that asks "does the vault hold the two apart" is dead in seeded runs: `heldApart` (:1331), `heldAsOne` (:1345), the `sameFilesystemName` refinements in `documentAt`, and the `#399`/`#447`/`#374` paths. #396 reported this and was deferred to Phase 3. Under this model it is a Phase 2 prerequisite (refactor step R2).

### 3.2 Folder relation

`ancestors(p)` gives the proper folder prefixes of `p`. Two paths *collide* under an equivalence `E` (either `K` or `F`) if `E(p) = E(q)`, or if `E` of one is an ancestor key of the other. Folders are implicit (SPEC §5), so a file collides with every path under a folder of the same name.

## 4. The model

### 4.1 Durable state per document (journal v3)

Each document `D` the journal knows has at most one row in each of these:

| Relation | Meaning | Replaces today |
|---|---|---|
| `base(D)` = `{revId, seq, path, hash, size, kind, deleted, anchor?}` | The last server revision applied to disk or acknowledged: what the server had for D when the device last agreed with it. | `DocumentState`. Its `deleted` currently also means "released" (journal.ts `DocumentState.deleted`). The model removes that overload. |
| `ahead(D)` = `{revision, blocker, merge?}` | The newest server revision of D not yet applied, and why. Blockers: `local-changes`, `path-held` (renamed from `path-conflict`), `invalid-path`, `unmaterializable(cause)`, `out-of-scope`, `too-large`. | `DeferredRevision`. Its `merging` marker moves to an intent (§4.4). |
| `binding(D)` = `{spelling, seen}` or none | **The local file that is D on this device**, at exactly `spelling`. `seen` is the content hash the engine last read or wrote there. No binding means D has no file here, and then `absence(D)` is one of `user-deleted`, `released` or `never`. | Today this is derived from `DocumentState.path`, pending operations, `changes.renames`/`roundRenames`, `changes.deleted`/`roundDeleted`, `changes.vacated`, the merge marker, `path-taken` records and the vault listing, through `followRename`, `localMoveAt`, `movedAway`, `ownFileAt`, `deletedFile`, `localSpelling`, `syncedSpelling`, `fileDeleted` and `carryDelete`. |
| `outbox(D)` = `{revId, baseRevId, path, hash, size, kind, deleted, sealed}` or none | The one commit D will send. `sealed` is set before the first `CommitRevision` is sent. A sealed outbox is never edited. It ends only by acknowledgement, by its `revId` appearing in the feed, or by a definitive refusal (`FAILED_PRECONDITION`/`ALREADY_EXISTS`/`INVALID_ARGUMENT`, none of which commit). | `PendingOperation`, which today allows several per document, added and removed in separate transactions (#371). |

**Amendment (#802, journal v7): who moved the file.** `binding(D)` also records `displaced`: rule W's `displace` intent (§4.4, §4.5 W(a)) put the file at `spelling`, not the user. The intent's final transaction sets it. Any binding the engine records for a new spelling of the file because the user moved it (E1, or the start-up scan finding it under another spelling) clears it, while an edit or an engine write into the same file keeps it. The path merge (§4.7) reads it for a document bound on its tombstone only. Journal v7 (`journalMigrations[6]`, `displacedBindings`) marks every existing binding `displaced`, because a journal before it did not record who moved a file, and that keeps a tombstone's path merge as it was.

Device-wide state stays: the cursor with its anchor, and the conflict log (a UI log only; it is **no longer used as a write-ahead record**, see `moveAside` :1360 and `moveToConflictPath` :2442 today). There is also a new `intents` store (§4.4).

**Untracked files are not stored.** An untracked file is a listed file whose `F` class no binding names. That is the whole definition: a file the user created at a path a binding left is untracked by construction. This replaces `Changes.deleted`, `vacated`, `ownFileAt`, `deletedFile` (#254, #303, #311, #312, #320).

In memory there are only:

- caches;
- the event queue;
- the echo suppressor. Under the model it is an optimization, never a correctness requirement: §4.3 makes every binding transition idempotent, so an echo taken for a user change converges.
- a dirty-path set, which is an optimization; the full scan on start covers its loss.

The model adds no non-durable state that carries identity. This is the rule that `changes.renames`, `changes.deleted`, `changes.vacated`, `roundRenames`, `roundDeleted` and `held` break today.

### 4.2 Path claims (derived, never stored)

At any point, the claim table `C` is computed from the durable state and the vault listing. It records:

- **Disk claims (by `F`).** Each listed file's `F` class is claimed either by the one document whose `binding.spelling` lies in that class, or by an untracked-file token.
- **Server claims (by `K`).** Each document with a live `base` claims `K(base.path)` as *server-known*. Each live `ahead` claims `K(ahead.path)` as *server-newer*, which supersedes `base` for that document.
- **Intended claims (by `K`).** Each unsealed or sealed live `outbox` claims `K(outbox.path)` as *outgoing*. Each open intent reserves the paths it names (§4.4).

The component that computes it (`PathClaims`, §9.1) offers exactly these queries:

- `fileHolder(p)`: the disk claimant of `F(p)` (a document, an untracked file, or none), and the spelling the vault holds;
- `serverHolder(p)`: the document the server is known to have at `K(p)` (newest of `ahead` and `base`), or none;
- `collisions(p, E)`: every claimant colliding with `p` under `E`, the folder relation included;
- `freeCopyName(p, exempt)`: the first conflict-copy name for `p` that collides with no claim under `K` or `F`, other than the claims of the document `exempt` that the operation itself vacates (§4.5). `F` applies to disk claims, the only ones the vault itself holds. Outgoing claims and reserved copy names are checked as names, not folders (amended in R6): a live outbox's file and a written copy are disk claims already, and a delete outbox holds no path. The folders of `exempt`'s result path never block, because the result needs them (#352).

The claim table must satisfy these, at every durable point (they are invariants INV-1 and INV-2 of §5):

- **(C1) Disk exclusivity.** Every listed file's `F` class has exactly one claimant. A binding names a listed file, or is in a transition that an open intent explains.
- **(C2) Server mirror.** No two documents' newest server claims (`ahead` else `base`) collide under `K`. The server enforces this, so a violation can only come from an engine bug or from a pull that has not reached the revision that freed the path, and the decision procedure (§4.5) orders that.
- **(C3) Outgoing exclusivity.** No two live outboxes collide under `K`, and no live outbox collides under `K` with another document's newest server claim unless that document's outbox moves it away. Such a commit would be refused for sure. The engine resolves it before sending (`freeCopyName`), never by a refusal loop.

### 4.3 Local events: binding transitions

Events are taken in order. Each transition below is **one journal transaction**, committed before the event counts as handled. Binding transitions depend only on (bindings, event), never on the vault listing at handling time. Events may lag the disk (SPEC §8; `documentAt(…, bySpelling)` today), and this rule keeps them correct when they do. An event that an open intent predicts (§4.4) is reconciled against the intent instead.

| # | Event (not an echo) | Transition |
|---|---|---|
| E1 | `rename(old → new)`, and some binding `b(D)` names `old` (spelling equal, or `F`-equal under the platform's `F`) | `b.spelling := new`. D keeps its file and identity. This covers case-only renames and respellings: `F` decides, and `K` plays no part. |
| E2 | `rename(old → new)` with no binding at `old` | none. The file was untracked and still is, now at `new`. This is #303. A pending create is a document with an outbox and a binding, so its rename is E1. That covers #286 without `pendingCreateAt`. |
| E3 | `delete(p)`, binding `b(D)` at `p` | remove `b`; `absence(D) := user-deleted`. A later file at `p` is untracked (E5), so it is never D's edit (#254, #312). |
| E4 | `create`/`modify(p)`, binding `b(D)` at `p` | mark D dirty in memory. The push reads the hash. `seen` changes only when the engine reads or writes the file. |
| E5 | `create(p)` with no binding at `p` | none. An untracked file. |
| E6 | any event at a path an open intent reserves | reconciled against the intent's expected outcome (§4.4): if equal it is an echo; otherwise it is applied as E1–E5 after the intent completes. |
| E7 | **start-up scan** (replaces the lost events of a crash or of offline changes) | For each binding whose file is missing: if exactly one untracked file has `hash = seen` and the same kind, and that match is one-to-one, transfer the binding to it (decision 4). Otherwise set `absence := user-deleted`. Every other listed file without a binding is untracked. **E7b** (R11): a file bound to another document E whose content is not E's own `seen` but is the missing binding's `seen` is a candidate too. A match transfers the binding, and E gets `absence := user-deleted` (the vault moves nothing onto an existing file, so E's own file was gone); E may then match a file itself, until no match is left (a rename chain). **Known limit (#827):** the engine has no file identity (§5.4: inodes are the harness's, and SPEC §8 rules out mtimes). So an in-place overwrite of E's file with D's exact `seen` while D's file is deleted, done while the app is closed, is byte-identical to a real move of D's file onto E's vacated path (seed 100117, #793). E7b takes it for that move: D's binding moves to E's file, and E is tombstoned although the user deleted no file of E's. No bytes are lost: the pasted bytes sync as D's content at E's path, and E's previous content stays in E's history, where it can be restored. Narrowing E7b without identity evidence would remove it, and the real move, the common case, would then credit D's file to E (the X-8 identity violation, §5.5). Identity hints recorded in the binding are a separate design step (#828). |

These rules make the following hold without special code. A rename chain `a → b → c` is two E1s. A swap is three E1s through a temporary name, and each document keeps its id; today that path goes through `dependencyOrder` (:2848) and a refused rename. A delete followed by a new file at the same path is E3 then E5. A rename of a file whose spelling differs from its document's path only by `F` is E1, which is #374, #380, #481 and `syncedSpelling`.

### 4.4 Intents: crash-safe multi-step changes

Any change that touches the disk and more than one journal row is an **intent**: a write-ahead record in the `intents` store, written before the first disk step. It is finished by one atomic journal transaction (`Journal.transact`, a new method; IndexedDB supports multi-store transactions) that applies every row change and deletes the intent. Recovery runs at engine start and before every pull and push. For each open intent, recovery inspects the disk and either completes the intent (the disk shows the end state, or a state it can still finish) or rolls it back (the disk still shows the start state). Every disk step carries a precondition (SPEC §8 "Conditional writes"), so recovery never acts on a file the user changed meanwhile. A file the user changed is a local change and is left alone.

| Intent | Disk steps, in order | Final transaction | Recovery by disk state |
|---|---|---|---|
| `apply(D, R)` (clean apply of remote revision R) | rename the bound file to `R.path` if it moved; then write `R.hash` (precondition: `seen`), or delete it (precondition: `seen`) | `base := R`; `binding := {R.path, R.hash}` or none (`absence := never` for a delete); `ahead := none`; **cursor := R.seq** when it comes from the feed | the file at `R.path` hashes to `R.hash`: complete. The file is still at the old spelling with `seen`: redo. Anything else: hand D to the merge path, as a local change. This closes #392: the written file is never untracked, because the intent names it. |
| `merge(D, R, result, copy?)` | write the copy at `copy.path` (precondition: no file); move or rename the local file to `result.path`; write `result.hash` | `base := R`; `binding := {result.path, R.hash if the result equals R, else seen := result.hash}`; superseded outbox dropped; `ahead := none`; conflict-log record added; cursor if from the feed | idempotent per step: a copy present with `copy.hash` counts as written, and a result present with `result.hash` counts as written. It replaces `DeferredRevision.merging`, `resumeMerge` (:1056) and the "logged name reuse" rules, and closes #453, #462, #181 and #358 by construction. |
| `displace(E, from, to)`: move document E's file off a path a server claim needs, keeping E's identity (§4.5 rule W) | `rename(from, to)` | `binding(E).spelling := to`; E's outbox rewritten to `to` (unsealed) or replaced by a new unsealed one, which names the moved content by the hash and size the intent recorded from one read of the file (#770, #775); conflict-log `path-taken` record | the file is at `to`: complete. It is still at `from`: redo. It is gone from both: user deleted it, so `absence(E) := user-deleted`. This replaces `moveAside` (:1360), `moveToConflictPath`'s move (:2511–2528) and `finishConflictMoves` (:1940), and closes #371 and #372. |
| `detach(E, from, to)`: give up E's file at a path the server gives another document, when E cannot be displaced (§4.5 rule W, case b) | `rename(from, to)` | `binding(E) := none`, `absence := released`; E's outbox dropped. The file at `to` is now untracked and is pushed as a new document. | as `displace`. This replaces `releaseFile` (:531), `releaseKeptFile` (:1092), `releaseParkedPath` (:1124), `releaseIdleClaim` (:1208) and `releaseKeptFilesAround` (:1173). |
| `commit(D)` | none, beyond the upload | `outbox := none`; `base := acknowledged revision`; `binding.seen` unchanged; cursor `+1` if it is the next seq (SPEC §6.1 #261) | the outbox is still sealed: retry with the identical request (SPEC §6.2), unchanged from today. |
| `resync` | per-document decisions (§4.6) | cursor reset with its anchor | rerun; each per-document step is itself idempotent |

Two simplifications fall out of this:

- **One transaction per step.** Every multi-row change is atomic, so the code no longer needs the elaborate orderings that SPEC §8 documents, such as "dropped before the release is recorded, an interrupted release is finished by…" and "recorded first, so after a crash between the two only the refused one's removal is left". The ordering is always intent first, then disk, then one transaction.
- **Echo suppression is no longer load-bearing.** A missed echo of an engine rename `a → b`, handled as E1 after the intent completed, finds the binding already at `b` and does nothing. A missed echo of an engine delete finds no binding and does nothing. A missed echo of an engine write whose hash equals `seen` is no change. The `#380`/`#247` echo classes then cost a spurious push round at worst, never an identity change.

### 4.5 Remote revisions: the decision procedure

A pulled revision `R` of document `D` goes through `decideRemote(D, R)`. Each step either finishes or falls through:

1. **Own commit.** If `R.revId = outbox(D).revId`, run the `commit` intent's final transaction. Unchanged from today (:680). The same holds for this device's own create that it moved on (to a path-taken copy, #286) before learning that its commit had landed: D has no base, `R` is D's live first revision, every outbox operation of D is a create or already rebased onto `R`, and the server says this device committed `R` (`R.device_id`). The moved create becomes D's next revision on top of `R`. Amended for #816 (INV-4, PO-12): document ids are shared, so the outbox alone never makes `R` this device's. After a restore every device that held D keeps it as a ghost and re-creates it under the same id (§4.6). Another device's re-create of D is that device's revision of a document with local changes here, so it goes to step 4's merge path, and this device never commits over it. A revision with no known device (an older journal's stored deferral) is not taken as this device's either. Owner: `decideRemote` (`decide.ts`, `ownMovedCreate`).
2. **Non-disk blockers.** If `R.path` fails the vault-relative rule, is out of scope, is larger than the download cap, or is unmaterializable under the platform rules, set `ahead := {R, blocker}`. **A blocker never claims a path on disk.** If D has a binding, D keeps it, with its local changes, as long as no server claim needs the path. If one ever does, rule W case (b) applies. That single rule replaces the five `release*` helpers and closes #379, #390, #391, #398, #452, #459 and #498.
3. **Path claim.** Compute `holder := fileHolder(R.path)` and `collisions(R.path, F)` (folders included). For each claimant `X` that is not D:
   - **Untracked file** with hash `= R.hash`: adopt it. It becomes D's binding, and any outbox create that file had is dropped, since the user's create and the remote create have the same bytes. This replaces `dropCreatesAt` (:1634) and the "applied" branch's holder checks (:760–776).
   - **Untracked file** with other content: `displace` it to `freeCopyName(R.path)` as a `concurrent-create` copy. It stays untracked and is pushed as a new document.
   - **Another document E**: apply **rule W**, below.
   - **Another document E whose newest server claim is not the path under `K` but is one file with it under `F`** (an `F`-alias, §3.1; amended for #736, decision #52): the device cannot hold both. E keeps its file, and D's `ahead := {R, unmaterializable(alias)}`, a non-disk blocker (step 2) that claims no path. A retry applies R once no other live document's newest server claim is an `F`-alias of `R.path` (E renamed or deleted on the server). Moving E aside instead (a copy name) would make the copy a new document on the next push, a duplicate on every device, and a deterministic winner would move user files for no gain.
4. **D's own local state**, from `binding(D)`, `base(D)` and the disk:
   - *clean*: the binding exists, `hash = seen = base.hash`, and there is no outbox. Run the `apply` intent.
   - *dirty* (the bound file changed, or it has an outbox, or `absence = user-deleted`): hand D to the merge path with base `base(D)` and local version = the bound file (or none). Its `local.path` is always `binding(D).spelling`. There is nothing left to *find*, so `followRename` (:1803), `localFile` (:1791), `localMoveAt` and `movedAway` go away. The result path is the path merge of §4.7. Then run the `merge` intent.
   - *absent* (`never`/`released`): no local version. Materialize D at `R.path` with the `apply` intent, as a new document would be.

**Rule W (the server's assignment wins the path; the loser moves, keeping its bytes).** Another document `E` claims, on disk, a path the server has given to D (D's newest server claim is `R.path`, and E's newest server claim is not that path, because the server refused to let them share it):

- **(a) E's binding is there because of a local move of E** (`binding(E).spelling` ≠ `base(E).path`, or E's outbox moves it there): E has a local intent to be at that path. **Displace E** to `freeCopyName(R.path)` under its own id. Its outbox commits it there as a rename (`path-taken`). This keeps SPEC §7's rule that "another document E that a local move put there moves on to a `path-taken` copy under its own id (rule W(a))" (R12 wording; before R12 it read "a known document that a local rename put there … moves on to such a name under its own id").
- **(b) E's binding is at E's own server path, but the server has moved E away** (E has an `ahead` with another path). First try E's `ahead` (`decideRemote(E, ahead(E))`, with a guard against recursion). If that moves E's file off the path, D proceeds. E's `ahead` here is E's newest server claim the pull has in hand: amended for #792 (PO-4(b), PO-11, INV-3), if the feed page being applied has a newer revision of E than its base and its `ahead`, E's `ahead` is a stale claim, and that newer revision is decided first (`ruleW`'s `follow`, `decideRemote(E, newer)` under E's own id, with E's local changes; each page revision is followed at most once, and the feed cursor stays with D's revision). E is detached only on a claim no newer revision supersedes. Amended for #803 (PO-4(b), INV-3): a newer revision on a later page is not in hand while the pull drains the feed, so W(b) never detaches then. D's revision waits as an ordinary `path-conflict` deferral (E keeps its file), and once the feed is drained the pull retries exactly those revisions (`retryPostponed`), when E's `ahead` is the newest server claim the pull has: E has followed a newer revision on a later page, or is detached now. No fetch-ahead and no new journal state: a crash before the retry leaves the `path-conflict` deferral, which the push retries (`retryRefusedPaths`), also outside the feed. If E cannot move (a non-disk blocker such as unmaterializable, out of scope or too large, or a merge the hook deferred), **detach** E. Its file becomes an untracked copy at `freeCopyName`, which is pushed as a new document, so its bytes survive (principle 1). E keeps its server history and materializes later as a new document would. Today SPEC §8 defines this one case at a time, as releaseKeptFile (#390) for a kept file with an edit, the #452 variant for one in a folder of the path, #398 for a file deleted while parked, and #459 for a file moved while parked.
- **(c) Neither.** E's newest server claim *is* the path under `K` (an `F`-alias is step 3's case above, not W(c)). This contradicts C2. Leave D's `ahead := {R, path-held}` and **assert** in tests and the sim. It can only arise from a bug, never from a valid pull order, because the server committed R after E left.

Rule W is the only way a document loses its disk position to another. Every case applies the same three steps: a precondition-checked rename, a binding change, and a conflict-log record. No file is ever deleted to free a path.

**Local commits refused with `ALREADY_EXISTS`.** Pull first, and the holder arrives. If D still has the outbox, `freeCopyName(outbox.path, exempt = D)` gives the copy name, and D is displaced there. Rule W(a) applies from D's side, with folder names included (`freeCopyName` puts the conflict suffix on the outermost colliding folder, #359). If a commit at a copy name is refused again and no claim in `C` explains it, D stays rejected (`path-taken`) and the engine does not try another name. This matches SPEC §7. The difference is that "explains" now has exactly one definition, `collisions(…, K)`. Amended for #846 (PO-4(a), INV-9): the same holds before any commit, when the path merge (§4.7) keeps D's local rename onto a path that another document E holds on disk and whose newest server claim is that path under `K` (rule W gives E `keep`, W(c) from E's side; on a case-insensitive platform E's `Straße.md` and D's `STRASSE.md` are two files). The server will never give D that path, so waiting would keep D's revision `path-conflict` for good. The result goes to `freeCopyName(local path, exempt = D)` under D's own id instead, with a `path-taken` conflict record, and the push commits D there as a rename. Only a result that keeps a local rename moves: a revision whose own path E claims is still W(c), and a holder whose own revision the vault refused (`ruleW`'s `wait`) moves off later, so D waits for it. Owner: the merge path's claim of the result's path (`SyncEngine.applyMerge`, through `claimPath`).

### 4.6 Server restore and retention purge

**Retention purge.** A purge removes non-head revisions only (SPEC §11), so **a purge never changes a claim**: a head is never purged, and claims come from heads. Its only effects are on content. A base purged from the server makes the merge path's `readBaseContent` return null, which leads to `base-purged`, unless the remote revision is known to descend from the base and the local file still hashes to the base (`sha256(local) = base.baseHash`): then nothing is concurrent with the remote content, and the hook takes it (#719; the path merge of §4.7 keeps a local rename). Descent is a durable fact, `descendsFromBase` (amended for #719, §10.1 item 2), on the merge request and on every `DeferredRevision`. Owner: `SyncEngine.applyRevision` (§4.5), which sets it only for a revision from the change feed of an undiverged server, of a document with a base this server has (`seq` ≠ 0), and not behind a deferral without the fact. A server's history of a document is a line, so such a revision descends from every revision this device synced of it. A resync's head never has it: the restore may have lost the base, and the head may be concurrent with it (principle 1). Nor does a revision deferred behind such a head, and a resync clears the fact from every deferral, since the restore may have lost the deferred revision or its base. The retries (`retryMerges`, `retryRefusedPaths`, rule W(b)) take it from the deferral. A deferral without it (one an engine before #719 wrote, too) proves nothing and takes `base-purged`, as before. A retry of a revision that retention has since purged is a new commit: the server has no record of the id any more, so it judges the retry against the head and refuses it as head moved, and the engine takes the head-moved path (#845, X-22). The cursor anchor and own-commit anchors are covered by purge markers (#488, #494). No path-ownership rule depends on retention. The retention bugs in the issue list (§7) are naming and claim bugs that retention happened to expose, as with #299 and #344, plus oracle bugs (#526, #532).

**Server restore (divergence, resync).** The server's heads are re-read (SPEC §8 "Divergence"). For each document:

- no base here → `decideRemote(D, head)` as a new document;
- same revId → renumber `seq`;
- a different head → `decideRemote(D, head)` with D forced *dirty*, so it is merged and never applied over;
- a different head over a base this device only cached (amended for #874, INV-3, INV-6, PO-12; ruling on decision #52) → D is **not** forced dirty, and the head is applied as an ordinary pull. The condition: D's base is live, its bound file still hashes to the base, D has no outbox operation and no deferral, and the base is not a revision this device committed. The evidence for "this device committed it" is `DocumentState.anchor`: the `commit` step records the anchor of every acknowledged commit of this device's, also one a pull acknowledges after its response was lost, and every base this device pulls has none. It is trusted only against a server that sends anchors (the journal's cursor has one); otherwise every document is forced dirty as before. Such a document holds no write of this device's: the lost base is its writer's to send again (#848), and a clean file has nothing concurrent with the head. The head is applied as from an undiverged feed (`descendsFromBase`, so a merge path the apply reaches, a local rename's, takes the head's content), and PO-9's local rename is kept. A head that is a tombstone deletes the unchanged file. This bullet comes before the rollback bullet below: a base the restore rolled back is pulled over too when it was only cached. Principle 1 is not weakened: every write this device acknowledged that the restore lost has an anchor and is still merged or re-pushed, and a file with local changes is still merged, never overwritten. Owner: the restore resync (`SyncEngine.resync`, `cachedOnly`; `applyRevision` with `cachedBase`). A known gap: an own create whose acknowledgement only a resync's head brings (no feed anchor there) is recorded without an anchor;
- a different head that is a live revision this device synced before its live base (`DocumentState.prior`, below), with no outbox or deferred revision for D, and a base this device did not only cache (above) → the restore rolled D back along this device's own history, and nothing on the server is concurrent with what it holds. The head becomes D's base, the bound file is left as it is, and the next push commits this device's version (the lost base, or the local file, which a dirty file already builds on) as D's next revision under its own id. There is no merge and no conflict copy (R7b, #700; principle 1). Owner: the restore resync (`SyncEngine.resync`, `rolledBack`/`fastForward`). A head this device never saw (another device committed after the restore), or one the journal cannot prove an ancestor, takes the bullet above: a merge, or a `base-purged` copy, never an overwrite;
- a document the server no longer has (a *ghost*) → keep its binding, set its base `seq := 0`, and let the next push re-create it. Owner: `planPush` (`push-plan.ts`), which gives every ghost a create under its own id at its bound spelling. A ghost whose path a document the server has, or another outgoing operation, takes yields: rule W's `recreate` displaces it to a copy name under its own id (§4.5). The push that displaces it commits that re-create in the same push, as a restarted push does when it recovers the displace intent and resumes the outbox, so whether the intent finished live or by recovery never changes what the server holds next (#801, INV-7, PO-8). A ghost displaced in place (its file is not in the way of the head that took its synced path) still yields if its spelling is another document's newest server claim under `K`. A re-created ghost keeps its earlier revisions in `prior`, so rule W treats it as a known document's local move, never as an untracked file: a later head whose path collides with its create's spelling under `K` displaces it under its own id. A ghost whose file the user also deleted is forgotten: nothing of it is left anywhere. Amended for #768 (PO-12, INV-2): the resync forgets every ghost that has no binding (`user-deleted`, `released` or `never`) and no outbox, so its base claims no path the restored server's heads may need. It also drops every deferral that is not its document's restored head and whose blocker is not `local-changes` (amended for #848, below: whatever its blocker). Such an `ahead` is no server revision any more (§4.1), a blocker holds no disk claim (PO-11), and this device never had its bytes. A `released` document whose deferral is dropped is forgotten too, and its restored head, if any, is decided as a new document's. When the restored server has a head of it, the document is forgotten in the same journal transaction as the deferral removal, so a crash cannot leave it `released` at its restored base with nothing left to re-derive it (#784, INV-7, INV-9). A ghost with an outbox operation is never forgotten: the push still resolves the operation against the restored server. Amended for #800 (INV-9, INV-7): a `released` document can still have an outbox operation, because `Bindings.unbindOthers` releases without dropping the outbox (the documents a v2 journal's migration bound to one file). The resync keeps such a document past the deferral it drops. Once the operation resolves, the document must not stay `released` with no deferral and no outbox, because nothing would re-derive its file. So the acknowledgement of a live revision of a `released` document that has no other operation forgets the document in the same journal transaction that removes the operation. That covers the commit's response and a pull that finds the commit whose response was lost. The cursor stays before that revision, so the pull decides it as a new document's head: it is materialized at its path, or deferred if it cannot be. Amended for #810: a deferral of the document does not keep it either, because at an acknowledgement a deferral can only be stale, at or before the acknowledged revision. A blocking deferral (`local-changes`, `unmaterializable`, `out-of-scope`, `too-large`) makes the document busy, so its operations are never sent. An engine start re-derives a `path-conflict` deferral into `local-changes` while the outbox holds an operation. A non-busy deferral of a newer revision means the server's head is past the operation's base, so the commit is refused as head moved. The feed lists this device's own revision before any later one. Keeping the document for a stale deferral would leave it `released` with nothing to re-derive its file, because the deferral's retry finds it superseded (INV-9). Forgetting it loses nothing: the acknowledged revision is on the server, the pull re-decides it from the cursor, and that apply step removes the stale deferral (PO-12). An acknowledged tombstone is kept as before. Owner: the `commit` step (`SyncEngine.forgetOnAcknowledge`). A `local-changes` deferral is a merge still owed to a bound file, which keeps both versions (#719). Amended for #838 (PO-12, INV-9): a ghost the resync forgets has no bound file, so no merge is owed. Its deferral is removed in the same journal transaction that forgets it, whatever the deferral's reason, so no deferral outlives its document. Otherwise a `local-changes` deferral of a revision the restored server lost would be left behind: it would refer to a document the journal no longer has, a later start would re-derive it, for example as a `path-conflict` against another document's path, and nothing would resolve it. Owner: `SyncEngine.resync`. Amended for #848 (PO-12, INV-9): a ghost the resync keeps because its file is still bound, or a document whose restored head is its base, would otherwise keep a `local-changes` deferral of a revision the restore lost. A deferral stores only the revision's metadata; its bytes come from the server, which no longer has them, so the merge it owes can never legitimately happen and the deferral is left at quiescence, later re-derived, for example as a `path-conflict`. The #719 reason for keeping a `local-changes` deferral holds only while the server still has the other version. So the resync drops every deferral that is not its document's restored head, whatever its blocker, `local-changes` included. The merge it owed is re-derived from the restored server: a head other than the base goes through the heads loop (`handToMerge`, forced dirty); a head equal to the base needs no merge, and the dirty bound file is pushed as the next revision; no head makes the document a ghost, which the push re-creates from the bound file (#829). This device's version stays in the bound file and is pushed (principle 1); the version the restore lost is its writer's to send again. A `released` document whose deferral is dropped is forgotten as before (#784). Owner: `SyncEngine.resync`.
- an outbox operation whose base the restored server lacks, a live revision or a tombstone (#829, PO-12, INV-8, INV-9) → the server would refuse it for good as "the document does not exist", so it is resolved against the restored server, under the document's own id as a ghost is. In the resync (`SyncEngine.resync`), an operation recorded before the restore becomes a create with no base, under a new revision id since its fields change, and a delete is dropped: the document is gone everywhere and, with no file here, forgotten with the other ghosts that have no binding. In the push (`planPush`), every operation derived for a document whose base the restored server lacks (`lost`: a base with `seq` 0, live or a tombstone) is a create under its own id. That covers a file at the path of a tombstone the restore lost, which revives the document (decision #17) as a create rather than on the lost tombstone. `onBase` takes such a create as on its base.

**`DocumentState.prior` (R7b).** The revisions of D this device synced before its base, newest first, at most 32: each base the row leaves when its base moves to another revision, and the parent (`parent_rev_id`) of each revision it syncs. A document's history on one server is a line, so each is an ancestor of the base. It is the only state the rollback bullet needs. A row written before R7b has none and proves nothing, so it takes the merge.

Bindings are untouched by a resync except through `decideRemote`. A restore therefore cannot move a file's identity, and the rule W precedence applies to the restored heads in feed order. The `resync` intent makes an interrupted resync rerun from the start. Nothing in §4.1–§4.5 changes for restores. The current anchor and purge-marker protocol stays as it is.

### 4.7 Path merge (separated from content merge)

The merge path gets the content merge from the hook and decides the result path itself (decision 6). The rules are the ones SPEC §7 has today. The difference is that each local or remote rename is now a durable fact, not an inference:

- local rename and remote edit: the result goes to `binding(D).spelling`;
- remote rename and local edit: the result goes to `R.path`, and the bound file is renamed there through `F` (a case-only or respelled move is a rename of the same file; #343);
- both renamed: the local rename wins (SPEC §7);
- local delete (`absence = user-deleted`) and remote edit: the edit wins, and D comes back at `R.path`. If a server claim or an untracked file holds `R.path`, §4.5 step 3 applies first. The "another document at the deleted path" special cases of #323 and #451 cannot arise, because a deleted binding holds no path;
- local edit and remote delete: the edit wins. D is re-created on top of the tombstone, at the bound spelling.
- a revision that brings back D bound on its tombstone (another device's re-create after this device's unpushed change won over the delete; §4.5 step 4, #790): the bound file is D's local version. If the user moved that file off the tombstone's path (`binding(D).spelling` differs from it and the binding is not `displaced`, §4.1), the user's rename wins as over any remote revision, and the result goes to the bound spelling. Otherwise the result goes to `R.path`, including when rule W's `displace` moved the file aside to a copy name (ruling on decision #52, amended for #802). A tombstone with no binding has no local rename, so its result also goes to `R.path`.

### 4.8 Per-document state machine

Two of the axes are server-side (`base` and `ahead`), and two are local (`binding`/`absence` and `outbox`). One flat state machine over all of them would have a very large number of states, but the transitions below are complete. Notation: `S` is the server-side state of D as the device knows it, and `L` is the local state.

`S ∈ {Unknown, Live(p), Tomb(p)} × {—, Ahead(R, blocker)}`. `L ∈ {Bound(s, clean|dirty), Absent(user-deleted|released|never)} × {—, Out(op, sealed?)}`

| From (S, L) | Event | Guard | To | Durable step |
|---|---|---|---|---|
| any, `Absent(never)` (no row) | untracked file pushed | — | `Unknown`, `Bound(s, dirty)` + `Out(create)` | one txn: binding + outbox (the document id is minted here) |
| any, `Bound(s,·)` | local edit (E4) | — | `Bound(s, dirty)` | none (in memory). The push derives the outbox. |
| any, `Bound(s,·)` | local rename (E1), case-only and respelled included | `F(s) = F(old)` | `Bound(new, dirty)` | binding txn |
| any, `Bound(s,·)` | local delete (E3) | — | `Absent(user-deleted)` | binding txn |
| `Live/Tomb`, `Bound(s, dirty)` or `Absent(user-deleted)`, no outbox | push | no `ahead` blocker | adds `Out(op)`: an edit/rename/delete from `base` | outbox txn |
| `Tomb(p)`, untracked file at `K(p)` | push | no outbox for D; D not user-deleted since the tombstone was pulled | `Bound(file, dirty)` + `Out(live on Tomb)` (SPEC §8 decision #17) | binding + outbox txn |
| `·`, `Out(op, unsealed)` | push sends | — | `Out(op, sealed)` | outbox txn |
| `·`, `Out(op, sealed)` | ack, or own revId seen in the feed | — | `Live/Tomb(op.path)`, `Bound(·, clean if seen = op.hash)` | `commit` final txn |
| `·`, `Out(op, sealed)` | `FAILED_PRECONDITION` (head moved) | — | pull → `Ahead(R, local-changes)` → merge | pull |
| `·`, `Out(op, sealed)` | `ALREADY_EXISTS` | after the pull, the outbox is still live | `displace(D)` to a copy name; new unsealed outbox | `displace` intent |
| `·`, `Out(op, sealed)` | `INVALID_ARGUMENT` | — | stays; reported rejected; dropped only when its file is gone (SPEC §6.2 #100) | none |
| any | remote R (pull) | §4.5 step 2 blocker | adds `Ahead(R, blocker)` | ahead txn (+ cursor) |
| `·`, `Bound(clean)` / `Absent(never/released)` | remote R | step 3 settled, no blocker | `Live/Tomb(R.path)`, `Bound(R.path, clean)`/`Absent(never)` | `apply` intent (+ cursor) |
| `·`, `Bound(dirty)` / `Absent(user-deleted)` / with `Out` | remote R | — | merge → `Live/Tomb(R.path)`, `Bound(result, dirty)` or `clean` | `merge` intent (+ cursor) |
| `·`, `Bound(·)` | rule W(a) for another document's R | — | `Bound(copy, dirty)` + `Out(rename to copy)` | `displace` intent |
| `Ahead(·, blocker)`, `Bound(·)` | rule W(b) | E's ahead can't move it | `Absent(released)`; its file untracked at the copy | `detach` intent |
| `Ahead(·, blocker)` | blocker lifted (start, scope or cap change, path free) | — | re-run `decideRemote` | as above |
| any | crash at any point | — | recovery of open intents (§4.4); the start-up scan (E7) | see §4.4 |
| any | resync | — | §4.6 | `resync` intent |

Conflict-copy creation is no separate state. A copy is an untracked file the engine wrote inside an intent, which the next push makes a new document. An unmaterializable document is `Ahead(R, unmaterializable)` together with whatever its local axis is. Merge failure (the hook defers, or a precondition fails) leaves `Ahead(R, local-changes)`, the binding unchanged and no intent. It is retried on every push, as today.

### 4.9 Citable rules

From now on, every engine fix, review and simulation checker exception cites one of these ids (§10.1). Each id names a rule defined above.

| Id | Rule | Defined in |
|---|---|---|
| PO-1 | **Identity follows the file.** Only `binding(D)` says which local file is D. Matching names or contents never transfers identity, except where PO-2, PO-3 (the start-up scan, E7), PO-4 or PO-13 explicitly allow it. | §4.1, INV-3 |
| PO-2 | **Binding transitions are event-driven, durable and listing-independent** (E1–E6). Each is one journal transaction before the event counts as handled. A pull or push step does not wait for queued events, so a window remains (#325, closed into #409 unfixed; §7, SPEC §8): a rename handled after a pull wrote another document at its old path counts as that document's, and nothing is lost. Draining the queue before each step is #409's scope. | §4.3 |
| PO-3 | **Crash/offline reconciliation.** Only events not yet persisted at a crash are lost. The start-up scan (E7) sets `user-deleted` for missing bound files, treats unbound files as untracked, and (decision 4) transfers a binding on a unique content match. | §4.3 E7 |
| PO-4 | **The server's assignment wins the path; the loser moves and keeps its bytes.** W(a) displaces a locally moved document under its own id. W(b) resolves a stale holder first, on its newest server claim the pull has in hand (a newer revision on the feed page supersedes its deferral, #792), and otherwise detaches it, leaving its file as a new untracked copy, but only once the pull has drained the feed (a later page may supersede the deferral, #803). W(c) is impossible and asserted. | §4.5 |
| PO-5 | **Non-destructive engine.** Overwrite or delete only the bound file of the document being applied, with precondition `seen`. Untracked files are renamed, never deleted. | INV-4 |
| PO-6 | **Tombstone provenance.** A tombstone comes only from `absence = user-deleted`. | INV-5 |
| PO-7 | **Resurrection provenance.** A live revision on a tombstone comes only from a user-made binding change or an edit that wins over a delete. | INV-6, §4.7 |
| PO-8 | **Intents.** A multi-step change is journaled first, its disk steps carry preconditions, it finishes in one `transact`, and recovery is idempotent from disk and journal alone. | §4.4 |
| PO-9 | **Path merge.** A local rename wins. For a document bound on its tombstone, only the user's move counts, never rule W's `displace` (#802). An edit wins over a delete. A deleted binding holds no path. | §4.7 |
| PO-10 | **Two equivalences.** `F` decides on-device file identity (events, bindings, disk claims). `K` decides server claims and copy-name freedom. Neither implies the other. | §3.1 |
| PO-11 | **Blockers never hold disk claims.** A deferral that is not `local-changes` does not keep another document off a path; PO-4(b) applies. | §4.5 step 2 |
| PO-12 | **History events.** A purge never changes a claim. A restore re-derives the server view through `decideRemote`, with known documents forced dirty, except one whose unchanged file is at a base this device only cached (#874). Bindings change only through PO-4. | §4.6 |
| PO-13 | **Tombstone re-creation.** An untracked file at a pulled tombstone's `K` becomes that document's revision (decision #17), unless the user deleted it locally since the tombstone was pulled. An edit committed after a delete is committed first, so it survives as a new document (SPEC §6.3, #545). | §4.8 |
| PO-14 | **Copy names.** `freeCopyName(p, exempt)` is the only namer. It checks every claim under `K` and disk claims under `F` as well (§4.2). Disk, server-known and server-newer claims hold their folders; outgoing and reserved claims are checked as names only. The outermost folder of `p` that a claim holding folders blocks, under `K` or (for a disk claim) `F`, gets the suffix (#359, #596). It exempts only the claims the operation itself vacates. | §4.2, §4.5 |

## 5. Invariants

### 5.1 What the model guarantees

| Id | Invariant | Holds at |
|---|---|---|
| INV-1 | **Disk exclusivity (C1).** Each listed file's `F` class has exactly one claimant (a binding or an untracked token), and every binding names a listed file or an open intent explains its absence. | every durable point |
| INV-2 | **Journal single holder (C2, C3).** No two documents' newest server claims collide under `K`. No two live outboxes collide under `K`. | every durable point |
| INV-3 | **Identity follows the file.** A file's content becomes another document's content only by: E1 (the user's rename), the engine's own `displace` of that same document, adoption of an untracked file whose bytes equal the revision's (§4.5 step 3), the start-up scan's unique content match (E7/E7b, PO-3), or the tombstone re-creation rule (§4.8). Matching names or contents never transfers identity in any other case. | every transition |
| INV-4 | **Non-destructive engine.** The engine overwrites or deletes only a file bound to the document whose revision it applies, with precondition `seen`. It never deletes an untracked file; it renames it instead. Every byte the user wrote is, at every durable point, in a file, in server history, or in an open intent's copy step. | every disk step |
| INV-5 | **Tombstone provenance.** The engine commits `deleted = true` for D only from `absence(D) = user-deleted`, set by E3 or E7. | every commit |
| INV-6 | **Resurrection provenance.** The engine commits a live revision on top of D's tombstone only from a binding the user created or changed (E1/E4/E5 adoption under §4.8 row "Tomb"), or from an edit that wins over a remote delete (§4.7). | every commit |
| INV-7 | **Recoverability.** Every open intent can be completed or rolled back from the disk and journal alone. Crashing at any journal write and restarting reaches the same quiescent state as not crashing, modulo conflict-copy names and time. | every journal write |
| INV-8 | **Bounded progress.** Every claim conflict is resolved within one push, by rule W or a copy name, unless the user must act (`rejected`). No blocker holds a disk path once a server claim needs it. A push round commits only operations whose base is the current base. | every push |
| INV-9 | **Convergence.** After quiescence: bindings equal the server's live heads (modulo `unmaterializable`/`out-of-scope`), with spellings equal to server paths, where folder segments compare under `F` and the final segment exactly (amended for #737: a folder has one spelling on disk, so with `notes/` there the server's `Notes/x.md` is held as `notes/x.md`, and two live documents may spell one folder two ways); no outbox; no `ahead` except non-disk blockers of documents the device cannot hold (including the later of two live documents that are one file under `F`, §3.1); cursor = feed end. | quiescence |
| INV-10 | **Echo independence.** Losing any echo suppression record changes no binding and no server state beyond a no-op push round. Echo records match events under `F` (PO-10, #737): an engine write at `Notes/x.md` that the filesystem lands in its `notes/` folder is still the engine's own. | every event |

### 5.2 Mapping to the simulation and tests

| Model | Sim/test check today | Change needed |
|---|---|---|
| INV-1 | none (unit tests only, #478 "no journal holds two live documents at one path key") | add `journal-holder`, checked **after every step**, not only at quiescence, by the engine observer over `binding` + listing. It needs the faithful `F` vault (R2). |
| INV-2 | server `path-key`/`path-folder` (Go, `sim/invariants_test.go`), only for the server | add the engine-side half to `journal-holder` |
| INV-3 | none directly; violations show up late as `phantom-delete` or `engine-convergence` | new `identity` invariant over harness inodes (§5.4): each engine commit of document D at content H must trace to a file lineage the harness has bound to D |
| INV-4 | `lost-write` (`sim/invariants.ts:194`) | keep. Stop trusting the merge hook's `mergedInto` record without verification (#301 already notes it): verify the merged result's hash is in a vault or in history. |
| INV-5 | `phantom-delete` (:242) | redefine on inodes (§5.4). Narrow the crash excuse to an exact window (§5.5 X-2). |
| INV-6 | `resurrected-delete` (:340) | keep, and redefine "a change at the document's paths" on inodes instead of path-key matching |
| INV-7 | ad hoc crash scenarios (`haltOnPending`, `haltOnDeferralRemoval`, engine-observer.ts:364–376); seeded crashes only at schedule steps | property suite with crash-at-every-journal-write (§9.3, P3). The sim adds a schedule op "crash at the Nth journal write of the next push or pull". |
| INV-8 | `liveness` (runner.ts:209, :335); `engine-deferred` | keep |
| INV-9 | `engine-convergence`, `engine-deferred`, `engine-unmaterializable` (engine-observer.ts:388–431) | keep. Make the `kept` exemption (:397) compare under `F` (#346). Compare folder segments under `F` and the final segment exactly (§5.5 X-19, #737). |
| INV-10 | `engine-echo` (:391) | keep, but compare under `F`, not `K` (§5.5 X-1). Engine side done (#737): `EchoSuppressor` keys its records by `F`. |

### 5.3 Headline findings about the checker

The verdicts on every exception are in §5.5. The three findings that matter most:

1. **The crash-lost-rename excuse is being widened to cover identity transfers that the project already treats as engine bugs.** #535 (open) excuses seed 100117, where the restarted engine committed c1.d5's content as an edit of the existing c1.d7 and tombstoned c1.d5. #530 (open) fixes that same shape as an engine bug when no crash is involved ("It committed X's bytes as an edit of D and then a tombstone for X"). The same engine behaviour cannot be a bug without a crash and a false positive with one. Under PO-1/PO-2 it is a bug both ways, except in the narrow window where the rename events were never persisted (§5.5 X-2, X-8).
2. **The phantom-delete oracle consults the system under test.** `EngineUser.documentsAt` (sim/engine-user.ts:149) asks the engine's journal which document the user's delete removed. A wrong binding in the engine is then credited as the user's delete (#532). Any oracle must be independent of the engine (§5.4).
3. **The simulated filesystem cannot represent the cases the engine special-cases most.** `InMemoryVault` folds by `pathKey`, so the sim can neither produce nor detect `F ≠ K` behaviour. That leaves every `heldApart`/`heldAsOne`/`sameFilesystemName` branch without seeded coverage, and the ı/I case (where `F` is the coarser key) unmodelled.

### 5.4 Harness inodes (oracle independence)

`InMemoryVault` gets a harness-only API: `inodeOf(path)` and an inode-tagged event tap that records the actor (user handle vs engine handle; the sim already wraps the engine's vault in `MutableVault`, engine-observer.ts:519). Rules:

- a user create mints an inode;
- a rename (by anyone) keeps the inode;
- a write keeps it;
- a delete ends it.

The engine never sees inodes. The harness binds an inode to a document when the engine commits a revision for D whose path and content hash match the inode at that moment, or when the engine's `apply` writes R's content to a path. Then:

- **phantom-delete:** a tombstone of D must follow the user's delete of the inode bound to D;
- **identity:** an engine commit of D must come from the inode bound to D, or from an untracked inode adopted under INV-3;
- **resurrected-delete:** the live revision must come from an inode the user wrote or renamed after the tombstone.

None of these reads the engine's journal.

### 5.5 Verdicts on every existing checker exception

This table covers every exception or relaxation in the simulation checker on master (`sim/invariants.ts`, `sim/engine-observer.ts`, `sim/engine-user.ts`), plus those added by #497 and #512 (merged) and those proposed in #535 (for #531/#540, open). Verdicts:

- **KEEP**: the outcome the exception allows is correct under the cited rule.
- **NARROW**: keep it only as stated.
- **REMOVE**: it masks a real engine bug.

A new exception is allowed only if it cites a PO rule under which the flagged outcome is correct (§10.1).

| Id | Exception (where, origin) | What it allows | Verdict | Reason (rule) |
|---|---|---|---|---|
| X-1 | Echo check matches paths by `pathKey` on windows/macos (`checkEngineEchoes`, invariants.ts:391; #241/#247) | an engine-reported change at any spelling with the same key as a user-touched path | **NARROW** to `F` | PO-10: `Straße.md`/`STRASSE.md` are two files on NTFS/APFS, so an echo of one is not excused by a user change of the other. That is the #380 class. |
| X-2 | `renameLostToCrash` base clause (invariants.ts:274; #287 for #280) | a tombstone of D if the user renamed D's file, the app crashed afterwards, and the engine then committed the renamed content as another document | **NARROW** | PO-2/PO-3: excused only if (i) the crash came after the rename and before the engine's next settled point (the event was not persisted), and (ii) the content was committed as a **new** document, its first revision. With decision 4, also (iii) E7 found no unique content match. Outside the window, the tombstone is a PO-2 violation. |
| X-3 | `copiedFrom`: the create may be at this engine's own conflict copy of a renamed path (invariants.ts:288, :304; #497 for #485) | the excused create is at `X (conflict eN …)` | **KEEP**, inside the narrowed X-2 | PO-4(a)/PO-14: a create refused with `ALREADY_EXISTS` is displaced to a copy name under its own id. The copy is the renamed file. |
| X-4 | `EngineUser.engineRenamed`/`movedDocuments`/`UserLedger.movedByEngine`: deleting the engine's displaced copy counts as the user's delete of the documents at the original path (engine-user.ts:120–140; #512 for #509) | a tombstone of a document whose file the engine moved to a copy and the user then deleted | **KEEP the outcome, REMOVE the mechanism** | PO-4(a) plus PO-6: a displaced document keeps its identity, so the user's delete of the copy is its delete. The mechanism keys by exact path and reads the journal under test. Replace it with harness inodes (§5.4), which follow every rename. |
| X-5 | `EngineUser.documentsAt` takes "which documents the user deleted" from the engine's own journal (`findDocumentByPath`, `listPending`; engine-user.ts:149) | any tombstone the engine's journal attributes to the user's delete | **REMOVE** | Circular oracle: an engine with a wrong binding gets its own wrong delete excused. #532 is the symptom. Replace it with inodes (§5.4). The real bug it can mask is any PO-1 violation that ends in a tombstone (#526 cause A is one). |
| X-6 | #535 `UserLedger.writtenByEngine`: the renamed file is followed through content the engine wrote into it (seeds 100042, 100124) | the excused create carries a merge result the engine wrote into the renamed file before the crash | **KEEP**, inside X-2, through inodes | PO-1: what the engine writes into D's bound file is D's file's content. With inodes, "the file's content" needs no ledger of hashes. |
| X-7 | #535 `UserRename.deletedAt`: the user deleted the renamed file after the crash, before any create (seed 100037) | a tombstone of D with no create at all | **NARROW** | PO-3/PO-6: allowed only inside the X-2 window, and only if the inode the user deleted is the one that was D's file. The outcome (file gone, D tombstoned) then matches the user's final action. Outside the window it is a lost-rename bug. |
| X-8 | #535 `movedAwayByLostRename` chain clause (seed 100117: the restarted engine committed c1.d5's content as an **edit of the existing** c1.d7 and tombstoned c1.d5) | an identity transfer between two existing documents | **NARROW to the window, then REMOVE** (removed in R11, #575: `sim/lineage.ts` excuses a lost rename's commit only as a new document) | Outside the X-2 window this is a PO-1 violation, the same shape #530 fixes as an engine bug. Inside the window, the PO-3 scan sees c1.d7's bound path holding new content and reports an edit, so the model reproduces it. Allow it only in the window with both renames unpersisted. Remove it when E7 is extended to "a bound file whose content equals another missing binding's `seen` and not its own" (refactor step R11). |
| X-9 | #535 `earlier.from === path` and no-crash-between tightenings (#540) | — (they restrict X-8) | **KEEP** until X-8 is removed | restricts X-8 |
| X-10 | `resurrected-delete` allows scripted clients, and user writes or renames at the document's paths (by key) not already carried (`explained`, invariants.ts:368; #281) | a live revision after a tombstone | **KEEP; NARROW matching to inodes** | PO-7. Path-key matching over-credits: a user write to another file with the same key would excuse a resurrection. Inodes make it exact. Narrowed for #769 in the property oracle (`PropertyWorld.checkCommit`): a user rename counts as carried only if a revision of the document at its exact path was made since the rename. A rename that is not pushed yet, back to a spelling the document had earlier, is a binding change that wins over a later remote delete (§4 R5b). |
| X-11 | `lost-write` treats content the merge hook *reported* as `mergedInto` as surviving if the result survives (`UserLedger.merged`; #301) | a write the hook claims it merged | **NARROW** | PO-8: the merge intent records result and copy hashes, so the checker verifies them against vaults and history instead of trusting the hook. A hook that drops the local edit but reports a merge must fail. |
| X-12 | `lost-write` excludes contents the user replaced (`replaced`) | the user overwrote or deleted their own write | **KEEP** | Principle 1 owes only writes the user did not replace. Amended for #736 (PO-10): the ledger follows a write by the file it lands in, matching paths as the vault looks files up (`pathMatcher`: `F` on the faithful filesystem, `K` of `F` on the folded one), not by `K`. A write through an alias spelling (`ı.md` into the file `I.md`) is then replaced by a later overwrite of that file under either spelling, and the user's delete of `STRASSE.md` no longer ends the tracking of a write in the separate file `Straße.md`. A write that survives nowhere under its file is still flagged. |
| X-13 | Retention: content purged by retention counts as surviving, and the phantom/resurrection checks see purged revisions (#297, #229) | a write that exists only in purged history | **KEEP** | PO-12 and SPEC §2: "until an explicit, retention-governed purge". A purged *head* is never excused (`retention-head`), and that stays. |
| X-14 | `engine-convergence` exempts unmaterializable documents' kept files (`kept`, engine-observer.ts:397), compared by exact string and taken from `engine.unmaterializable()` (#346) | a local file that is no live document's | **NARROW** | PO-11/PO-4(b): a kept file is legal only while no server claim needs its path. Compare by `F` and derive the expected set from the harness: documents the user edited that became unmaterializable. Trusting the engine's own report can hide a kept file that should have been detached. |
| X-15 | Convergence and `engine-deferred` skip paths the platform cannot hold (`harnessUnmaterializable`) and out-of-scope deferrals (engine-observer.ts:404, :426) | missing files and lingering deferrals for documents the device cannot or must not hold | **KEEP** | PO-11: non-disk blockers are legitimate end states. The harness computes "cannot hold" itself, so this is not circular. Extended for #736 (decision #52, PO-10/PO-11): of a group of live documents that are one file under `F` but differ under `K` (`harnessAliases`), the device must hold exactly one with its server content, and must report the others as unmaterializable. Extended for #769 in the property oracle (`PropertyWorld.convergence`): the kept file of a document deferred as `alias` is exempt as the kept file of a refused path is (X-14). The harness decides that the document's path is an `F`-alias of another live document's path, not the engine. |
| X-16 | Tombstones and live revisions by scripted clients are always excused (invariants.ts:251, :355) | anything a scripted client commits | **KEEP** | Scripted clients act only on schedule. They are the oracle's reference. |
| X-17 | `AppKilled` and halted calls count as interruptions, not failures (#384) | the engine's work stops at a kill point | **KEEP** | PO-8 requires recovery from exactly these. |
| X-18 | The `InMemoryVault` case-insensitive mode folds by `pathKey` (memory.ts:56) | not an exception, but every `F ≠ K` behaviour is invisible | **REMOVED** (refactor step R2 added the faithful filesystem; R7d made it the seeded default; #797 deleted the folded mode, so every in-memory vault, in the scripted scenarios, the engine unit tests and every regression replay too, takes two spellings for one file by `F` alone) | PO-10. It hid the ß/SS, NFC/NFD-on-Windows and ı/I cases the engine special-cases (#399, #447, #374). |
| X-19 | `engine-convergence` compares a live document's path with the vault's files with folder segments under `F` and the final segment exact (engine-observer.ts `convergenceKey`; #737, decision #52) | a live document at `Notes/x.md` held as `notes/x.md` | **KEEP** | PO-10: `F` decides on-device file identity, and a folder has one spelling on disk. The engine does not respell folders: two live documents can spell one folder two ways (`Notes/x.md`, `notes/y.md`), so no folder spelling satisfies both. INV-9 is amended to match (§5.1). A file's own name still compares exactly. |
| X-20 | The property oracle (`PropertyWorld.detached`, engine/testing.ts; #770) unbinds an inode when the engine moves it to a conflict-copy name from a path where its document D was synced (a revision of D there, and no user rename of the inode onto it since), while the server's live head of D claims another path that D is blocked from (narrowed for #781: the harness's own check that the platform cannot hold the head's path, or that another live document's path is its `F`-alias; the property world has no scope or download cap) | P1's identity check of the copy's create as a new document | **KEEP** | PO-4(b), PO-11: a blocked holder (here unmaterializable) at its synced path that a server claim needs is detached, and its file is an untracked copy the push commits as a new document, so its bytes survive (principle 1). The rule is computed from harness inodes and the server, not the journal. A displaced document (W(a), a local move: no revision of D at the path, or a user rename onto it since) stays bound, so a displaced file committed as a new document is still flagged. So does a document that could follow its head, or whose head is back at the file's path (oracle tests in engine/properties.test.ts). Since #792 the engine follows such a document's newer revision when it is on the feed page being applied, and since #803 when it is on a later page of the same pull (§4.5 W(b)); only a move another device commits while the pull runs, after it read the feed's last page, still leads to such a detach, which the oracle tests use and P1 flags. |
| X-21 | The property oracle (`PropertyWorld.checkCommit`, engine/testing.ts; #769) takes bytes that the remote device committed to document D in an observed revision of D as D's own, even when it committed them to another document first (`origins` records the first writer of a hash) | P1's "carries the remote write to another document" check of a create or edit of D | **KEEP** | PO-1: identity is the inode, which the oracle's inode checks still test exactly. `move-onto-incoming` (#757) gives a new document a known file's bytes on purpose, so the origin of a hash does not identify one document. The rule is computed from the server's observed history, not from the journal. |
| X-22 | The network's refused-retry check (`SimNetwork.checkRetry`, sim/network.ts; #845) excuses a retry of an applied commit refused with `FAILED_PRECONDITION` if retention purged that revision before the retry was delivered and the document's head had moved past it | the `protocol` violation for that refusal; every other code, a revision not purged (or purged only after the delivery), and a purged revision still at the head are still flagged | **KEEP** | PO-12 and SPEC §11/§2: a non-head revision is purgeable, and the server cannot return what it deleted; the content survives in the descendant and on the device. The server judges such a retry as a new commit against the head (SPEC §6.2), and the client takes the head-moved, then `base-purged`, path: a merge or a conflict copy, never an overwrite. |

Net effect: X-5 and X-18 go. X-8 shrinks to the crash window and then goes. X-1, X-2, X-7, X-10, X-11 and X-14 narrow. X-4 and X-6 keep their outcomes but move to inodes. Only X-2 (with X-3, X-6, X-7 inside it) depends on the engine's crash timing, and it becomes exact.

## 6. Journal, protocol and SPEC consequences

### 6.1 Journal v3 schema (append-only migration, `plugin/src/core/journal/indexeddb.ts` `journalMigrations[2]`)

| Store | Key | Content | Indexes |
|---|---|---|---|
| `documents` (existing) | `documentId` | `base` fields as today; `absence: "user-deleted" \| "released" \| "never" \| null`; `binding: {spelling, fileKey, seen} \| null`. `deleted` keeps meaning "the base is a tombstone" only. | existing `path`; new `binding.fileKey`; new `baseKey` (`K(base.path)` of a live base) |
| `pending` (existing) | auto | now the outbox. New writes keep at most one per document (enforced by `transact`); `sealed: boolean` added | existing `revisionId`; new `documentId` |
| `deferred` (existing) | `revision.documentId` | `ahead`; `merging` no longer written | — |
| `intents` (new) | auto | `{id, kind, documentId, steps…}` (§4.4) | `documentId` |
| `conflicts` (existing) | auto | unchanged; no longer read as a write-ahead record | existing |
| `meta` (existing) | — | cursor and anchor | — |

New `Journal` methods:

- `transact(changes)`: one IndexedDB transaction over several stores, `strict` durability, all or nothing. Every final step in §4.4 uses it.
- `documentByFileKey(fk)`: an index probe. It replaces the `listDocuments()` scans of `documentAt` (#250).
- `documentsByFileKey(fk)`: every row bound at `fk`, an index read. Bindings unbinds every other document at a file it binds (C1) by it, so a document bound by the v2 migration (§6.2) next to another at one file key is found even when the probe would return the written document itself (#631). A rename (E1) reads every row at the source key the same way: the first, the lowest document id, keeps the moved file, and every other is unbound with `absence = released`, since the user deleted nothing (#641).
- `putIntent` / `listIntents` / `removeIntent`, with the remove running inside `transact`.

`Journal` conformance (`plugin/src/core/journal/conformance.ts`) gains `transact` atomicity under injected failure. That suite already runs inside real Obsidian in e2e (SPEC §13), so Android WebView IndexedDB multi-store transactions get covered the same way.

### 6.2 Migrating v2 journals

The migration runs inside the `versionchange` transaction, so it cannot read the disk. It only adds information:

- Every live `documents` row gets `binding = {spelling: path, fileKey: F(path), seen: baseHash}`.
- A deleted row whose document has an `unmaterializable` deferral gets `absence = released`, no binding and `deleted` cleared to the base's real tombstone flag. A release always stored `deleted: true` over a live base, and the deferral's `revision` is live, so the base is live.
- Other deleted rows get `absence = never`.
- Pending operations, per document in key order:
  - the last non-delete op's `path` becomes the binding spelling;
  - a final delete op sets `absence = user-deleted`;
  - a pending create gets a `documents` row with no base and a binding at its path.
- A document with several pending ops, which v2 can leave after a crash (#371), keeps them in order as legacy ops, all marked `sealed`, since any may have been sent. Legacy ops drain one at a time before any new op is derived. Only that drain keeps today's `finishConflictMoves` behaviour, and the code is deleted once no v3 journal can hold legacy ops (a later migration can assert none are left).
- A `merging` marker becomes a `merge` intent with no copy step. Recovery completes it if the disk shows the recorded result and otherwise drops it, so the merge runs again.

The in-memory renames and deletes are lost on upgrade, as they are on any restart today. The first start's full scan (E7) applies.

**Amendment (R3, #567): the v3 migration only adds.** R3 ships the migration while the engine still reads every v2 field (§9.2: "nothing reads them yet"), so the parts above that rewrite a v2 field would change today's behaviour. The R3 migration (`deriveV3Records` in `journal/indexeddb.ts`) therefore:

- writes `binding`, `absence` and `sealed` as above, with two refinements: a document's last pending operation decides alone (a delete gives `absence = user-deleted`, any other operation the binding at its path with `seen` = its content hash), and **every** migrated pending operation is sealed, not only those of documents with several, since any v2 operation may have been sent;
- leaves `deleted: true` on released rows (the base's tombstone flag is then `false`, as a release always stored `deleted: true` over a live base), keeps `DeferredRevision.merging`, and adds no `documents` row for a pending create.

The rest of the list moves to the step that deletes the v2 reader, as an append-only migration of its own: clearing `deleted` on `released` rows and rows for pending creates with R5 or R7, and `merging` to a `merge` intent with R8. The file key `F` depends on the platform, which a `versionchange` transaction cannot know: `IndexedDbJournal.open` takes it as `JournalOpenOptions.fileKey` (the plugin passes `filesystemKey` for the device's platform; POSIX's identity by default). Until R4 makes the engine maintain bindings, the engine's own `putDocument` calls leave a row's `binding` as the spread of the old row or drop it, so R4 must re-derive every binding at its first start (or with a migration) rather than trust a row written between R3 and R4.

**Amendment (R4, #568): bindings in shadow mode.** R4 re-derives with a migration: journal v4 (`journalMigrations[3]`) runs `deriveV3Records` over every document again and changes only `binding` and `absence`. From then on every engine write of a document row goes through `Bindings` (`engine/bindings.ts`), one at a time, and takes the binding from the row as it stands when written, so an event's transition and an engine write never lose each other's change. The engine's own moves are E1, and its deletes leave the document `released` unless the write that follows says otherwise (an applied tombstone: `never`). A binding of another document at a file key being bound is cleared, so no two bindings share one (C1). Two gaps stay until later steps, and the shadow check reports them: a pending create has no row until R5 (as amended in R3), so a rename of its file before the commit is acknowledged is not followed, and the document is bound at the commit's path; and the start-up scan has no content match until R11, so a rename made while the app was not running unbinds the document as `user-deleted`, as today's derived ownership loses it too.

**Amendment (R5a, #622): pending creates and local moves as bindings.** R5 is split in two: R5a (#622) moves the push's local changes into bindings, and R5b (#569) replaces `detectChanges`' inference with outbox derivation (`engine/push-plan.ts`) and deletes what is left of R5's list (`held`, `restoreChanges`, the `contentMissing` carry, the inference). R5a makes these changes:

- **A pending create has a row.** When the push records a create of a document the journal does not have, `Bindings.created` writes the pending operation and the document's row in one transaction: no base (`revisionId` empty, `hasBase` false; `deleted` stays set until R7, so live-document lookups skip it) and bound to the file the create reads. This is the E2 note of §4.3, and the row survives a crash and a restart. `Bindings.dropped` removes such a row in the transaction that removes the create's last operation. A create recorded before R5a gets its row at the next start-up scan. No schema change, so no migration.
- **Local moves come from bindings.** `Bindings.moves` lists every document bound at a spelling other than its synced path (for a pending create, other than the path its create reads). `Changes` keeps only `all` and `paths`, and `roundRenames`, `roundDeleted`, `carryDelete`, `fileDeleted`, `deletedFile`, `ownFileAt` and `syncedSpelling` are gone. A user's delete is the document's `user-deleted` absence (E3) until something binds the document again, not until the end of a push round. The `adopted` binding change covers the one case the push binds itself: the deleted document's synced content is back in a file at its path, which the push takes as its file again.
- **E7 respells.** On a case-insensitive platform, the scan gives a binding the spelling the vault lists for its file when the vault lists exactly one `F`-equal spelling and not the binding's own. That is a rename made while the app was not watching that only the spelling shows.
- **The scan races with events.** The scan reads the disk after the events of its first moments. A rename event that arrived while the scan ran, from a file the scan found missing, moves that document's binding as E1 would, rather than leaving the document `user-deleted`. The vault moves only an existing file, so the file was there when the event happened. It is the document's own file unless an event during the scan put another file at that key first (amended for #758, below).
- **An engine write keeps the file's spelling.** A write of a document's file at another `F`-equal spelling of the file it is bound to (a merge into a file the user respelled by case) keeps the binding's spelling, because the vault keeps the file's name.
- **The bound file decides two holder questions.** A rename refused with `ALREADY_EXISTS` moves the file at its path to a conflict copy when that file is bound to the renamed document, even if another document is still synced at that path (a swap; §4.3's swap note). A remote delete of a document whose file the user deleted, at a path another document's binding now holds, is applied with nothing to delete (#267).

The shadow check stays until R7, but it is no longer independent for moves: `followRename`, `movedAway` and `localMoveAt` now read local moves from bindings.

**Amendment (R5b, #569): outbox derivation.** `engine/push-plan.ts` (`planPush`) derives the push's operations from (base, binding) and the untracked files, at most one per document, as §4.8's rows say. `held`, `restoreChanges`, the `contentMissing` carry and `detectChanges`' inference are gone. Three details:

- **The dirty-path set stays in memory**, as §4.1 allows: it says which files to read, never which document a file is. A path leaves it only once a push round decided it and it has not changed since (a clock per path), so a failed round loses nothing and a path a busy document holds waits for every later push without scheduling one.
- **A busy document's synced path waits with it.** A create at a path whose server claim belongs to a document with an outbox (a rename away still pending) would be refused (C3), so it waits for that outbox. Amended for #847 (PO-11, INV-8, INV-9): the waiting runs one way only. A document's own operation waits for its busy state or a busy path it claims (its bound file), never for its synced path, which a rename leaves. A blocked document's file kept at that path (a `too-large` or `unmaterializable` deferral, PO-11) used to hold the rename of the document the server had moved onto it, so the server kept that document there for good. Owner: `planPush`.
- **The path merge starts in `engine/decide.ts`.** `movedBeforeDelete` is §4.7's "local rename against remote delete" rule, read from the binding alone; the rest of `decideRemote` lands with R7. A vault keeps the bound spelling when the engine writes the bound file under another spelling `F` takes for it (`Bindings.put`), as R5a's "an engine write keeps the file's spelling" says.

**Amendment (R7c, #571): the merge path's local version from the binding.** R7 is split in four: R7a (#699) adds the Android file key, R7b (#700) adds the path claim, rule W and the `displace`/`detach` intents, R7c (#571) deletes the rest of R7's list, and R7d (#701) makes the faithful filesystem the simulation's default. R7c deletes `localMoveAt`, `movedAway`, `followRename`, `localFile`, `documentAt`, `heldApart`, `heldAsOne`, `localSpelling`, `matchSpelling`, `dropCreatesAt`, `dropOperationsAt`, `renameFollowsCopy`, `forgetRenamesFrom`, `Bindings.moves` and the shadow check (`SyncEngine.bindingShadow`, the `binding-shadow` trace lines and their nightly report). Details:

- **Local version (§4.5 step 4).** The merge path reads D's local version from `binding(D)` alone: the bound file; none for `user-deleted`; and for a document with no file here (`never`, `released`, a tombstone, a new document) the untracked file at `R.path`. Two cases are left where a live document with no binding has a local version, both an untracked file. The first is the file at the path where its interrupted merge moved it, which the merge's record on the deferral names (PO-8, until R8's `merge` intent replaces the record). The second is a file at its synced path that the user saved again after deleting it (an editor saving through a delete and a create, #380). The second differs from §4.5 step 4, which gives such a document no local version. It is kept because the #380 scenario tests assert its vault outcome (§9.2's rule for existing tests). The push still treats such a file as a new document unless it holds the synced content (R5a, §6.4 item 7).
- **Adoption (§4.5 step 3).** A file the pull applies a revision to, or the merge takes or keeps as a conflict copy, supersedes the create bound to it (`supersedeCreates`): its outbox goes, and with it the create's row. The binding says which create the file was, not the operations' paths.
- **Unbound files.** `forgetRenamesFrom` goes without a replacement. An engine write that unbinds a document from its file either deletes the file (an applied tombstone, a merge whose result is a delete), or the file moved with the document (a merge result elsewhere is a rename, which the binding follows). A local rename against a remote delete is merged, and the rename wins (§6.4 item 8). So no file is left that no binding names.
- **Spelling.** A clean apply of a remote respelling renames the bound file (§4.4 `apply`). Before the engine writes a revision or merge result at `R.path`, a file the vault holds there under another spelling of one file is renamed to `R.path` (`takeServerSpelling`), unless the document's binding names that spelling (a user's case-only rename, PO-9, #304). The engine respells files, never folders (#737): a move that would change only folder spellings `F` takes for one (`PathSpace.sameButFolderSpelling`) is not made, since a folder has one spelling on disk and the vault would report no event for the move's echo record to match. Whether two spellings are one file on disk is `F` (`PathSpace.oneFile`) alone, never asked of the listing. The file holder of a refused operation's path is the document bound to the file the vault holds there (`fileHolder`), never one found by the synced path.
- **Not yet done.** A pending create's row still sets `deleted` (R5a), so the append-only migration that clears it moves to the step that makes create rows live documents.

**Amendment (R8, #572): `apply`, `merge` and `commit` as one transaction per step.** `DeferredRevision.merging`, `resumeMerge`, `finishConflictMoves`, the `path-taken` record reuse of the refused-commit move and the `finished` branch are gone. Details:

- **The cursor.** The pull hands the feed revision's cursor to the step that handles it (`SyncEngine.feedCursor`): the final transaction of an `apply`, a `merge`, an own commit found in the feed or a deferral (`defer`) moves it. A revision the pull skips, or one deferred as unmaterializable (whose release of the file follows the deferral), moves it after the step, as before. An acknowledged commit removes its outbox, moves the base and, when it is the next seq, the cursor in one transaction.
- **`apply`.** A clean apply records the intent (the revision) before its first disk step. Its final transaction writes the base and binding, removes the document's deferral, moves the cursor and removes the intent. Recovery finishes it when the disk shows the revision (its content at its path, or for a tombstone no bound file left) and otherwise drops it: the cursor did not move, or the deferral is still there, so the pull applies the revision again. An apply with no disk step (the disk already shows the revision) has no intent, only the final transaction.
- **`merge`.** The intent records the revision, the local file's hash as the hook was given it, the result's path and **bytes**, and each conflict copy's name, bytes and conflict record, so recovery redoes every step without asking the hook again. A copy's name is chosen before any disk step, with the revision's path as a server claim and the merge's earlier copies reserved. Each disk step is checked against the disk: a copy present with its hash counts as written, the bound file at the result's path with the local hash counts as moved, and a result present with its hash counts as written. A merge whose disk step fails (the vault refuses a path, or the user saved a file meanwhile) is **abandoned**: its intent goes, a copy it wrote stays as an untracked file the next push commits, and its conflict is logged in the same transaction (#345). A later merge of the same document reuses a copy it already wrote of the same content (by the conflict log, never a `path-taken` record). This is a duplicate guard, not crash recovery.
- **The refused-commit move** (`ALREADY_EXISTS`, W(a) from D's side) is a `displace` intent. The push derives the moved document's rename, and a create's replacement is the intent's.
- **Journal v6** (`journalMigrations[5]`, `mergingIntents`) turns a `merging` marker into a `merge` intent with `legacy: true` and no bytes or copies. Recovery finishes it only if the disk shows the recorded result, and otherwise drops it (§6.2).
- **Gate.** P4 already held since R7b. #392 and #345 do not reproduce on master before this step either: earlier steps' bindings and outbox derivation closed them. Their scenarios are kept as regression tests (`engine/merge-intent-crash.test.ts`), and #358 was closed before.

**Amendment (R11, #575): the start-up content match.** `Bindings.scan` (`engine/bindings.ts`) implements E7's content match and E7b (§4.3). Details:

- **Candidates.** A file is a candidate for a missing binding if the vault syncs it (`isSynced`), the engine's classifier (`classify`, the push's) gives it the document's kind, and it holds the binding's `seen`: an untracked file, or (E7b) a file bound to another document that no longer holds that document's own `seen`. The other document's file is the one the vault lists at its binding's spelling, or at that spelling but for folders `F` takes for one: a folder has one spelling on disk, so a folder the user re-created in another case while the app was closed (`X/a.md` listed as `x/a.md`) still holds that document's file (INV-9, #737, #868). A match is one-to-one: one candidate with that content of that kind, and one missing binding with that `seen` of that kind. Two identical files, or two missing documents with one content, match nothing and stay a delete plus a create. So does a file changed after the engine last read it: `seen` is what the engine read, so a rename of a file edited and not yet pushed is not found.
- **Cost.** The scan lists and hashes the vault only when some binding's file is missing, and then reads only a file that could match (#826): one the classifier gives the kind of a still-missing document and, when the size of every such document's `seen` content is known (its row's `size`, where `seen` is its live base's hash), whose `stat` size is one of them. A file of another kind or size is never read. In Obsidian `stat` is the app's cached `TFile.stat`; a stale one would cost a rename match (a delete plus a create instead), never data, and the Obsidian e2e pins that a file renamed while the app was closed keeps its document (#834).
- **Open intents.** A document with an open intent is matched like any other. Intent recovery (§4.4) runs afterwards and writes the binding its outcome names, so a match only matters when recovery drops the intent: then the file the engine moved stays the document's, not a new document's.
- **Events during the scan** (R5a's race). A rename event from a missing file's key to the file the match bound, and a delete event at that file while it is still there (the delete of E7b's other document's file, before the rename), are the changes the scan already saw, and change nothing.
- **Sim.** X-8 is removed (§5.5). Property P1/P2 runs over a `closed` command (renames and deletes while the app is not running, after a push) in `engine/properties.test.ts`.

**Amendment (#758): the scan race decides by events, not content.** `Bindings.renamed` used to keep a missing document's binding on a rename event during the scan only when the moved file held the binding's `seen`. That content check stood in for "the document's own file", and it was wrong for a file edited while the app was closed: the user's rename (E1) was overridden, the document was deleted, and the file was pushed as a new document (PO-1, INV-3). `Bindings` now keeps the key of each binding the scan found missing until an event shows that another file is at that key. That event is a create (E5, `Bindings.appeared`, which the engine's `transition` calls for a create event) or a rename onto the key. A rename event from the key during the scan then moves the binding, whatever the file's content. `seen` stays as it was, so the push commits the edit and the rename under the document's id. This is the outcome the scan would have reached had it read the disk before the event: E7 takes a file at the binding's path as the document's. A new file made at the old path, or moved there, and then moved away is still another document. `scan-race.test.ts` pins both cases, and its §9.3 property generates them.

**Amendment (R12, #576): SPEC restated, and INV-9 after a restore.** SPEC §7/§8 now cite the rules of §4.9 instead of listing cases (under a third of their earlier length). #576's scope note asked to amend INV-9 for a document the restored server lost that stays on the device unpushed until it changes, and to put the database restore back into P6. Since R7b (#700) no such end state exists: the push re-creates such a document under its own id (§4.6), so INV-9 needs no exemption and is unchanged. With restores in its alphabet P6 still fails, on an engine bug rather than an end state INV-9 should allow: an outbox operation the restored server refuses as "the document does not exist" stays forever (#829; INV-8, INV-9, PO-12). P6's main alphabet therefore still omits restores, and an `it.fails` P6 case with restores (`p6Restores` in `engine/properties.test.ts`) reproduces #829 until its fix flips it. Amended for #829: fixed (§4.6, an outbox operation whose base the restored server lacks). The P6 case with restores is a normal passing case now. P6's main alphabet still omits restores, so a restore bug fails its own case.

### 6.3 Protocol and server

**No change is required.** Every rule above uses the existing `CommitRevision`/`ListChanges` semantics, error codes and anchors.

Optional changes, recommended for Phase 3 (decision 9):

- An `ALREADY_EXISTS` detail carrying the holder's document id. Today the client pulls and then infers the holder (`takenByAnother`; SPEC §7's "a document just pulled into the name explains it", which before R12 was spelled out as "the one exception…"). With the detail, `freeCopyName` could exempt nothing and still be exact. Until then, the inference is a single `collisions(…, K)` call.
- In E2EE vaults (Phase 4), the server cannot enforce the folder rule (SPEC §5). C3 is then the only enforcement, and the client must keep it exactly. This is a Phase 4 note, not a Phase 2 change.

### 6.4 Deliberate behaviour changes (SPEC edits in refactor step R12)

Recorded in `SPEC.md` §8 ("Deliberate changes") by R12 (#576), and stated in place in §7/§8 by the rule they follow.

1. A rename or delete whose event was handled before a crash is kept as a rename or delete (bindings are durable). SPEC §8's "A rename is recognized from the vault's rename event. Without one (a change made while the app was closed, or one the app was killed before it recorded) it is a delete plus a create" narrows to "before it was persisted". With decision 4 it narrows further, to "unless the content match is unique".
2. A file moved out of a server-assigned path is **renamed**, never copied and then deleted. This fixes #341 (two conflict copies when an open note's delete is refused), and the bytes are never in two places in an intermediate state.
3. An unmaterializable or otherwise blocked document's kept file is detached in one step (renamed to its copy name, then pushed as a new document). SPEC §8 today leaves it as an untracked file, waits for the push to be refused, and then makes a `path-taken` copy (#390, #452). The final state is the same, with two fewer server round trips.
4. When two documents fold to one `F` but differ in `K` (ı/I on Windows), the second one to arrive is not written over the first through the alias. The first keeps the file, and the second is `unmaterializable(alias)` on this device until the server moves the first away (amended for #736, decision #52; §4.5 step 3).
5. `DocumentState.deleted` no longer doubles as "released". `deletedDocuments()` (engine.ts:478) drops its `unmaterializable` filter.
6. The merge hook no longer chooses the result path (decision 6).
7. (R5a) A user's delete of a document's file lasts until something binds the document again, not until the end of the push round. So a file deleted while the app was closed (seen by the start-up scan) and a new file created at that path before the first push make a delete of the document and a new document, never an edit of the deleted one (E3, E5, E7). The same holds when the new file is moved away while the start-up scan runs: a rename event during the scan keeps a missing document's binding only for the file that was at its key before the scan, not for one that a create event or a rename onto the key put there during the scan (PO-1, INV-3; #671, amended for #758). That file keeps the binding whatever its content, so an edit made while the app was closed is pushed with the rename under the document's own id.
8. (R5b) A local rename not yet pushed wins over a remote delete committed first, as an edit does (PO-7, PO-9; decision #52 revised, reversing #513): the document comes back on its tombstone under its own id at the bound spelling, with any edit. Before, the renamed file was pushed as a new document and the original stayed tombstoned. An unpushed edit merged with a remote delete ends the same way: the merge result is bound on the tombstone and committed as the document's next revision, not as a new document.
9. (R5b) The tombstone re-creation of decision #17 follows PO-13's guard exactly: a file that appears at the path of a document this device's user deleted (its own delete acknowledged, `absence = user-deleted`) is a new document, and only a tombstone pulled from another device, with no local delete since, is brought back. Before, any tombstone at the path was brought back. The re-created document is bound to the file in the same transaction as its outbox (§4.8 row "Tomb").
10. (R7b) A blocked document (a deferred revision it cannot apply yet) keeps its binding while no server claim needs its path (PO-11, PO-4(b), #690). Its local rename and edit stay its own and merge with its revision when that applies, and the local rename wins. If the result keeps a local rename to a path this platform cannot hold, the file is detached where it is (item 3). Before, such a document's file was released and pushed as a new document. A tombstone bound to a file (the user's change that brings it back, which rule W may have moved to a copy name) is treated the same way. Its bound file is its local version in the merge, and its kept file while an unmaterializable revision waits (SPEC §8; seeds 100039, 100083 and 100088).
11. (R7b, #700) After a restore, a document the restored server lacks is re-created by the next push under its own id, at a copy name if its path is taken (§4.6). A document the restore rolled back along this device's own history gets this device's version as its next revision, with no conflict copy (§4.6). Before, a ghost was pushed only once it changed, and a rolled-back document whose base the server lost got a `base-purged` conflict copy.

12. (#737) A folder has one spelling on disk. The engine never respells a folder to match the server's path: with `notes/` on disk, the server's `Notes/x.md` is held as `notes/x.md`, and a case-only rename of the folder alone is not made. A binding keeps a spelling that differs from the vault's only in such folders (the start-up scan, `Bindings.scan`, does not respell it), so the push never takes the folder's disk spelling for a user's rename. A case-only rename of a folder alone made while the app is not running is therefore not synced; one made while it runs arrives as rename events and is. Convergence (INV-9) compares folder segments under `F`. Echo suppression matches events under `F`, so the engine's own write into such a folder is never reported as a local change.

Everything else stays as SPEC §6.3/§7/§8 specify. That includes edit-wins-over-delete, local-rename-wins, the tombstone re-creation of decision #17, conflict-copy naming and folder naming (#359), the refused-again stop rule, and the anchor protocol.

## 7. Issue classification

**Scope.** This section covers 93 issues: every bug issue in the Phase 2 milestone about the engine, simulation or plugin sync; the Phase 3 engine bugs blocked on #552 (#345, #346, #392, #473, #544, #545); #550 and #551 (no milestone); and the ten "cover helper X" follow-ups that document the accretion. Feature issues (#16–#22, #26) and the follow-up batch issues (#409–#411, #434, #442, #464, whose items are listed in the research notes) are left out.

**Concept codes.** Each code maps to the rules of §4.9:

- **identity** is PO-1/2/3;
- **server-wins** is PO-4 and PO-11;
- **folding** is PO-10;
- **crash** is PO-8;
- **copy-name** is PO-14;
- **delete/resurrect** is PO-6/7/13;
- **server-history** is PO-12, which is outside path ownership;
- **oracle** is a checker defect;
- **liveness** is INV-8;
- **other** is outside the model.

**Counts.**

| Concept | Issues (any position) | Issues (primary) |
|---|---|---|
| identity | 26 | 20 |
| folding | 18 | 16 |
| server-wins | 15 | 13 |
| crash | 13 | 7 |
| copy-name | 10 | 8 |
| oracle | 13 | 13 |
| server-history | 6 | 6 |
| delete/resurrect | 3 | 2 |
| liveness | 3 | 3 |
| other / n/a | 2 / 5 | — |

- **67 of 93** issues violate at least one of the five core concepts: identity, folding, server-wins, crash or copy-name. The model removes each of those concepts' special-case code paths (§8).
- 19 issues hit two or more concepts.
- 13 are open.
- Only the 6 server-history issues (restore and anchors) and 2 adapter issues are outside the path-ownership model. Those are already fixed by mechanisms that stay.

The table below is the full list. Where it says "unfixed", the issue was closed into a batch without a fix.

| # | State | Concept(s) | Rule | What happened (model view) |
|---|---|---|---|---|
| #129 | closed | delete/resurrect, identity | PO-1 | A tombstone and a live document share a path; the lookup returned the tombstone. Under the model a binding names the file, so there is no lookup by path. |
| #155 | closed | server-history | PO-12 | A restore that passes the cursor again. Fixed by the anchor (#350), which stays. |
| #156 | closed | server-history, crash | PO-12,PO-8 | Resync crash ordering, echo expiry, seq-0 renumbering. |
| #172 | closed | server-wins, copy-name | PO-4,PO-14 | A remote document at a path held by a document whose merge is pending (`resolveFirst`). Becomes rule W(b). |
| #176 | closed | identity | PO-4 | A local rename onto a remote create split the document into a tombstone plus a copy. W(a) displaces it under its own id. |
| #181 | closed | other | PO-5 | The adapter's delete dropped unsaved keystrokes. Adapter-level; outside the ownership core. |
| #191 | closed | folding | PO-10 | `\` in `path_key`. A server rule (#283); `F` on Windows covers the client side. |
| #242 | closed | folding, identity | PO-10,PO-1 | Exact-string op matching under folding; the engine moved the remote document's file under a local id. |
| #243 | closed | copy-name | PO-14 | The copy name was free locally but taken by path key. |
| #247 | closed | oracle | PO-10 | A false echo positive. The checker now matches by `K`; the model says `F` (§5.5 X-1). |
| #253 | closed | identity | PO-2 | A delete then a rename onto the vacated key. E3 then E1. |
| #254 | closed | identity | PO-2 | A new file at a vacated path was taken as the old document. E3 then E5. |
| #264 | closed | server-wins | PO-4,INV-2 | A pull took a path another live journal document held, so two holders on one key. |
| #267 | closed | identity, server-wins | PO-1,PO-4 | A known document's revision took a file a pending rename had put there. |
| #276 | closed | oracle | PO-7 | New `resurrected-delete` check (feature, not a bug). |
| #280 | closed | identity, crash | PO-2,PO-3 | Renames lost to a crash; the origin of the crash excuse. |
| #286 | closed | identity | PO-2 | A renamed pending create committed at its old path. E1 on the create's binding. |
| #293 | closed | identity | PO-1,PO-2 | A rename after a refused move split the history (consolidated). The binding persists across the refusal. |
| #296 | closed | identity | PO-1,PO-2 | Same as #293. |
| #299 | closed | copy-name | PO-14 | The merged document's stale synced path blocked copy names (`MergedDocument`). |
| #300 | closed | n/a | — | Triage only. |
| #301 | closed | oracle | PO-5 | `lost-write` trusts the merge hook's `mergedInto` record (§5.5 X-11). |
| #302 | closed | oracle | — | A harness hang (stall detection). |
| #303 | closed | identity | PO-2 | A remote create took the rename of a user's untracked file. E2. |
| #304 | closed | folding, identity | PO-10,PO-2 | A case-only rename was undone. E1 with `F`. |
| #305 | closed | folding, identity | PO-10,PO-2 | A remote rename onto another spelling of an unpushed file. |
| #307 | closed | copy-name, server-wins | PO-14,PO-4 | A remote rename onto a local folder's name livelocked. |
| #312 | closed | identity | PO-2 | Pull side of #254 (consolidated, unfixed). |
| #319 | closed | copy-name | PO-14 | The document's own leaving file blocked copy names (`leaving`). |
| #323 | closed | identity, folding | PO-9,PO-1 | A rename then delete took another document's other-case file. |
| #325 | closed | identity | PO-2 | A pull ran before the queued rename event was handled. The fix, draining events before each step, is left to #409 (unfixed; PO-2). |
| #338 | closed | folding, delete/resurrect | PO-10,PO-13 | Tombstone revival matched by exact spelling (unfixed). |
| #341 | closed | other | PO-5 | Move-aside wrote two copies; it should be a rename (unfixed). |
| #343 | closed | folding | PO-10 | A remote case-only rename against a local edit (`respelled`). |
| #344 | closed | copy-name | PO-14 | A deferred revision's own path blocked copy names in `Notes/`. |
| #345 | open | crash | PO-8 | A copy written by a failed merge is not pushed. Under the model the copy is untracked, so the next scan pushes it. |
| #346 | open | oracle, folding | PO-10 | The kept file is reported under the journal's spelling; the checker compares exact strings. |
| #352 | closed | copy-name | PO-14 | A new `NOTES` blocked copy names in `notes/` (`resultFolders`). |
| #357 | closed | folding | PO-10 | `respelled` computed by key on a case-sensitive vault (unfixed). |
| #358 | closed | crash, copy-name | PO-8 | Crash-resume divergence next to a folder-named document (unfixed). |
| #359 | closed | copy-name | PO-14 | The folder conflict name (`named`/`blocks`). |
| #371 | closed | crash | PO-8 | A crash between adding the copy op and removing the refused op. |
| #372 | closed | crash | PO-8 | The refused create stayed when the user deleted the copy after a crash. |
| #374 | closed | folding, identity | PO-10,PO-2 | A rename of a file spelled unlike its journal path (`syncedSpelling`). |
| #375 | closed | identity | PO-9 | A local move lost to a remote rename into a respelled folder. |
| #376 | closed | n/a | — | Triage only. |
| #379 | closed | server-wins | PO-11,PO-4 | A stale deferral holder plus a clean write gave two live documents on one key (`releaseIdleClaim`). |
| #380 | closed | folding | PO-10,INV-10 | An echo of the engine's own rename, missed because of the spelling. |
| #390 | closed | server-wins | PO-11,PO-4 | An unmaterializable kept file held a server document off its path (`releaseKeptFile`). |
| #391 | closed | server-wins | PO-11,PO-4 | The same, with a pending op. |
| #392 | open | crash | PO-8 | A crash after a pull wrote a file but before it was journaled. The `apply` intent names the file. |
| #398 | closed | server-wins | PO-11,PO-4 | A parked document's stale edit took another document's file (`releaseParkedPath`). |
| #399 | closed | folding | PO-10 | A file held apart by the filesystem but equal by key was never pushed (`heldApart`). |
| #403 | closed | server-wins, identity | PO-4 | Phantom-delete after a clean write onto a held path (same root cause as #379). |
| #404 | closed | folding | PO-10 | Follow-up: tighten `sameFilesystemName` coverage. |
| #435 | closed | folding | PO-10 | Follow-up: `heldSpelling` coverage and cost. |
| #444 | closed | folding | PO-10 | Follow-up: `heldApart` coverage, path-key identity audit. |
| #447 | closed | folding | PO-10 | A remote rename to an ß/SS spelling took the edit for a delete (`heldAsOne`). |
| #448 | closed | server-wins | PO-4 | Follow-up: pin `releaseIdleClaim` branches. |
| #451 | closed | identity | PO-9 | A rename onto a just-deleted note's path was never pushed (`renamedOntoVacated`). A deleted binding holds no path. |
| #452 | closed | server-wins | PO-11,PO-4 | A kept file in the way at the folder level (`releaseKeptFilesAround`). |
| #453 | closed | crash | PO-8 | A crash between the rebase and the deferral removal. |
| #459 | closed | server-wins, crash | PO-4,PO-2 | A parked note's unpushed rename was lost to a restart (non-durable `localRenames`). |
| #462 | closed | copy-name, crash | PO-8,PO-14 | A `path-taken` record reused as a copy name lost a write. The conflict log was being used as a WAL. |
| #469 | closed | crash | PO-8 | Follow-up: keep a newer local-changes deferral on re-fetch. |
| #471 | closed | n/a | — | Nightly umbrella; split into #479–#482. |
| #473 | open | server-wins | PO-4 | Move-aside was decided by the synced path, not by where the result lands. W applies only when a server claim needs the path. |
| #478 | closed | server-wins | INV-2 | Follow-up: assert no two live documents on one key. |
| #479 | closed | identity | PO-2 | An unpushed rename record outlived its document (`renameFollowsCopy`). |
| #480 | closed | server-history | PO-12 | A purge seen as a restore (replaced by purge markers, #506). |
| #481 | closed | folding, crash | PO-10,PO-3 | A stale spelling after a respelling lost to a restart. |
| #482 | closed | liveness | INV-8 | A push round committed a stale-base op after an in-round merge. |
| #485 | closed | oracle | PO-3 | Excuse widened to the engine's own copy (#497). |
| #486 | closed | identity | PO-2 | Stale rename records of deleted documents (`forgetRenamesFrom`). |
| #488 | closed | server-history | PO-12 | Restore plus cursor purge (purge markers). |
| #491 | closed | server-wins | PO-4 | Follow-up: `releaseParkedPath` hardening. |
| #494 | closed | server-history | PO-12 | Restore between the cursor and the device's own commit (own-commit anchor). |
| #498 | closed | identity | PO-2 | Same as #486 (regression seed only). |
| #499 | closed | server-history | PO-12 | The #480 mechanism (regression seed only). |
| #503 | open | oracle | PO-3 | Excuse tests and wording. Folded into R10. |
| #507 | closed | liveness | INV-8 | The #482 mechanism (regression seed only). |
| #509 | closed | oracle | PO-4,PO-6 | Deleting the engine's displaced copy is the user's delete (excuse via `movedDocuments`). |
| #513 | closed | identity | PO-2 | Follow-up: rename vs delete identity, `forgetRenamesFrom`. |
| #517 | closed | liveness | INV-8 | Follow-up: a detected delete whose base a pull moved. |
| #518 | closed | oracle | PO-4 | Follow-up: conflict-copy move tracking in the sim. |
| #526 | open | identity, crash | PO-2 | Cause A: a delete mark lost to a restart, then a rename onto the path. A real bug (#530). Durable bindings fix it. |
| #531 | open | oracle | PO-3 | Excuse misses chains and engine writes (#535). |
| #532 | open | oracle | PO-1 (X-5) | The oracle credits a delete through the journal under test. |
| #540 | open | oracle | PO-3 | Tighten the chain clause (#535). |
| #544 | open | folding | PO-10 | The Android shared-storage fold. Needs an `F` function (decision 7). |
| #545 | open | delete/resurrect | PO-13 | An edit after a committed delete survives as a new document. A SPEC decision, kept (§4.8). |
| #550 | open | identity | PO-1 | #530's content-equality exception decides identity by content. |
| #551 | open | oracle | PO-3 | Harden the excuse with file identity. Becomes harness inodes (§5.4). |

## 8. Special cases the model subsumes

### 8.1 Rewrite versus refactor

The 47 entries below (64 identifiers) are the ownership core. Together with `inspect`, `applyRevision`, `mergeRevision`, `applyMerge`, `detectChanges`, `moveToConflictPath` and the event handler, that is about 1,500 lines of `engine.ts`.

These parts stay:

- the transport and backoff;
- `uploadContent`;
- the change-feed loop, anchors and own-commit handling (`pullOnce`, `ownCommitAbove`, `advancePastOwnCommit`);
- `resync`'s outer loop;
- history and restore;
- the merge hook's content merge;
- echo suppression;
- the conflict view's projection;
- the journal's IndexedDB plumbing.

**Why not refactor in place.** The special cases *are* the structure: almost every helper re-derives ownership, and the fixes are clauses inside them. Extracting them one by one keeps the derived, non-durable ownership, and so keeps the crash class.

**Why not rewrite the whole engine.** The 48 engine test files (11,725 lines of scenarios) and 52 committed regression seeds encode hard-won behaviour. Rewriting the parts that are correct would throw that away.

The plan in §9 builds the new core next to the old one, compares the two in shadow mode, then switches reads over in steps. Each step deletes the helpers it replaces.

### 8.2 Table

| Special case today (engine.ts line) | What it does | Introduced by PR | Subsumed by |
|---|---|---|---|
| `Changes.renames` (:208), `localRenames()` (:1294) | in-memory rename records | #196, #287 | bindings, E1 (PO-2) |
| `Changes.vacated` (:210) | in-memory "a rename put a file here and it was deleted" | #287 | E3 then E5: no binding means untracked |
| `Changes.deleted` / `DeletedFile` (:215, :219) | in-memory user deletes, keyed by `fileKey` | #311 | `absence = user-deleted` (E3) |
| `roundRenames` / `roundDeleted` (:302, :304) | copies of the above for the running push round | #287, #311 | bindings are durable, so no round copy is needed |
| `held` (:311) | changed paths a push skipped because a busy document had them | #342 | outbox ≤ 1 per document; the dirty set is recomputed from bindings |
| `restoreChanges` (:2611) | puts in-memory change sets back after a failed push | #287 | nothing to restore |
| `carryDelete` (:2698) | moves a delete mark onto the own commit's revision | #311 | `absence` is per document, not per revision |
| `fileDeleted` (:2626) | whether a delete mark applies to this revision | #311 | `absence` |
| `deletedFile` (:2661) | which document a delete event removed | #311 | E3 binding lookup |
| `ownFileAt` (:2643) | whether a renamed file was a document's own | #320 | E1/E2 binding lookup |
| `syncedSpelling` (:2681) | the journal's spelling of a file the vault spells otherwise | #385 | E1 matches by `F` (PO-10) |
| `localSpelling` (:940) | whether the user gave the file its spelling | #334 | the binding's spelling *is* the user's spelling |
| `matchSpelling` (:931) | renames a file to the journal's spelling before a write | #217, #334 | writes go to `binding.spelling`; respelling only through path merge (PO-9) |
| `heldSpelling` (:955) | the vault's spelling of a path for echo records | #395 | `binding.spelling` |
| `sameFile` (:1322), `heldApart` (:1331), `heldAsOne` (:1345) | three tests of "one file or two" | #385, #440, #465 | `F` (PO-10), one function |
| `documentAt` (:1307) and its `bySpelling` flag | the live document at a path, by folding rules | #246, #440 | `fileHolder` / `serverHolder` (§4.2) |
| `localMoveAt` (:1246) | the document a local move put at a path | #196, #246, #278 | `fileHolder` plus `binding ≠ base.path` |
| `movedAway` (:1282) | whether a document's file left its synced path | #278, #311, (#530) | `binding.spelling ≠ base.path` or `absence` |
| `pendingCreateAt` (:1268) | a pending create's file a rename moved | #339 | a create has a binding (E1) |
| `followRename` (:1803), `localFile` (:1791) | finds a document's own file for a merge | #173, #329, #334 | `binding(D)` |
| `belongsToDocument` (:1652) | whether a file is any document's | #173 | `fileHolder` |
| `moveAside` (:1360) | moves a locally moved document off a needed path | #196, #339 | `displace` intent, W(a) |
| `renameFollowsCopy` (:1582) | re-points rename records at a copy | #484 | bindings move with the file |
| `forgetRenamesFrom` (:1143) | drops rename records of deleted documents | #502 | no rename records |
| `renamedOntoVacated` (:1605) | exemption from the holder guard | #456, #472 | a deleted binding holds no path (PO-9) |
| `releaseFile` (:531) | releases an unmaterializable document's unchanged file | #217 | W(b) `detach`, or nothing while no claim needs the path (PO-11) |
| `releaseKeptFile` (:1092) | releases a kept edited file when the server reuses its path | #389, #397 | W(b) `detach` |
| `releaseParkedPath` (:1124) | releases a parked document's path after a delete or move | #455, #476 | W(b) `detach` |
| `releaseIdleClaim` (:1208) | releases a holder deferred for a non-retried reason | #400 | PO-11 plus W(b) |
| `releaseKeptFilesAround` (:1173) | folder/file version of `releaseKeptFile` | #458 | `collisions(…, F)` includes folders, then W(b) |
| `resolveFirst` (:1068) | resolves the holder's merge first | #196 | W(b) first step |
| `resolving` (:294) | recursion guard for `resolveFirst` | #196 | kept as the W(b) recursion guard (the only survivor) |
| `parked()` / `Parked` (:2027, :225) | documents and paths the push leaves alone | #164 | blocker check on `ahead`; paths are never parked |
| `dropCreatesAt` (:1634) | drops creates superseded by an identical remote file | #246 | adoption of an untracked file (§4.5 step 3) |
| `dropOperationsAt` (:1614) | drops other documents' ops at a path | #173, #246 | the outbox belongs to the binding; displace or detach rewrites it |
| applied/clean holder branches of `applyRevision` (:760–808) | three guards against two holders | #266, #278, #400, #455 | §4.5 step 3 |
| `MergedDocument` (:245), `knownFileKeys` (:1769) | exemptions and the name universe for copies | #246, #324, #348 | `freeCopyName(p, exempt)` (PO-14) |
| `freeConflictPath` `resultFolders`/`named`/`blocks` (:1726) | folder rules for copy names | #355, #362 | `freeCopyName` |
| `takenByAnother` (:2544), `takenFolder` (:2567) | what explains a refusal; which folder to rename | #196, #246, #318 | `collisions(…, K)` |
| `DeferredRevision.merging` (journal.ts), `resumeMerge` (:1056) | merge write-ahead record | #173 | `merge` intent (PO-8) |
| `finishConflictMoves` (:1940) | finishes a move a crash interrupted | #384 | `displace` intent recovery |
| `path-taken` record reuse in `moveAside`/`moveToConflictPath`/`writeConflictCopy` (:1367, :2467, :1672) | the conflict log used as a write-ahead record | #196, #472 | intents; the log is UI only |
| `finished` branch for interrupted rebases (:716) | cleans a deferral left by a crash | #463 | one `transact` per step |
| `contentMissing` rename carry (:2295) | keeps a rename across a dropped op | #339 | the binding holds the rename; the op is re-derived |
| `retryRefusedPaths` release loop (:2594) | calls the release helpers once per start | #389, #458 | W is applied at decision time |
| `DocumentState.deleted` as "released" (journal.ts) | one flag, two meanings | #217 | `absence = released` |
| `detectChanges` rename/delete inference (:2059–2166) | reconstructs renames, displaced documents and replacements | #196, #287, #311, #530 | outbox derivation from (base, binding): one diff per document |

## 9. Refactor plan

### 9.1 Component boundaries (all under `plugin/src/core/engine/`, none importing each other in cycles)

| Component | Owns | Used by |
|---|---|---|
| `pathspace.ts` (`PathSpace`) | `K`, `F` per platform (including Android shared storage), collisions, folder relation, spelling lookup in a listing | everything that compares paths. No other code calls `pathKey` or `sameFilesystemName` on paths. |
| `bindings.ts` (`Bindings`) | E1–E7 transitions (PO-2/3), `binding`/`absence` rows, the start-up scan | event handler, push planner, `decideRemote` |
| `claims.ts` (`PathClaims`) | the derived claim table (§4.2), `fileHolder`, `serverHolder`, `collisions`, `freeCopyName` (PO-14). It reads `Bindings`, the journal and the listing, and is rebuilt per step from an in-memory index kept in step with each `transact`. | `decideRemote`, push planner, restore-at-path check (`restorePathProblem`) |
| `intents.ts` (`Intents`) | the intent kinds, `transact` batches, recovery (PO-8) | `decideRemote`, push, the event handler (E6) |
| `decide.ts` (`decideRemote`) | §4.5 including rule W (PO-4, PO-11) and the path merge (PO-9). It calls the merge hook for content only. | `pullOnce`, `resync`, `retryMerges` |
| `push-plan.ts` | outbox derivation from (base, binding), dependency order, `ALREADY_EXISTS` handling (W(a) from D's side) | `pushOnce` |
| `engine.ts` (`SyncEngine`) | orchestration only: serialization, backoff, feed loop, upload, commit, history/restore, public API | the plugin and the sim |

### 9.2 Steps

Every step is one PR, touches about 10 non-test files or fewer, and keeps `make test test-sim` green. A step that changes behaviour adds its scenarios as unit tests, plus a seed when one exists. **Rule for existing tests:** assertions about vault contents, server state and the conflict log never change. An assertion about internal journal shape (pending-operation lists, `DocumentState.deleted` for released documents) may be rewritten into the equivalent binding or outbox assertion, and each such rewrite is listed in the PR body for the reviewer.

| Step | Content | Main files | Deletes (from §8.2) | Gate |
|---|---|---|---|---|
| **R0** | Add `fast-check` (decision 5). Model-based property harness over `memory-server.ts` + `InMemoryVault` + `InMemoryJournal`, with a journal wrapper that crashes at the Nth write (§9.3). Properties P1–P6, each failing one marked `it.fails` with its issue number. | `plugin/package.json`, `engine/properties.test.ts` (new), `engine/testing.ts` | — | the new suite runs in `make test`; flipping an `it.fails` to `it` is the visible progress measure |
| **R1** | `PathSpace`: `K`, `F` (from `filesystemFold`, now exported as a key), collisions. Route `fileKey`, `sameFile`, `heldApart`'s fold test and `ancestors` through it. Behaviour-preserving except the ı/I alias (§6.4 item 4), which gets a unit test. | `vaultpath/platform.ts`, `engine/pathspace.ts`, `engine.ts`, `vault/memory.ts` (key fn only) | `sameFile` | unit tests |
| **R2** | Faithful filesystem in `InMemoryVault` (`F`, not `K`, decides the file; #396) and a harness inode API (§5.4). Sim path pool gains `Straße.md`/`STRASSE.md`, NFC/NFD `Café.md`, `ı.md`/`I.md`. Behind `SIM_FAITHFUL_FS=1`, run as a separate non-gating nightly job until R7. | `vault/memory.ts`, `sim/client.ts`, `sim/engine-observer.ts`, `sim/runner.ts`, `.github/workflows/sim-nightly.yml`, `docs/testing/simulation.md` | — (X-18 moves to opt-in) | `make test-sim` unchanged; new nightly job reports |
| **R3** | Journal v3: `binding`/`absence`/`sealed` fields, `intents` store, `transact`, `documentByFileKey`, the v2 migration (§6.2), conformance tests. Nothing reads them yet. | `journal/journal.ts`, `journal/indexeddb.ts`, `journal/memory.ts`, `journal/conformance.ts`, `sim/engine-observer.ts` (halting journal) | — | journal conformance in unit tests and in e2e |
| **R4** | `Bindings` in shadow mode: the event handler and the engine's own changes maintain bindings. A differential check in tests and the sim (`binding-shadow`, report only) compares them with the old derived ownership (`followRename`, `localMoveAt`, `movedAway`). | `engine/bindings.ts`, `engine.ts`, `sim/engine-observer.ts` | — | shadow divergences listed in the nightly report and triaged; each one is either an old-code bug (cite a PO) or a model bug (amend this doc) |
| **R5** | Push from bindings: outbox derivation replaces `detectChanges`' inference, with an outbox of at most one per document. | `engine/push-plan.ts`, `engine/bindings.ts`, `engine.ts`, `SPEC.md` §8 Push | `Changes.renames`/`vacated`/`deleted`, `roundRenames`, `roundDeleted`, `held`, `restoreChanges`, `carryDelete`, `fileDeleted`, `deletedFile`, `ownFileAt`, `syncedSpelling`, `contentMissing` carry, `detectChanges` inference | P1, P2 flip to passing; seeds of #280, #286, #303, #526 green without the excuse firing (logged) |
| **R6** | `PathClaims` + `freeCopyName`. Amended in R6: `collisions` and `freeCopyName` land here. `fileHolder` and `serverHolder` land with R7, their first callers, because disk claims name a document only through `Bindings` (R4). Until then, the old `documentAt`/`localMoveAt` pair answers the file-holder question. | `engine/claims.ts`, `engine.ts`, `SPEC.md` §7 naming | `freeConflictPath` internals, `knownFileKeys`, `MergedDocument`, `takenByAnother`, `takenFolder`, `belongsToDocument` | copy-name scenario tests unchanged |
| **R7** | **Done** (R7a #699, R7b #700, R7c #571, R7d #701 in PR #739). `decideRemote` with rule W, plus the `displace`/`detach` intents. Make `SIM_FAITHFUL_FS` the default. #797 then moved the scripted scenarios and the engine unit tests to the faithful vault and deleted the folded one (X-18). | `engine/decide.ts`, `engine/intents.ts`, `engine.ts`, `engine/claims.ts`, `SPEC.md` §8 platform rules, `sim/runner.ts` | `localMoveAt`, `movedAway`, `pendingCreateAt`, `followRename`, `localFile`, `documentAt`, `heldApart`, `heldAsOne`, `localSpelling`, `matchSpelling`, `moveAside`, `release*` (5), `resolveFirst` (except its guard), `parked()`, `dropCreatesAt`, `dropOperationsAt`, `renamedOntoVacated`, `renameFollowsCopy`, `forgetRenamesFrom`, applied/clean holder branches, `retryRefusedPaths` release loop, `DocumentState.deleted` as released | P3 flips; #473, #544 (with decision 7) fixed |
| **R8** | `apply`/`merge`/`commit` intents with one `transact` per step, the cursor in the same transaction. | `engine/intents.ts`, `engine.ts`, `engine/decide.ts`, `journal/*` (only if needed) | `DeferredRevision.merging`, `resumeMerge`, `finishConflictMoves`, `path-taken` WAL reuse, the `finished` branch | P4 (crash-at-every-write) flips; #392, #345, #358 fixed |
| **R9** | Merge hook becomes content-only; the path merge moves into `decide.ts` (decision 6). | `engine/merge.ts`, `engine/decide.ts`, `sim/engine-observer.ts` | path logic in `threeWayMerge` | merge tests: the path assertions move to decide tests |
| **R10** | Sim oracle on inodes: phantom-delete, resurrected-delete and the new `identity` check. Verdicts of §5.5 applied (X-1, X-2, X-4, X-5, X-7, X-10, X-11, X-14). `journal-holder` checked after every step. Closes #503, #531, #532, #540, #551, #346, #301. | `sim/invariants.ts`, `sim/engine-user.ts`, `sim/engine-observer.ts`, `sim/runner.ts`, `docs/testing/simulation.md`, `SPEC.md` §13 | `documentsAt` journal reads, `movedByEngine`, `writtenByEngine` (if #535 merged), `renameLostToCrash` content-matching | mutation tests for every check (§10.2 E4) |
| **R11** | Start-up content-match rename detection (E7, decision 4), plus the E7b extension that removes X-8. | `engine/bindings.ts`, `SPEC.md` §8, `sim/invariants.ts` | X-8 | the seeds of #280, #531 and 100117 pass with X-8 removed |
| **R12** | **Done** (#576). SPEC §7/§8 restated as the PO rules (target: under a third of today's length), with the `(#NNN)` exception lists replaced by rule ids and the deliberate changes of §6.4 recorded. `docs/plugin.md` touched where user-visible. | `SPEC.md`, `docs/plugin.md`, `docs/design/engine-path-ownership.md` (mark implemented) | — | docs review |

Order constraints:

- R2 must come before R4, so the shadow check covers `F`.
- R3 must come before R4.
- R5 and R7 may swap, but R6 must come before R7.
- R8 depends on R7, since intents need the `displace`/`detach` kinds.
- R10 depends on R5 and R7. Narrowing the excuse before then would turn the known crash window into red seeds.

Expected size: `engine.ts` back to about 1,000 lines, with the new components at about 1,200 lines together.

### 9.3 Property-based tests to add (fast-check `fc.commands`, in-memory, in `make test`)

The reference model is a tiny pure state machine over files with inodes, server documents and user intents. The real engine runs against `memory-server.ts`, which already enforces `K` uniqueness and the folder rule. Each property runs 2,000 cases per PR and 100,000 a night. Command alphabet:

- user create, edit, rename (any, case-only, respelled under `K` not `F`, onto a folder name), delete;
- a remote device's create, edit, rename and delete through a scripted client;
- pull, push;
- crash at journal write N;
- restore to seq S;
- retention purge;
- platform ∈ {posix, windows, macos}.

| Property | Checks |
|---|---|
| P1 identity | INV-3 and PO-1: a document's committed content always comes from the inode bound to it |
| P2 provenance | INV-5 and INV-6 (PO-6/7) on inodes |
| P3 exclusivity | INV-1 and INV-2 after every command |
| P4 crash equivalence | INV-7: for every prefix, crashing at every journal write and restarting reaches the same quiescent server and vault state as no crash (modulo copy names and times) |
| P5 no lost write | INV-4 plus principle 1, against server history |
| P6 convergence and progress | INV-8 and INV-9 after quiescence, with bounded push rounds. Its alphabet omits database restores. A separate P6 case (`p6Restores`) adds them and passes since #829 (§4.6, R12 amendment), and another pins an outbox operation recorded before a restore lost its base. A second P6 case (#737) runs on the faithful filesystem over paths whose folders differ only in case, and also checks INV-10 with P7's oracle. A third (#843) adds a file named like such a folder (`NOTES` beside `Notes/c.md`) and a push whose commits never reach the server. An untracked file in the folder keeps the file's revision waiting (`path-conflict`), and the revision must apply once the file is gone, along with any revision that waited for the holder it moves off the path (PO-4(b), INV-9). |
| P7 echo independence | INV-10 with PO-10 on the faithful filesystem: the engine never reports its own write, rename or delete as a local change, over spellings whose `K` and `F` disagree (`Straße.md`/`STRASSE.md`, NFC/NFD `Café.md`; added for #738) |
| P8 content references | INV-8 with PO-8: no outbox operation, and no blob request the engine sends (`BeginBlob`, `CommitRevision`, `DownloadBlob`), names a content hash at a size other than that content's, which the server would refuse on every push. Its alphabet adds a push whose commits never reach the server, so an outbox outlives it into later renames, edits and pulls (added for #775: a `displace` intent rewrote an unpushed create's outbox with the moved content's hash and the create's old size, which #770 fixed by recording the moved content's size with its hash). |
| P9 path merge | PO-9 for a document bound on its tombstone (#802): against another device's re-create, the user's move of its file (or a later user move of a copy rule W's `displace` made) wins, and the push commits the document at the user's name. A file that only the engine moved aside takes the server's path. Edits survive and the vault converges. |
| P10 shared ghosts | INV-4 with principle 1 and PO-12 (#816): this device commits on top of another device's live revision only once it had that revision, in a file here or through the merge hook. Its alphabet adds the remote device's re-create of a document the restored server lost (a ghost both devices hold) and a push whose commits never reach the server, so this device's own re-create of that ghost is still in the outbox when the pull finds the other device's. |

Shrinking gives minimal command sequences. Each `it.fails` carries the issue it reproduces, so the suite doubles as the regression list for the classes in §7.

## 10. Process going forward

### 10.1 Bug-fix rule for engine and simulation bugs

1. **State the violated invariant** (INV-n) and the rule (PO-n) in the issue before any code. If no rule forbids the behaviour, the model is incomplete: amend this document first, with owner review, and only then change code.
2. **Fix the class in the component that owns the rule**, never with a new clause at a call site. A new persistent or in-memory state, flag or helper outside §9.1's components needs a design amendment.
3. **Add a property-based test** that generates the class (the property, or a new command or generator), and show that it fails before the fix. Commit the minimized seed as well, as CLAUDE.md already requires.
4. **Checker exceptions** (a new excuse, or a widening) must cite the PO rule under which the flagged outcome is correct, and be added to §5.5 with a verdict. A PR that cannot cite a rule is an engine bug, not a checker bug.
5. Reviewers check items 1–4. The PR template gets the four lines.

### 10.2 Phase 2 exit bar (all must hold)

- **E1.** 3 consecutive nightly runs green (owner decision 2026-10-21; was 7):
  - 100 seeds × 3,000 steps each, plain and retention schedules, with server restore steps enabled;
  - `SIM_CLIENTS=3` and enough engines that `posix`, `windows` and `macos` all run (`SIM_ENGINES=3`);
  - the faithful-filesystem vault (R2) on;
  - no checker exception beyond X-2's exact window (with X-3/X-6/X-7 inside it).

  At today's 45 minutes per 50 seeds that is about 1.5 h a night. Three nights are 300 seeds, or 0.9 M steps, with no failure: a 95 % upper bound on the per-seed failure rate of about 1 % (the rule of three), against today's 20 % (#471: 10 of 50) and 5 % (#526: 7 of 134). The nightly keeps running after Phase 2 closes, so later failures still surface.
- **E2.** The property suite (§9.3) is green at 100,000 cases a night for the same 3 nights, and no `it.fails` is left.
- **E3.** No open bug of severity medium or above with `area:plugin` or `area:sim` in the Phase 2 milestone. Every issue blocked on #552 is closed or re-triaged with a cited rule.
- **E4.** Every simulation invariant has a mutation test that fails it: an engine mutant per invariant, including `identity` and `journal-holder`.
- **E5.** None of the 64 identifiers in §8.2 remains in `plugin/src/core` (checked by grep in CI), except `resolving` as the W(b) guard.
- **E6.** The plugin e2e is green on Linux, Windows, macOS and emulated mobile, including the journal conformance with `transact` and the v2 → v3 migration of a fixture journal.

## 11. Risks and non-goals

### 11.1 Risks

| Risk | Mitigation |
|---|---|
| The switch-over steps (R5, R7) regress scenarios that tests do not cover | shadow mode (R4) with differential reporting before any read switches; the 48 engine test files stay as acceptance tests; property suite P1–P6 |
| The faithful filesystem (R2) surfaces many new failures in dead branches | expected and budgeted: a non-gating job until R7 |
| Event semantics: the model relies on the adapter reporting renames as renames, in order (folder renames per file; SPEC §4) | the adapter conformance suite already checks it in real Obsidian. A lost event degrades to PO-3, which is today's behaviour, not worse. |
| Content-match rename detection (decision 4) misattributes two identical files | one-to-one unique matches of the same kind only; ambiguous cases fall back to delete plus create (today's behaviour) |
| IndexedDB multi-store transactions on Android WebView | journal conformance in e2e, emulated mobile included; the Android checklist (`docs/testing/android.md`) gets one crash-and-restart check |
| Claim-table cost on large vaults (#250, #412) | indexed lookups (`documentByFileKey`, `baseKey`); one in-memory index rebuilt at start and updated with each `transact`; no `listDocuments()` scan per decision |
| Migrating crash-left v2 journals (several ops per document, `merging` markers) | legacy-op drain (§6.2); fixture journals captured from sim crashes, migrated in a unit test |
| Agents keep landing point fixes during the refactor | keep the #552 block (decision 2); the PM dispatches only R-steps; §10.1 in the reviewer playbook |
| The steps are large for one agent | each is ≤ 10 non-test files, and R5/R7 can split further (push or pull side) if a reviewer asks |

### 11.2 Non-goals

- No protocol or server changes (optional items in §6.3 are deferred).
- No change to content merge rules, conflict-copy name format, the conflict view, or the edit-wins/rename-wins semantics.
- No E2EE (Phase 4), Yjs (Phase 5) or sharing (Phase 3) work. The model only notes where Phase 4 relies on the client-side C3.
- No performance work beyond not regressing, such as the start-up hash cache of #349 item 1.
- No sim speed-up and no shrinker work (#381), except what R2 and R10 need.
- No change to config-sync scope rules: they stay the `out-of-scope` blocker.
- The merge hook stays an extension point; only its path responsibility moves (decision 6).
- Not a rewrite of the engine outside the ownership core (§8.1).
