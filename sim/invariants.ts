// User-visible invariants of the engines in a simulation run (#22, SPEC.md §2
// principle 1, §13). The harness records what each engine's user did, as it
// happened, in a UserLedger. After quiescence it checks the ledger against
// the final vaults and the server's history:
//
// - `lost-write`: every write of a user (a create or edit) survives, unless
//   that user replaced it themselves (wrote over it or deleted the file
//   holding it). It survives if its content is in a final vault, in history
//   (downloaded and verified), or in what the merge path made of it: the
//   merged result or the conflict copy, which must survive in turn. This
//   covers every acknowledged edit and also the ones a buggy engine never
//   pushed.
// - `phantom-delete`: every tombstone in the change feed was committed by a
//   scripted client (which deletes only when its schedule says so) or by an
//   engine whose user deleted that document's file. No file disappears
//   without a delete. One exception, the known limitation of #167 item 2: a
//   rename the app was killed before it recorded is pushed as a delete plus a
//   create, so the tombstone of a document whose file the user renamed away
//   is excused when the engine crashed after the rename, before the
//   tombstone, and then committed the renamed file, as the user left it,
//   where the user put it, as another document: a new one, or one whose file
//   the user deleted there (#254) (#280).
// - `resurrected-delete`: every live revision that follows a tombstone of
//   the same document was committed by a scripted client or by an engine
//   whose user wrote or renamed a file at one of that document's paths and
//   had not already had that change committed. A deleted document comes back
//   only through a concurrent edit (SPEC.md §4) or the user's re-creation of
//   the file (§8), never because an engine failed to apply a delete.
// - `engine-echo`: every change an engine reported as local (its
//   onLocalChange events) was emitted by a change its user made. The
//   engine's own writes, renames and deletes must never be reported (echo
//   suppression), not even at a path the user changed before.
//
// The checks are pure functions over recorded data, unit tested in
// invariants.test.ts.

import { bytesToHex } from "@noble/hashes/utils.js";

import { pathKey } from "../plugin/src/core/pathkey/pathkey";
import type { ProtocolClient } from "../plugin/src/core/protocol/client";
import type { VaultEvent } from "../plugin/src/core/vault/adapter";
import type { PathPlatform } from "../plugin/src/core/vaultpath/platform";
import type { Violation } from "./client";

/** A user's write: content they created or edited, which they may expect to find again. */
export interface UserWrite {
  /** SHA-256 (hex) of the written content. */
  hash: string;
  path: string;
  /** Where it happened, for the violation: e.g. `step 120`. */
  at: string;
}

/**
 * A user's write or rename, for the resurrected-delete check. `serverSeq` is
 * the server's head seq when it happened (every commit goes through the
 * simulated network, so the harness knows it exactly), which orders the
 * change against the revisions of the change feed without any clock: the
 * revisions with a greater seq were committed after it.
 */
export interface UserChange {
  /** The paths it changed: a write's path, a rename's old and new path. */
  paths: string[];
  /** What the file held afterwards, if the user knows: its path and content hash. */
  result: { path: string; hash: string } | undefined;
  serverSeq: bigint;
  at: string;
}

/**
 * A user's rename, for the phantom-delete check, with what became of the
 * renamed file: every path the user's later renames moved it to and every
 * content it held there, until the user deleted it.
 */
export interface UserRename {
  /** The documents the engine could take the renamed file for: its journal's at the old path, as the user's delete records them. */
  documents: ReadonlySet<string>;
  /** Every path the file had since, by path key on a case-insensitive platform. */
  paths: Set<string>;
  /** SHA-256 (hex) of every content the file held since. */
  hashes: Set<string>;
  /** Where the file is now (path key), or undefined once the user deleted it. */
  current: string | undefined;
}

/** The app was killed: the server's head seq then, and how many renames the user had made by then. */
export interface EngineCrash {
  serverSeq: bigint;
  renames: number;
}

/** What one engine's user did to its vault, and what the merge path made of local content. */
export class UserLedger {
  readonly writes: UserWrite[] = [];
  /** Contents the user overwrote or deleted themselves: no longer owed. */
  readonly replaced = new Set<string>();
  /** Local content handed to the merge hook, to the contents it became (the merged result and the conflict copy). */
  readonly mergedInto = new Map<string, Set<string>>();
  /** Documents whose file the user deleted. */
  readonly deletedDocuments = new Set<string>();
  /** Every write and rename, in order. */
  readonly changes: UserChange[] = [];
  /** Every rename, in order, for the phantom-delete check. */
  readonly renames: UserRename[] = [];
  /** Every time the app was killed, in order. */
  readonly crashes: EngineCrash[] = [];

