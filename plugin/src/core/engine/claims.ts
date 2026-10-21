import type { Journal } from "../journal/journal";
import { conflictCopyPath, conflictFolderPath } from "../merge/conflict-name";
import type { VaultAdapter } from "../vault/adapter";
import type { PathRules } from "../vaultpath/platform";
import type { PathEquivalence, PathSpace } from "./pathspace";

/**
 * What holds a path (docs/design/engine-path-ownership.md §4.2):
 *
 * - `disk`: a file the vault lists.
 * - `server-known`: a live document's synced path, where the server has it.
 * - `server-newer`: a live remote revision held deferred, where the server
 *   has its document now, though this vault does not show it there yet.
 * - `outgoing`: a pending operation's path, what the next push commits.
 * - `reserved`: a logged conflict copy's name.
 */
export type ClaimKind = "disk" | "server-known" | "server-newer" | "outgoing" | "reserved";

export interface Claim {
  kind: ClaimKind;
  path: string;
  /** The claiming document; none for a disk claim (bindings come with R4). */
  documentId?: string;
}

/**
 * The document an operation moves, for `freeCopyName`: none of its claims
 * takes a copy name except where it goes. `file` is its own listed file the
 * operation moves away from or deletes, if any, and `result` the path it goes
 * to, or null for a delete.
 */
export interface Exempt {
  documentId: string;
  file: string | undefined;
  result: string | null;
}

/** How copy names are made (SPEC.md §7). */
export interface CopyNaming {
  deviceName: string;
  date: Date;
  rules: PathRules;
  /** Numbered names tried before giving up. */
  maxAttempts: number;
}

type ClaimJournal = Pick<Journal, "listDocuments" | "listDeferred" | "listPending" | "listConflicts">;
type ClaimVault = Pick<VaultAdapter, "list" | "stat" | "isSynced">;

/**
 * The claim table (docs/design/engine-path-ownership.md §4.2, §9.1): every
 * path the vault, the journal or the server is known to hold, derived from
 * the journal and the vault listing when loaded and never stored. It is the
 * one place conflict-copy names come from (PO-14).
 */
export class PathClaims {
  private constructor(
    private readonly space: PathSpace,
    private readonly vault: ClaimVault,
    private readonly claims: readonly Claim[],
  ) {}

  /** The claims as the journal and the vault have them now. */
  static async load(space: PathSpace, journal: ClaimJournal, vault: ClaimVault): Promise<PathClaims> {
    const claims: Claim[] = [];
    for (const path of await vault.list()) claims.push({ kind: "disk", path });
    for (const state of await journal.listDocuments()) if (!state.deleted) claims.push({ kind: "server-known", path: state.path, documentId: state.documentId });
    for (const { revision } of await journal.listDeferred()) if (!revision.deleted) claims.push({ kind: "server-newer", path: revision.path, documentId: revision.documentId });
    for (const operation of await journal.listPending()) claims.push({ kind: "outgoing", path: operation.path, documentId: operation.documentId });
    for (const record of await journal.listConflicts()) if (record.copyPath !== null) claims.push({ kind: "reserved", path: record.copyPath, documentId: record.documentId });
    return new PathClaims(space, vault, claims);
  }

  /** Every claim colliding with `path` under `equivalence`, folders included (§3.2). */
  collisions(path: string, equivalence: PathEquivalence): Claim[] {
    return this.claims.filter((claim) => this.space.collides(path, claim.path, equivalence));
  }

  /**
   * The first conflict-copy name for `path` (SPEC.md §7) that no claim
   * holds, or null if no name fits the path limits.
   *
   * Every name is compared by path key (`K`), as the server compares them,
   * whatever the platform (#243); listed files are compared by the
   * filesystem's equivalence (`F`) as well, since the vault cannot hold a
   * copy there either. Files, documents and deferred revisions also hold
   * their folders: a name under one of them, or a folder of one, is taken.
   * Pending operations and logged copies are compared as names only: a live
   * operation's or a written copy's file is a listed file already, and a
   * pending delete holds no path.
   *
   * If a file, document or deferred revision is named like one of `path`'s
   * folders, no name in that folder is free, so the outermost such folder
   * gets the conflict name and the path keeps its place inside it (#359).
   *
   * `exempt`'s claims take no name except where it goes: neither its file
   * that it moves away from or deletes (#319) nor its synced path, unless its
   * result goes there (#299). The folders of its result are folders whatever
   * else is named like them, so they never block (#352).
   */
  async freeCopyName(path: string, naming: CopyNaming, exempt?: Exempt): Promise<string | null> {
    const serverKey = (candidate: string) => this.space.serverKey(candidate);
    const filesystemKey = (candidate: string) => this.space.filesystemKey(candidate);
    const names = new Set<string>();
    const files = new Set<string>();
    const listed = new Set<string>();
    for (const claim of this.claims) {
      switch (claim.kind) {
        case "disk":
          if (claim.path === exempt?.file) continue;
          files.add(serverKey(claim.path));
          listed.add(filesystemKey(claim.path));
          break;
        case "server-known":
          if (exempt !== undefined && claim.documentId === exempt.documentId && (exempt.result === null || serverKey(claim.path) !== serverKey(exempt.result))) continue;
          files.add(serverKey(claim.path));
          break;
        case "server-newer":
          files.add(serverKey(claim.path));
          break;
        case "outgoing":
        case "reserved":
          names.add(serverKey(claim.path));
          break;
      }
    }
    const result = exempt?.result ?? null;
    const byKey = holder(files, result === null ? [] : this.space.ancestors(serverKey(result)), (key) => this.space.ancestors(key));
    const byFile = holder(listed, result === null ? [] : this.space.ancestors(filesystemKey(result)), (key) => this.space.ancestors(key));
    const named = this.space.ancestors(path).find((ancestor) => byKey.blocks(serverKey(ancestor)));
    for (let attempt = 1; attempt <= naming.maxAttempts; attempt++) {
      const candidate =
        named === undefined
          ? conflictCopyPath(path, naming.deviceName, naming.date, attempt, naming.rules)
          : conflictFolderPath(named, path.slice(named.length + 1), naming.deviceName, naming.date, attempt, naming.rules);
      if (candidate === null) return null;
      const key = serverKey(candidate);
      if (names.has(key) || byKey.takes(key) || byFile.takes(filesystemKey(candidate))) continue;
      // A file outside the sync scope is not listed, but it is there.
      if (!(this.vault.isSynced?.(candidate) ?? true) && (await this.vault.stat(candidate)) !== null) continue;
      return candidate;
    }
    return null;
  }
}

/**
 * Files under one equivalence and the folders they imply. A file blocks the
 * names under it unless it is one of `openFolders`.
 */
function holder(files: Set<string>, openFolders: string[], ancestors: (key: string) => string[]) {
  const folders = new Set<string>();
  for (const file of files) for (const ancestor of ancestors(file)) folders.add(ancestor);
  const open = new Set(openFolders);
  const blocks = (key: string) => files.has(key) && !open.has(key);
  return {
    blocks,
    takes: (key: string) => files.has(key) || folders.has(key) || ancestors(key).some(blocks),
  };
}
