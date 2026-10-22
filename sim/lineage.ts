// The simulation's oracle of file identity (docs/design/engine-path-ownership.md
// §5.4): harness inodes, never the engine's journal. Each engine's vaults tag
// every change with an inode and the actor that made it (InMemoryVault's
// inode tap): a create mints an inode, a write or a rename (by anyone) keeps
// it, a delete ends it. After the run, the harness replays that record merged
// with the server's change feed by seq (a change recorded at server head seq
// S happened after every revision up to S and before every later one) and
// binds inodes to documents:
//
// - when the engine commits a revision of D whose path and content match an
//   inode at that moment (or, if the file changed since the engine read it,
//   the inode the user last wrote that content into), the inode is D's;
// - when the engine writes a revision's content at that revision's path (it
//   applies a pulled revision), the inode is that revision's document's.
//
// On that binding it checks:
//
// - `phantom-delete` (INV-5, PO-6): an engine's tombstone of D follows its
//   user's delete of an inode bound to D. The one exception is the crash
//   window of a lost rename (§5.5 X-2): the user renamed D's inode, the app
//   was killed before the engine reached a settled point after the rename
//   (the rename's event may never have been handled), and after the crash the
//   engine committed that inode as a new document's first revision (or the
//   user deleted the inode, X-7). A conflict copy the engine moved the inode
//   to is the same inode (X-3), and so is content the engine wrote into it
//   (X-6).
// - `resurrected-delete` (INV-6, PO-7): an engine's live revision of D on
//   its tombstone comes from a change of the user's to the file it was
//   committed from (D's own file, or an untracked file at the path, PO-13)
//   that no earlier revision of D from that engine carried (an edit that
//   wins over the delete, or a re-creation), or from the user's restore of D
//   (§5.5 X-10, on inodes).
// - `identity` (INV-3, PO-1): an engine commit of D never comes from an
//   inode bound to another document, except a crash-lost rename's create
//   (X-2), a detached file (PO-4(b), X-20) and a conflict copy the engine
//   made by moving the file to its copy name (X-21), each committed as a new
//   document.
//
// The checks are pure functions over recorded data, unit tested in
// lineage.test.ts.

import type { Violation } from "./client";
import type { FeedRevision } from "./invariants";

/** One entry of an engine's timeline: a vault change, a crash or a settled point, at the server's head seq then. */
export type LineageEntry =
  | {
      kind: "change";
      type: "create" | "modify" | "rename" | "delete";
      /** The path as the feed spells it (a config file's carries the config prefix). */
      path: string;
      oldPath?: string;
      /** Unique across the device's vaults. */
      inode: string;
      actor: "user" | "engine";
      /** Content hash after a create or modify. */
      hash?: string;
      serverSeq: bigint;
      step: number;
    }
  | { kind: "crash"; serverSeq: bigint; step: number }
  /** The user restored a version of `documentId` from its history (SPEC.md §11), just before the engine commits it. */
  | { kind: "restore"; documentId: string; serverSeq: bigint; step: number }
  /** The engine finished a pull or push, or its settled(): every change before timeline entry `since` was handled. */
  | { kind: "settled"; since: number; serverSeq: bigint; step: number };

/** One engine's device, with its timeline and how its vault matches paths. */
export interface EngineLineage {
  name: string;
  deviceId: string;
  timeline: readonly LineageEntry[];
  /** The vault's path matching (pathMatcher). */
  match: (path: string) => string;
  /** Whether `copy` is this engine's conflict copy of `original` (copiedFrom). */
  copyOf: (copy: string) => string[];
}

interface FileState {
  path: string;
  hash: string | undefined;
}

interface RenameRecord {
  inode: string;
  /** The documents the inode was bound to when the user renamed it. */
  documents: ReadonlySet<string>;
  /** Replay position of the rename. */
  at: number;
}

/** The last element of `items` that `matches`. */
function lastOf<T>(items: readonly T[], matches: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item !== undefined && matches(item)) return item;
  }
  return undefined;
}

const bySeq = (a: FeedRevision, b: FeedRevision): number => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);

