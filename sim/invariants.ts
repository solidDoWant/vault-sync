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
//   without a delete.
// - `engine-echo`: every change an engine reported as local (its
//   onLocalChange events) is at a path its user changed. The engine's own
//   writes, renames and deletes must never be reported (echo suppression).
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

/** What one engine's user did to its vault, and what the merge path made of local content. */
export class UserLedger {
  readonly writes: UserWrite[] = [];
  /** Contents the user overwrote or deleted themselves: no longer owed. */
  readonly replaced = new Set<string>();
  /** Local content handed to the merge hook, to the contents it became (the merged result and the conflict copy). */
  readonly mergedInto = new Map<string, Set<string>>();
  /** Documents whose file the user deleted. */
  readonly deletedDocuments = new Set<string>();

  write(write: UserWrite): void {
    this.writes.push(write);
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

/** An engine's device, with the documents its user deleted. */
export interface EngineDeletes {
  name: string;
  deviceId: string;
  deletedDocuments: ReadonlySet<string>;
}

/**
 * `phantom-delete`: the tombstones that no delete explains. A scripted
 * client's tombstone always is one (it deletes only when told to); an
 * engine's must be for a document its user deleted.
 */
export function checkPhantomDeletes(feed: readonly FeedRevision[], scriptedDevices: ReadonlySet<string>, engines: readonly EngineDeletes[], label: (id: string) => string): Violation[] {
  const byDevice = new Map(engines.map((engine) => [engine.deviceId, engine]));
  const violations: Violation[] = [];
  for (const revision of feed) {
    if (!revision.deleted || scriptedDevices.has(revision.deviceId)) continue;
    const engine = byDevice.get(revision.deviceId);
    if (engine?.deletedDocuments.has(revision.documentId) === true) continue;
    violations.push({
      invariant: "phantom-delete",
      detail: `${engine?.name ?? `unknown device ${revision.deviceId}`} deleted ${label(revision.documentId)} at ${revision.path} (seq ${String(revision.seq)}, ${label(revision.revisionId)}) although ${engine === undefined ? "no client" : "its user never"} deleted it`,
    });
  }
  return violations;
}

/**
 * `engine-echo`: the local changes `engine` reported at a path its user never
 * changed, i.e. its own writes, renames and deletes it took for the user's.
 * `touched` holds the paths the user changed, as the user spelled them. On a
 * case-insensitive platform (windows, macos) the vault resolves another
 * spelling to the same file and reports the change under the file's own
 * spelling (#247): the user's write of `STRASSE.md` over `straße.md` is a
 * modify of `straße.md`. So paths match as the engine's vault matches them:
 * by path key there (SPEC.md §5), exactly under posix.
 */
export function checkEngineEchoes(engine: string, events: readonly VaultEvent[], touched: ReadonlySet<string>, platform: PathPlatform): Violation[] {
  const key = platform === "posix" ? (path: string) => path : pathKey;
  const touchedKeys = new Set([...touched].map(key));
  const violations: Violation[] = [];
  for (const event of events) {
    if (touchedKeys.has(key(event.path))) continue;
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
