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
import { isVaultError, type VaultAdapter } from "../plugin/src/core/vault/adapter";
import { copiedFrom, type UserLedger } from "./invariants";
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
  ledger: UserLedger;
  /** Where the user is, for the ledger: e.g. `step 120`. */
  now: () => string;
  /** The paths the user creates files at and renames them to (RunContext.pathPool). */
  pathPool: readonly string[];
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
          return await this.write(random.pick(this.options.pathPool), random, "creates");
        case "edit": {
          const path = await this.pickFile(random);
          return path === undefined ? `${name} user edit: no file` : await this.write(path, random, "edits");
        }
        case "rename": {
          const from = await this.pickFile(random);
          if (from === undefined) return `${name} user rename: no file`;
          const to = random.pick(this.options.pathPool);
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
    const content = source instanceof Uint8Array ? source : this.content(source, await this.current(path));
    // What the write replaces, read in the same tick as the write (the in-memory vault reads synchronously), so an engine write in between is not taken for the user's.
    const replaced = this.snapshot(path);
    await this.options.vault.write(path, content);
    // Only once the vault took it: what was there is replaced, and the new content is owed.
    const current = await replaced;
    if (current !== undefined) this.replaced(sha256Hex(current), path);
    const hash = sha256Hex(content);
    this.options.ledger.write({ hash, path, at: this.options.now() });
    return `${this.options.name} user ${verb} ${path} (${hash.slice(0, 8)}, ${String(content.length)} B)`;
  }

  async rename(from: string, to: string): Promise<string> {
    await this.options.vault.rename(from, to);
    this.options.ledger.renamed(from, to);
    return `${this.options.name} user renames ${from} to ${to}`;
  }

  /** Deletes `path`; the inode oracle (sim/lineage.ts) sees which file it was. */
  async remove(path: string): Promise<string> {
    const deleted = this.snapshot(path);
    await this.options.vault.delete(path);
    const current = await deleted;
    if (current !== undefined) this.replaced(sha256Hex(current), path);
    this.options.ledger.deleted(path);
    return `${this.options.name} user deletes ${path}`;
  }

  /**
   * Runs `rename`, the engine's own move of the file at `from` to `to` (a
   * remote rename, or a move to its conflict copy of a path a remote document
   * takes, SPEC.md §6.3): the same file, so the user's writes it holds go
   * with it. Which document the file is, the inode oracle follows by itself.
   */
  async engineRenamed(from: string, to: string, rename: () => Promise<void>): Promise<void> {
    await rename();
    this.options.ledger.fileMoved(from, to);
  }

  /**
   * Runs `write`, the engine's own write of a file at `path`. A write of the
   * engine's conflict copy of a path (SPEC.md §6.3, §7) holds what the file
   * there held at that moment, so the user's writes whose file is there are
   * followed to the copy as well (#745): the user may rename, overwrite or
   * delete the copy later, whatever became of the file it was copied from.
   */
  async engineWrote(path: string, write: () => Promise<void>): Promise<void> {
    await write();
    for (const original of copiedFrom(path, this.options.name)) this.options.ledger.forkCopy(original, path);
  }

  /**
   * Records that the user replaced `hash` at `path`. A file the engine kept at
   * its conflict copy of a path (SPEC.md §6.3), by a move or a write, is the
   * file that was there, so it counts as a replacement at that path too.
   */
  private replaced(hash: string, path: string): void {
    for (const at of [path, ...copiedFrom(path, this.options.name)]) this.options.ledger.replace(hash, at);
  }

  /** The file at `path` as of this call, without waiting: the vault takes the snapshot synchronously. */
  private snapshot(path: string): Promise<Uint8Array | undefined> {
    return this.options.vault.read(path).catch(() => undefined);
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