/** Replays one engine's timeline against the feed; collects phantom-delete, resurrected-delete and identity violations. */
class Replay {
  private readonly files = new Map<string, FileState>();
  /** Deleted inodes, with where they were and what they held then. */
  private readonly gone = new Map<string, FileState>();
  private readonly byKey = new Map<string, string>();
  readonly bound = new Map<string, string>();
  private readonly everBound = new Map<string, Set<string>>();
  /** The inode each content was last written into, by anyone. */
  private readonly origins = new Map<string, string>();
  private readonly userDeleted: { inode: string; at: number }[] = [];
  /** The user's creates, writes and renames of inodes, with the content after them and a rename's new path. */
  private readonly userChanges: { inode: string; at: number; hash: string | undefined; path: string; rename: boolean }[] = [];
  /** The user's restores, by document, at their timeline position. */
  private readonly restores: { documentId: string; at: number }[] = [];
  /** Where in the timeline each revision was applied. */
  private readonly appliedAt = new Map<FeedRevision, number>();
  private readonly renames: RenameRecord[] = [];
  private readonly crashes: number[] = [];
  private readonly settled: { handled: number; at: number }[] = [];
  private readonly applied: FeedRevision[] = [];
  /** First seq of each document. */
  private readonly firstSeq = new Map<string, bigint>();
  /** Inodes the engine detached (X-20) or moved to a conflict copy (X-21), with the document they were the file of. */
  private readonly unboundFrom = new Map<string, string>();
  /** Lost-rename inodes (X-2) whose create came after a crash in the window, by document they were bound to. */
  private readonly lostRenames = new Map<string, Set<string>>();
  readonly violations: Violation[] = [];
  private readonly pendingTombstones: (() => void)[] = [];
  /** The replay's clock: one tick per timeline entry and per revision, so every event has its own position. */
  private position = 0;
  /** The position of each timeline entry, by index. */
  private readonly entryPositions: number[] = [];

  constructor(
    private readonly engine: EngineLineage,
    private readonly label: (id: string) => string,
    feed: readonly FeedRevision[],
  ) {
    for (const revision of feed) {
      const first = this.firstSeq.get(revision.documentId);
      if (first === undefined || revision.seq < first) this.firstSeq.set(revision.documentId, revision.seq);
    }
  }

  run(feed: readonly FeedRevision[]): void {
    const revisions = [...feed].sort(bySeq);
    let next = 0;
    for (const entry of this.engine.timeline) {
      while (next < revisions.length && (revisions[next]?.seq ?? 0n) <= entry.serverSeq) this.revision(revisions[next++] as FeedRevision);
      this.position++;
      this.entryPositions.push(this.position);
      this.entry(entry);
    }
    while (next < revisions.length) this.revision(revisions[next++] as FeedRevision);
    for (const judge of this.pendingTombstones) judge();
  }

  private key(path: string): string {
    return this.engine.match(path);
  }

  private bind(inode: string, documentId: string): void {
    this.bound.set(inode, documentId);
    const ever = this.everBound.get(inode) ?? new Set<string>();
    ever.add(documentId);
    this.everBound.set(inode, ever);
  }

  private entry(entry: LineageEntry): void {
    if (entry.kind === "crash") {
      this.crashes.push(this.position);
      return;
    }
    if (entry.kind === "restore") {
      this.restores.push({ documentId: entry.documentId, at: this.position });
      return;
    }
    if (entry.kind === "settled") {
      // The entries handled are those before index `since`.
      this.settled.push({ handled: entry.since === 0 ? 0 : (this.entryPositions[entry.since - 1] ?? 0), at: this.position });
      return;
    }
    switch (entry.type) {
      case "create":
      case "modify": {
        const previous = this.files.get(entry.inode);
        if (previous !== undefined && previous.path !== entry.path) this.byKey.delete(this.key(previous.path));
        this.files.set(entry.inode, { path: entry.path, hash: entry.hash });
        this.byKey.set(this.key(entry.path), entry.inode);
        if (entry.hash === undefined) return;
        this.origins.set(entry.hash, entry.inode);
        if (entry.actor === "user") {
          this.userChanges.push({ inode: entry.inode, at: this.position, hash: entry.hash, path: entry.path, rename: false });
          return;
        }
        // The engine materialized a revision at its document's path: the file is that document's.
        const key = this.key(entry.path);
        const revision = lastOf(this.applied, (candidate) => !candidate.deleted && candidate.contentHash === entry.hash && this.key(candidate.path) === key);
        if (revision !== undefined) this.bind(entry.inode, revision.documentId);
        return;
      }
      case "rename": {
        const file = this.files.get(entry.inode);
        if (entry.oldPath !== undefined && this.byKey.get(this.key(entry.oldPath)) === entry.inode) this.byKey.delete(this.key(entry.oldPath));
        this.files.set(entry.inode, { path: entry.path, hash: file?.hash });
        this.byKey.set(this.key(entry.path), entry.inode);
        if (entry.actor === "user") {
          const documents = new Set(this.everBound.get(entry.inode) ?? []);
          this.renames.push({ inode: entry.inode, documents, at: this.position });
          this.userChanges.push({ inode: entry.inode, at: this.position, hash: file?.hash, path: entry.path, rename: true });
        } else if (entry.oldPath !== undefined && (this.detached(entry.inode, entry.oldPath, entry.path) || this.copied(entry.oldPath, entry.path))) {
          const documentId = this.bound.get(entry.inode);
          if (documentId !== undefined) this.unboundFrom.set(entry.inode, documentId);
          this.bound.delete(entry.inode);
        }
        return;
      }
      case "delete": {
        const file = this.files.get(entry.inode);
        if (file !== undefined && this.byKey.get(this.key(file.path)) === entry.inode) this.byKey.delete(this.key(file.path));
        this.files.delete(entry.inode);
        if (file !== undefined) this.gone.set(entry.inode, file);
        if (entry.actor === "user") this.userDeleted.push({ inode: entry.inode, at: this.position });
        return;
      }
    }
  }

