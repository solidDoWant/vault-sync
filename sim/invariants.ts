// User-visible invariants of the engines in a simulation run (#22, SPEC.md §2
// principle 1, §13). The harness records what each engine's user did, as it
// happened, in a UserLedger. After quiescence it checks the ledger against
// the final vaults and the server's history:
//
// - `lost-write`: every write of a user (a create or edit) survives, unless
//   that user replaced it themselves: wrote over or deleted, after it, the
//   file holding it, at a path that write's file had (keyed by content and
//   path, so replacing one file excuses no other write of the same content).
//   It survives if its content is in a final vault, in history (downloaded
//   and verified), or in a merged result the harness checked carries it
//   (carriesLocalEdit), which must survive in turn. A conflict copy is the
//   local content itself, so it survives only by being found. This
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

import { sha256Hex } from "../plugin/src/core/hash";
import { pathKey } from "../plugin/src/core/pathkey/pathkey";
import type { ProtocolClient } from "../plugin/src/core/protocol/client";
import type { VaultEvent } from "../plugin/src/core/vault/adapter";
import { filesystemKey, type PathPlatform } from "../plugin/src/core/vaultpath/platform";
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
  /**
   * Contents the user overwrote or deleted themselves, by `hash path-key` of
   * where, to how many writes there had been then: those writes of it are no
   * longer owed, if their file had that path.
   */
  private readonly replaced = new Map<string, number>();
  /**
   * Where each write's file went (`write` is its index): every path it had
   * since (by path key) and where it is now, until the user deleted it. A
   * write has one, plus one for each conflict copy the engine wrote of its
   * file (forkCopy).
   */
  private readonly tracks: { write: number; paths: Set<string>; current: string | undefined }[] = [];
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
  readonly match: (path: string) => string;

  constructor(
    readonly platform: PathPlatform = "posix",
    filesystem: "folded" | "faithful" = "folded",
  ) {
    this.match = pathMatcher(platform, filesystem);
  }

  write(write: UserWrite): void {
    const key = this.match(write.path);
    this.writes.push(write);
    this.tracks.push({ write: this.writes.length - 1, paths: new Set([key]), current: key });
    for (const rename of this.at(write.path)) rename.hashes.add(write.hash);
  }

  changed(change: UserChange): void {
    this.changes.push(change);
  }

  /** The user renamed the file at `from`, which the engine could take for `documents`, to `to`, where it holds `hash`. */
  renamed(from: string, to: string, documents: ReadonlySet<string>, hash: string): void {
    const key = this.match(to);
    this.follow(from, key);
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
    const key = this.match(to);
    this.follow(from, key);
    for (const rename of this.at(from)) {
      rename.current = key;
      rename.paths.add(key);
    }
  }

  /**
   * The engine wrote `copy`, its conflict copy of the file at `original`
   * (SPEC.md §6.3, §7), with what that file held: the writes whose file is at
   * `original` now are followed to `copy` as well, and from there through the
   * user's renames, where the user may overwrite or delete them (#745). The
   * fork is taken when the copy is written, not when the user renames it: by
   * then the user may have deleted or renamed the file at `original`, or
   * written another one there that the copy does not hold.
   */
  forkCopy(original: string, copy: string): void {
    const match = this.match;
    const [key, target] = [match(original), match(copy)];
    for (const track of [...this.tracks]) {
      if (track.current !== key || this.tracks.some((other) => other.write === track.write && other.current === target)) continue;
      this.tracks.push({ write: track.write, paths: new Set([target]), current: target });
    }
  }

  /** The engine moved the file at `from` to `to` (applying a remote rename): the writes it holds are followed there, for the lost-write check only. */
  fileMoved(from: string, to: string): void {
    this.follow(from, this.match(to));
  }

  /** The writes whose file is at `from` are at `to` (a path key) now. */
  private follow(from: string, to: string): void {
    const key = this.match(from);
    for (const track of this.tracks) {
      if (track.current !== key) continue;
      track.current = to;
      track.paths.add(to);
    }
  }

  /** The user deleted the file at `path`. */
  deleted(path: string): void {
    const key = this.match(path);
    for (const track of this.tracks) if (track.current === key) track.current = undefined;
    for (const rename of this.at(path)) rename.current = undefined;
  }

  /** The renames whose file is at `path` now. */
  private at(path: string): UserRename[] {
    const key = this.match(path);
    return this.renames.filter((rename) => rename.current === key);
  }

  crashed(serverSeq: bigint): void {
    this.crashes.push({ serverSeq, renames: this.renames.length });
  }

  /** The user overwrote or deleted the file at `path`, which held `hash`. */
  replace(hash: string, path: string): void {
    this.replaced.set(`${hash} ${this.match(path)}`, this.writes.length);
  }

  /** Whether the user replaced `hash` after write number `index`, at a path that write's file had. */
  replacedAfter(hash: string, index: number): boolean {
    return this.tracks.some((track) => track.write === index && [...track.paths].some((path) => (this.replaced.get(`${hash} ${path}`) ?? 0) > index));
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
    this.writes.forEach((write, index) => {
      const seen = new Set<string>();
      const visit = (hash: string): void => {
        if (seen.has(hash) || this.replacedAfter(hash, index)) return;
        seen.add(hash);
        owed.add(hash);
        for (const result of this.mergedInto.get(hash) ?? []) visit(result);
      };
      visit(write.hash);
    });
    return owed;
  }
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** The lines of UTF-8 `content`, without line endings, or undefined if it is not UTF-8. */
function textLines(content: Uint8Array): string[] | undefined {
  try {
    return strictDecoder.decode(content).split("\n").map((line) => line.replace(/\r$/u, ""));
  } catch {
    return undefined;
  }
}

