// The user of an engine-driven simulation client (#22): random creates, edits,
// renames and deletes in its vault, as a person would make them in Obsidian,
// at any moment, also while the engine is pulling or pushing. Everything the
// user does is recorded in the client's UserLedger, which the lost-write,
// phantom-delete and resurrected-delete checks (sim/invariants.ts) hold the
// engine to.
//
// The user survives the app's crashes: the ledger is the harness's record,
// not the app's.

import { sha256Hex } from "../plugin/src/core/hash";
import type { Journal } from "../plugin/src/core/journal/journal";
import { isVaultError, type VaultAdapter } from "../plugin/src/core/vault/adapter";
import { pathPool } from "./client";
import type { UserLedger } from "./invariants";
import type { Random } from "./random";
import type { EngineOperation } from "./schedule";

/** Size of the occasional large content: spans several chunks at the sim server's 64 KiB chunk size. */
const largeContentBytes = 150 * 1024;
/** Contents shared with the scripted clients (client.ts), so blobs are shared too. */
const sharedContents = 6;

const encoder = new TextEncoder();

export interface EngineUserOptions {
  name: string;
  vault: VaultAdapter;
  journal: Journal;
  ledger: UserLedger;
  /** Where the user is, for the ledger: e.g. `step 120`. */
  now: () => string;
  /** Called with every path the user changes, so the engine's events there count as local changes. */
  touched: (path: string) => void;
  /** The server's head seq, recorded with each write and rename for the resurrected-delete check. */
  serverSeq: () => bigint;
}

export class EngineUser {
  private contentCounter = 0;

  constructor(private readonly options: EngineUserOptions) {}

  /** Performs `operation` (all but push) with choices from `random`; returns the trace entry. */
  async perform(operation: Exclude<EngineOperation, "push">, random: Random): Promise<string> {
    const { name } = this.options;
    try {
      switch (operation) {
        case "create":
          return await this.write(random.pick(pathPool), random, "creates");
        case "edit": {
          const path = await this.pickFile(random);
          return path === undefined ? `${name} user edit: no file` : await this.write(path, random, "edits");
        }
        case "rename": {
          const from = await this.pickFile(random);
          if (from === undefined) return `${name} user rename: no file`;
          const to = random.pick(pathPool);
          if (to === from) return `${name} user rename of ${from}: same path`;
          return await this.rename(from, to);
        }
        case "delete": {
          const path = await this.pickFile(random);
          return path === undefined ? `${name} user delete: no file` : await this.remove(path);
        }
      }
    } catch (error) {
      // The vault refused, as Obsidian would: the user's change did not happen.
      if (isVaultError(error)) return `${name} user ${operation} refused: ${error.code} ${error.path}`;
      throw error;
    }
  }

  /** Writes `source` (or new content chosen with it) to `path`, creating or editing the file; records the write. */
  async write(path: string, source: Random | Uint8Array, verb = "writes"): Promise<string> {
    const current = await this.current(path);
    const content = source instanceof Uint8Array ? source : this.content(source, current);
    this.options.touched(path);
    await this.options.vault.write(path, content);
    // Only once the vault took it: what was there is replaced, and the new content is owed.
    if (current !== undefined) this.options.ledger.replace(sha256Hex(current));
    const hash = sha256Hex(content);
    this.options.ledger.write({ hash, path, at: this.options.now() });
    this.options.ledger.changed({ paths: [path], result: { path, hash }, serverSeq: this.options.serverSeq(), at: this.options.now() });
    return `${this.options.name} user ${verb} ${path} (${hash.slice(0, 8)}, ${String(content.length)} B)`;
  }

  async rename(from: string, to: string): Promise<string> {
    this.options.touched(from);
    this.options.touched(to);
    await this.options.vault.rename(from, to);
    const serverSeq = this.options.serverSeq();
    this.recordRename(from, to);
    this.options.ledger.changed({ paths: [from, to], result: { path: to, hash: sha256Hex(await this.options.vault.read(to)) }, serverSeq, at: this.options.now() });
    return `${this.options.name} user renames ${from} to ${to}`;
  }

  /** Deletes `path`, recording the document the engine knows there (synced or pending) as deleted by the user. */
  async remove(path: string): Promise<string> {
    const current = await this.current(path);
    const documents = await this.documentsAt(path);
    this.options.touched(path);
    await this.options.vault.delete(path);
    if (current !== undefined) this.options.ledger.replace(sha256Hex(current));
    for (const document of documents) this.options.ledger.deletedDocuments.add(document);
    return `${this.options.name} user deletes ${path}`;
  }

  /**
   * The documents the engine may take the file at `path` for: the one its
   * journal synced there and any with a pending operation there. A rename the
   * engine has not recorded yet leaves the document under its old path, so
   * every document the user's earlier renames moved to `path` counts too:
   * the check must not blame the engine for the user's own delete.
   */
  private async documentsAt(path: string): Promise<Set<string>> {
    const documents = new Set<string>();
    const pending = await this.options.journal.listPending();
    for (const candidate of [path, ...(this.renamedFrom.get(path) ?? [])]) {
      const synced = await this.options.journal.findDocumentByPath(candidate);
      if (synced !== undefined) documents.add(synced.documentId);
      for (const operation of pending) if (operation.path === candidate) documents.add(operation.documentId);
    }
    return documents;
  }

  /** For each path, every path the user renamed a file from to reach it. */
  private readonly renamedFrom = new Map<string, Set<string>>();

  /** Records a rename for documentsAt, once it took effect. */
  private recordRename(from: string, to: string): void {
    const origins = this.renamedFrom.get(to) ?? new Set<string>();
    origins.add(from);
    for (const origin of this.renamedFrom.get(from) ?? []) origins.add(origin);
    this.renamedFrom.set(to, origins);
  }

  private async current(path: string): Promise<Uint8Array | undefined> {
    return (await this.options.vault.stat(path)) === null ? undefined : this.options.vault.read(path);
  }

  private async pickFile(random: Random): Promise<string | undefined> {
    const files = (await this.options.vault.list()).sort();
    return files.length === 0 ? undefined : random.pick(files);
  }

  /** New content: unique, or shared with the scripted clients; an edit often appends a line to what is there; sometimes large. */
  private content(random: Random, current: Uint8Array | undefined): Uint8Array {
    this.contentCounter++;
    const line = `${this.options.name} line ${String(this.contentCounter)} ${String(random.uint32())}\n`;
    let bytes: Uint8Array;
    if (current !== undefined && current.length < largeContentBytes && random.chance(0.5)) {
      bytes = new Uint8Array([...current, ...encoder.encode(line)]);
    } else if (random.chance(0.1)) {
      bytes = encoder.encode(`shared content ${String(random.int(sharedContents))}\n`);
    } else {
      bytes = encoder.encode(line);
    }
    if (random.chance(0.03)) {
      const large = new Uint8Array(largeContentBytes);
      for (let offset = 0; offset < large.length; offset += bytes.length) large.set(bytes.subarray(0, large.length - offset), offset);
      bytes = large;
    }
    return bytes;
  }
}