  /** `platform`'s path matching, to follow a renamed file as its vault does. */
  constructor(readonly platform: PathPlatform = "posix") {}

  write(write: UserWrite): void {
    this.writes.push(write);
    for (const rename of this.at(write.path)) rename.hashes.add(write.hash);
  }

  changed(change: UserChange): void {
    this.changes.push(change);
  }

  /** The user renamed the file at `from`, which the engine could take for `documents`, to `to`, where it holds `hash`. */
  renamed(from: string, to: string, documents: ReadonlySet<string>, hash: string): void {
    const key = pathMatcher(this.platform)(to);
    for (const rename of this.at(from)) {
      rename.current = key;
      rename.paths.add(key);
      rename.hashes.add(hash);
    }
    this.renames.push({ documents, paths: new Set([key]), hashes: new Set([hash]), current: key });
  }

  /**
   * The engine moved the file at `from` to `to`, its own conflict copy
   * (#509): the renamed file is followed there, as through a rename of the
   * user's, with the content it already had.
   */
  movedByEngine(from: string, to: string): void {
    const key = pathMatcher(this.platform)(to);
    for (const rename of this.at(from)) {
      rename.current = key;
      rename.paths.add(key);
    }
  }

  /** The user deleted the file at `path`. */
  deleted(path: string): void {
    for (const rename of this.at(path)) rename.current = undefined;
  }

  /** The renames whose file is at `path` now. */
  private at(path: string): UserRename[] {
    const key = pathMatcher(this.platform)(path);
    return this.renames.filter((rename) => rename.current === key);
  }

  crashed(serverSeq: bigint): void {
    this.crashes.push({ serverSeq, renames: this.renames.length });
  }

  replace(hash: string): void {
    this.replaced.add(hash);
  }

  merged(local: string, result: string): void {
    if (local === result) return;
    let results = this.mergedInto.get(local);
    if (results === undefined) {
      results = new Set();
      this.mergedInto.set(local, results);
    }
    results.add(result);
  }

  /**
   * Every content that may have to be found again: the writes the user did
   * not replace and, transitively, what merges made of them. The harness
   * verifies those it finds only in history by downloading them.
   */
  owed(): Set<string> {
    const owed = new Set<string>();
    const visit = (hash: string): void => {
      if (owed.has(hash) || this.replaced.has(hash)) return;
      owed.add(hash);
      for (const result of this.mergedInto.get(hash) ?? []) visit(result);
    };
    for (const write of this.writes) visit(write.hash);
    return owed;
  }
}

/**
 * `lost-write`: the user writes of `engine` whose content survives nowhere.
 * `present` holds the contents of the final vaults and of history (as
 * verified by the harness).
 */
export function checkLostWrites(engine: string, ledger: UserLedger, present: ReadonlySet<string>): Violation[] {
  const survives = (hash: string, seen: Set<string>): boolean => {
    if (ledger.replaced.has(hash) || present.has(hash)) return true;
    if (seen.has(hash)) return false;
    seen.add(hash);
    for (const result of ledger.mergedInto.get(hash) ?? []) if (survives(result, seen)) return true;
    return false;
  };
  const violations: Violation[] = [];
  for (const write of ledger.writes) {
    if (survives(write.hash, new Set())) continue;
    violations.push({
      invariant: "lost-write",
      detail: `${engine}'s user wrote ${write.hash.slice(0, 8)} to ${write.path} at ${write.at}; it is in no vault, not in history and in no merge result or conflict copy`,
    });
  }
  return violations;
}

/** A revision of the change feed, as the phantom-delete check needs it. */
export interface FeedRevision {
  revisionId: string;
  documentId: string;
  seq: bigint;
  path: string;
  deleted: boolean;
  deviceId: string;
  /** Hex blob id. */
  contentHash: string;
  size: bigint;
}

/** An engine's device, with the documents its user deleted, its user's renames and its crashes. */
export interface EngineDeletes {
  name: string;
  deviceId: string;
  deletedDocuments: ReadonlySet<string>;
  platform: PathPlatform;
  renames: readonly UserRename[];
  crashes: readonly EngineCrash[];
}

/**
 * `phantom-delete`: the tombstones that no delete explains. A scripted
 * client's tombstone always is one (it deletes only when told to); an
 * engine's must be for a document its user deleted, or be the delete half of
 * a rename lost to a crash (renameLostToCrash).
 */