/**
 * Every content a device's vaults held, by SHA-256 (hex): where the harness
 * finds the base or remote content of a merge whose hook never read it,
 * without reading it again, which would add calls to the run (#717). A
 * device's merge base is the content of the revision it last synced, which
 * it either pushed from its disk or pulled onto it, so its vaults held it.
 */
export class KnownContents {
  private readonly contents = new Map<string, Uint8Array>();

  add(content: Uint8Array): void {
    this.contents.set(sha256Hex(content), content);
  }

  /** The content hashing to `hash`, or null if the device never held it. */
  get(hash: string): Uint8Array | null {
    return this.contents.get(hash) ?? null;
  }
}

/** Takes one `line` from `counts`, if there is one left. */
function take(counts: Map<string, number>, line: string): boolean {
  const count = counts.get(line) ?? 0;
  if (count === 0) return false;
  counts.set(line, count - 1);
  return true;
}

/** How often each line occurs in `lines`. */
function lineCounts(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/**
 * Whether the merged `result` carries the local edit of `local` over `base`
 * (null if unknown or none): the harness's own check, independent of the merge code,
 * of what a merge hook reports as merged (#301). It does if it is the local
 * content, or if both are text and every non-empty line local added over the
 * base is a line of the result, as often as local added it (#717). A line
 * merge never joins two lines into one (#750), so a line the local edit added
 * that is only part of a line of the result is not carried. Without a base,
 * every non-empty local line must be in the result. A local edit that only
 * removed lines passes. A binary local content passes only if the result is it.
 */
export function carriesLocalEdit(local: Uint8Array, result: Uint8Array, base: Uint8Array | null): boolean {
  if (local.length === result.length && local.every((byte, index) => byte === result[index])) return true;
  const localLines = textLines(local);
  const resultLines = textLines(result);
  if (localLines === undefined || resultLines === undefined) return false;
  const remaining = lineCounts((base === null ? undefined : textLines(base)) ?? []);
  const available = lineCounts(resultLines);
  return localLines.every((line) => take(remaining, line) || line === "" || take(available, line));
}

/**
 * `lost-write`: the user writes of `engine` whose content survives nowhere.
 * `present` holds the contents of the final vaults and of history (as
 * verified by the harness).
 */
export function checkLostWrites(engine: string, ledger: UserLedger, present: ReadonlySet<string>): Violation[] {
  const survives = (hash: string, index: number, seen: Set<string>): boolean => {
    if (ledger.replacedAfter(hash, index) || present.has(hash)) return true;
    if (seen.has(hash)) return false;
    seen.add(hash);
    for (const result of ledger.mergedInto.get(hash) ?? []) if (survives(result, index, seen)) return true;
    return false;
  };
  const violations: Violation[] = [];
  for (const [index, write] of ledger.writes.entries()) {
    if (survives(write.hash, index, new Set())) continue;
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

/**
 * How `platform`'s vault matches paths: exactly under posix; where it
 * ignores case and Unicode form (windows, macos) by the filesystem's name
 * with the faithful filesystem, and by the path key of that name with the
 * folded one, as InMemoryVault looks files up. The vault decides which
 * file a write lands in: a write to `ı.md` on Windows is a write to the file
 * `I.md`, and with the faithful filesystem `Straße.md` and `STRASSE.md` are
 * two files (design §3.1, PO-10, decision #52), so a write is judged by its
 * file, not by its spelling or path key (#736).
 */
export function pathMatcher(platform: PathPlatform, filesystem: "folded" | "faithful" = "folded"): (path: string) => string {
  if (platform === "posix") return (path: string) => path;
  return filesystem === "faithful" ? (path: string) => filesystemKey(path, platform) : (path: string) => pathKey(filesystemKey(path, platform));
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