  /**
   * Whether the engine's move of `inode` to `to` is a detach (PO-4(b), X-20):
   * the inode is bound to D, D's newest revision so far is live at another
   * path than `from` and `to`, and `to` is a conflict copy name.
   */
  private detached(inode: string, from: string, to: string): boolean {
    const documentId = this.bound.get(inode);
    if (documentId === undefined || this.engine.copyOf(to).length === 0) return false;
    const head = lastOf(this.applied, (revision) => revision.documentId === documentId);
    if (head === undefined || head.deleted) return false;
    return this.key(head.path) !== this.key(from) && this.key(head.path) !== this.key(to);
  }

  /**
   * Whether the engine's move from `from` to `to` is its copy step (§5.5
   * X-21): `to` is its conflict copy of `from` itself. The local version is
   * kept at the copy, an untracked file the next push makes a new document
   * (§4.8, SPEC.md §7), and the document's revision goes to `from`; moving
   * the file there instead of writing a copy leaves the user the same files.
   */
  private copied(from: string, to: string): boolean {
    return this.engine.copyOf(to).some((original) => this.key(original) === this.key(from));
  }

  /** The inode an engine commit of `revision` was read from, if the oracle can tell. */
  private source(revision: FeedRevision): string | undefined {
    // The file at the commit's path if it holds the content; else the file the content was last written into, if it still exists (the file at the path changed since the engine read it) or the user deleted it at the commit's path since (the engine read it before the delete); else the file at the path.
    const key = this.key(revision.path);
    const holder = this.byKey.get(key);
    if (holder !== undefined && this.files.get(holder)?.hash === revision.contentHash) return holder;
    const origin = this.origins.get(revision.contentHash);
    if (origin !== undefined && this.files.has(origin)) return origin;
    const gone = origin === undefined ? undefined : this.gone.get(origin);
    if (gone !== undefined && gone.hash === revision.contentHash && this.key(gone.path) === key) return origin;
    return holder;
  }

  private revision(revision: FeedRevision): void {
    const own = revision.deviceId === this.engine.deviceId;
    const parent = lastOf(this.applied, (candidate) => candidate.documentId === revision.documentId);
    this.position++;
    this.applied.push(revision);
    this.appliedAt.set(revision, this.position);
    if (!own) return;
    const name = `${this.label(revision.documentId)} at ${revision.path} (seq ${String(revision.seq)}, ${this.label(revision.revisionId)})`;
    if (revision.deleted) {
      if (parent === undefined || parent.deleted) return;
      if (this.deletedByUser(revision.documentId)) return;
      // The create of a crash-lost rename may come after the tombstone: judged once the replay is done.
      const position = this.position;
      this.pendingTombstones.push(() => {
        if (!this.lostToCrash(revision.documentId, position)) this.violations.push({ invariant: "phantom-delete", detail: `${this.engine.name} deleted ${name} although its user never deleted a file bound to it` });
      });
      return;
    }
    const inode = this.source(revision);
    if (parent?.deleted === true && !this.resurrectionExplained(revision, parent, inode)) {
      this.violations.push({ invariant: "resurrected-delete", detail: `${this.engine.name} brought back ${name} after its delete at ${parent.path} (seq ${String(parent.seq)}) although its user changed no file of it since` });
    }
    if (inode === undefined) return;
    const owner = this.bound.get(inode);
    const create = this.firstSeq.get(revision.documentId) === revision.seq;
    // The document the inode was the file of, also if the engine moved it to a copy since (X-3: a lost rename's create there is still the renamed file).
    const previous = owner ?? this.unboundFrom.get(inode);
    const lostRename = create && previous !== undefined && previous !== revision.documentId && this.inCrashWindow(inode, previous);
    if (lostRename) {
      const lost = this.lostRenames.get(previous) ?? new Set<string>();
      lost.add(revision.documentId);
      this.lostRenames.set(previous, lost);
    }
    // A detached or copied file (X-20, X-21) is free only to become a new document: an existing one's commit from it still carries the old document's file.
    const excused = lostRename || (owner === undefined && create);
    if (previous !== undefined && previous !== revision.documentId && !excused) {
      this.violations.push({ invariant: "identity", detail: `${this.engine.name} committed ${name} from inode ${inode}, which is ${this.label(previous)}'s file` });
    }
    this.unboundFrom.delete(inode);
    this.bind(inode, revision.documentId);
  }