export function checkPhantomDeletes(feed: readonly FeedRevision[], scriptedDevices: ReadonlySet<string>, engines: readonly EngineDeletes[], label: (id: string) => string): Violation[] {
  const byDevice = new Map(engines.map((engine) => [engine.deviceId, engine]));
  const firstSeq = new Map<string, bigint>();
  for (const revision of feed) {
    const first = firstSeq.get(revision.documentId);
    if (first === undefined || revision.seq < first) firstSeq.set(revision.documentId, revision.seq);
  }
  const violations: Violation[] = [];
  for (const revision of feed) {
    if (!revision.deleted || scriptedDevices.has(revision.deviceId)) continue;
    const engine = byDevice.get(revision.deviceId);
    if (engine?.deletedDocuments.has(revision.documentId) === true) continue;
    if (engine !== undefined && renameLostToCrash(revision, engine, feed, firstSeq)) continue;
    violations.push({
      invariant: "phantom-delete",
      detail: `${engine?.name ?? `unknown device ${revision.deviceId}`} deleted ${label(revision.documentId)} at ${revision.path} (seq ${String(revision.seq)}, ${label(revision.revisionId)}) although ${engine === undefined ? "no client" : "its user never"} deleted it`,
    });
  }
  return violations;
}

/**
 * Whether `tombstone` is the delete half of a rename the engine lost to a
 * crash (#167 item 2): its user renamed the document's file away, the app was
 * killed after that and before the tombstone was committed, and after the
 * crash the engine committed the renamed file (a content it held, at a path
 * the user's renames gave it) as another document: a new one (its first
 * revision), or one whose file the user deleted, which the engine took the
 * file for at that path (#254). The user sees the same file at the same path;
 * only the document id changed. Nothing else is excused: not a rename the
 * running engine lost, not a delete without that create.
 */
function renameLostToCrash(tombstone: FeedRevision, engine: EngineDeletes, feed: readonly FeedRevision[], firstSeq: ReadonlyMap<string, bigint>): boolean {
  const key = pathMatcher(engine.platform);
  return engine.renames.some((rename, index) => {
    if (!rename.documents.has(tombstone.documentId)) return false;
    return engine.crashes.some(
      (crash) =>
        crash.renames > index &&
        crash.serverSeq < tombstone.seq &&
        feed.some(
          (create) =>
            create.deviceId === engine.deviceId &&
            !create.deleted &&
            create.documentId !== tombstone.documentId &&
            rename.hashes.has(create.contentHash) &&
            [create.path, ...copiedFrom(create.path, engine.name)].some((path) => rename.paths.has(key(path))) &&
            create.seq > crash.serverSeq &&
            (firstSeq.get(create.documentId) === create.seq || engine.deletedDocuments.has(create.documentId)),
        ),
    );
  });
}

/**
 * The paths whose conflict copy, made by the engine `device`, `path` is: one
 * segment of it carries the name conflictCopyPath or conflictFolderPath gives
 * (` (conflict <device> <date>[ <counter>])`, before a file's extension), and
 * the path without it is the original. A create the server refuses because
 * the path is taken is kept at such a path (SPEC.md §6.3), by the outermost
 * folder in the way if it is a folder (#359), as a rename there would be.
 */
export function copiedFrom(path: string, device: string): string[] {
  const escaped = device.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const suffix = new RegExp(` \\(conflict ${escaped} \\d{4}-\\d{2}-\\d{2} \\d{6}(?: \\d+)?\\)(?=(?:\\.[^/]*)?$)`, "u");
  const segments = path.split("/");
  return segments.flatMap((segment, index) => {
    const original = segment.replace(suffix, "");
    return original === segment || original === "" ? [] : [[...segments.slice(0, index), original, ...segments.slice(index + 1)].join("/")];
  });
}

/** An engine's device, with its platform and what its user wrote and renamed. */
export interface EngineChanges {
  name: string;
  deviceId: string;
  platform: PathPlatform;
  changes: readonly UserChange[];
}

/** How `platform` matches paths: by path key where it ignores case and Unicode form (windows, macos), exactly under posix. */
export function pathMatcher(platform: PathPlatform): (path: string) => string {
  return platform === "posix" ? (path: string) => path : pathKey;
}

/**
 * `resurrected-delete`: the live revisions after a tombstone that no user
 * change explains. A scripted client's always is one (it writes only when
 * told to). An engine's must carry a change of its user at one of the
 * document's paths (any it held up to the revision): one made before the
 * revision was committed, and not already carried by an earlier revision of
 * the same document from that engine. That earlier revision carries it if it
 * is a tombstone (the user deleted the file since) or if it holds what the
 * file held after that change or a later one at the document's paths. A
 * change the engine already pushed, followed by another device's delete,
 * does not explain the engine bringing the document back: that is the
 * engine failing to apply the delete.
 */
export function checkResurrections(feed: readonly FeedRevision[], scriptedDevices: ReadonlySet<string>, engines: readonly EngineChanges[], label: (id: string) => string): Violation[] {
  const byDevice = new Map(engines.map((engine) => [engine.deviceId, engine]));
  const byDocument = new Map<string, FeedRevision[]>();
  for (const revision of feed) {
    const revisions = byDocument.get(revision.documentId) ?? [];
    revisions.push(revision);
    byDocument.set(revision.documentId, revisions);
  }
  const violations: Violation[] = [];
  for (const revisions of byDocument.values()) {
    revisions.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    for (let index = 1; index < revisions.length; index++) {
      const revision = revisions[index];
      const previous = revisions[index - 1];
      if (revision === undefined || previous === undefined || revision.deleted || !previous.deleted) continue;
      if (scriptedDevices.has(revision.deviceId)) continue;
      const engine = byDevice.get(revision.deviceId);
      if (engine !== undefined && explained(engine, revisions.slice(0, index + 1))) continue;
      violations.push({
        invariant: "resurrected-delete",
        detail: `${engine?.name ?? `unknown device ${revision.deviceId}`} brought back ${label(revision.documentId)} at ${revision.path} (seq ${String(revision.seq)}, ${label(revision.revisionId)}) after its delete at ${previous.path} (seq ${String(previous.seq)}) ${engine === undefined ? "although no client of the run uses that device" : "although its user changed no file of it since"}`,
      });
    }
  }
  return violations;
}

/** Whether a change of `engine`'s user explains the last of `revisions` (one document's, by seq), which follows a tombstone. */
function explained(engine: EngineChanges, revisions: readonly FeedRevision[]): boolean {
  const resurrection = revisions[revisions.length - 1];
  if (resurrection === undefined) return false;
  const key = pathMatcher(engine.platform);
  const paths = new Set(revisions.map((revision) => key(revision.path)));
  const relevant = engine.changes.filter((change) => change.serverSeq < resurrection.seq && change.paths.some((path) => paths.has(key(path))));
  const own = revisions.filter((revision) => revision !== resurrection && revision.deviceId === engine.deviceId);
  return relevant.some((change, index) => {
    const carried = new Set(relevant.slice(index).flatMap((later) => (later.result === undefined ? [] : [`${later.result.hash}:${key(later.result.path)}`])));
    return !own.some((revision) => revision.seq > change.serverSeq && (revision.deleted || carried.has(`${revision.contentHash}:${key(revision.path)}`)));
  });
}

/**
 * `engine-echo`: the local changes `engine` reported that no change of its
 * user's emitted, i.e. its own writes, renames and deletes it took for the
 * user's. `userEvents` holds the events the engine received while a change of
 * the user's was being applied (the vaults emit synchronously within the
 * change), so an event is excused only by the very user operation it fired
 * in: an engine write at a path the user changed earlier is still reported.
 * On a case-insensitive platform the vault reports a change under the file's
 * own spelling (#247), which needs no path matching here.
 */
export function checkEngineEchoes(engine: string, events: readonly VaultEvent[], userEvents: { has(event: VaultEvent): boolean }): Violation[] {
  const violations: Violation[] = [];
  for (const event of events) {
    if (userEvents.has(event)) continue;
    violations.push({ invariant: "engine-echo", detail: `${engine} reported its own ${event.type} of ${event.path} as a local change` });
  }
  return violations;
}

/** Every revision in the vault's change feed, read without faults. */
export async function serverFeed(api: ProtocolClient, vaultId: string): Promise<FeedRevision[]> {
  const feed: FeedRevision[] = [];
  let since = 0n;
  for (;;) {
    const response = await api.sync.listChanges({ vaultId, sinceSeq: since, pageSize: 1000 });
    for (const revision of response.revisions) {
      feed.push({
        revisionId: revision.id,
        documentId: revision.documentId,
        seq: revision.seq,
        path: new TextDecoder().decode(revision.path),
        deleted: revision.deleted,
        deviceId: revision.deviceId,
        contentHash: bytesToHex(revision.contentRef?.blobId ?? new Uint8Array()),
        size: revision.contentRef?.size ?? 0n,
      });
      since = revision.seq;
    }
    if (!response.hasMore) return feed;
  }
}