  /**
   * Whether a change of the user's explains `revision`, a live revision of
   * D on its tombstone `tombstone` (INV-6, PO-7, §5.5 X-10, on inodes): the
   * user restored D since the tombstone, or created, wrote or renamed
   * `inode`, the file the revision was committed from, when that inode is
   * D's file or the file at the revision's path (an untracked file adopted
   * at the tombstone's path, PO-13), and no earlier revision of D from this
   * engine carried the change: a tombstone after it (the user deleted the
   * file since), or a revision holding what the file held after it or a
   * later change, where it was. A change the engine had already pushed,
   * followed by another device's delete, does not explain the document
   * coming back: that is the engine failing to apply the delete.
   */
  private resurrectionExplained(revision: FeedRevision, tombstone: FeedRevision, inode: string | undefined): boolean {
    const tombstoneAt = this.appliedAt.get(tombstone) ?? 0;
    if (this.restores.some((restore) => restore.documentId === revision.documentId && restore.at > tombstoneAt)) return true;
    if (inode === undefined) return false;
    const own = this.everBound.get(inode)?.has(revision.documentId) === true;
    if (!own && this.byKey.get(this.key(revision.path)) !== inode) return false;
    const earlier = this.applied.filter((candidate) => candidate.documentId === revision.documentId && candidate !== revision && candidate.deviceId === this.engine.deviceId);
    const changes = this.userChanges.filter((change) => change.inode === inode);
    return changes.some((change, index) => {
      const results = new Set(changes.slice(index).flatMap((later) => (later.hash === undefined ? [] : [`${later.hash}:${this.key(later.path)}`])));
      return !earlier.some((candidate) => (this.appliedAt.get(candidate) ?? 0) > change.at && (candidate.deleted || results.has(`${candidate.contentHash}:${this.key(candidate.path)}`)));
    });
  }

  /** The user deleted an inode bound to `documentId` (at any time before now). */
  private deletedByUser(documentId: string): boolean {
    return this.userDeleted.some((deleted) => this.everBound.get(deleted.inode)?.has(documentId) === true);
  }

  /**
   * Whether the user's last rename of `inode`, bound to `documentId` then,
   * falls in a crash window (X-2): the app was killed after it, before the
   * engine's next settled point, and before now.
   */
  private inCrashWindow(inode: string, documentId: string): boolean {
    return this.renames.some((rename) => {
      if (rename.inode !== inode || !rename.documents.has(documentId)) return false;
      const crash = this.crashAfter(rename.at);
      return crash !== undefined && crash <= this.position;
    });
  }

  /** The first crash after timeline position `at` with no settled point in between. */
  private crashAfter(at: number): number | undefined {
    const crash = this.crashes.find((position) => position > at);
    if (crash === undefined) return undefined;
    return this.settled.some((point) => point.handled >= at && point.at < crash) ? undefined : crash;
  }

  /**
   * Whether a tombstone of `documentId` (at timeline position `at`) is the
   * delete half of a rename lost to a crash (X-2): the engine committed the
   * renamed inode as a new document inside the window (identity's excuse),
   * and the crash came before the tombstone. The user's delete of the
   * renamed inode after the crash (X-7) needs no excuse: it was the
   * document's file.
   */
  private lostToCrash(documentId: string, at: number): boolean {
    if ((this.lostRenames.get(documentId)?.size ?? 0) === 0) return false;
    return this.renames.some((rename) => {
      if (!rename.documents.has(documentId)) return false;
      const crash = this.crashAfter(rename.at);
      return crash !== undefined && crash <= at;
    });
  }
}

/**
 * `phantom-delete`, `resurrected-delete` and `identity` over harness inodes for every engine. A
 * scripted client's revisions are never judged: it acts only on schedule
 * (§5.5 X-16).
 */
export function checkLineage(feed: readonly FeedRevision[], engines: readonly EngineLineage[], label: (id: string) => string): Violation[] {
  return engines.flatMap((engine) => {
    const replay = new Replay(engine, label, feed);
    replay.run(feed);
    return replay.violations;
  });
}
