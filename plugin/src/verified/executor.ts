// The effect executor of the shell around the verified core (#1041, split
// item 1 of #952; docs/design/verified-core.md §2.3). It runs the effects the
// compiled core returned for one step, in the order returned, against an
// `EffectShell` that performs them on the vault, the server and the journal
// store.
//
// A disk effect takes effect only when its precondition holds on the disk,
// comparing names under the device's `F` (spec/Engine.dfy `EffectTakes`,
// SPEC.md §8 "Conditional writes"). The executor checks it right before the
// effect, on the disk the earlier effects left; when it does not hold, the
// effect does nothing and is reported as skipped. A skipped effect still
// counts as run: it is part of the step, as in the specification.
//
// A failure of the shell (a crash, an I/O error) stops the run at that
// effect: no later effect is started, so the effects run are a prefix of the
// effects the core returned (`CrashCutsShort`, with `CutRequestedByCore`
// tying the requested effects to the core's step, spec/Contracts.dfy).
import { PathSpace } from "../core/engine/pathspace";
import type { PathPlatform } from "../core/vaultpath/platform";
import type { DiskFile, Effect, Journal, Kind, Outbox } from "./local-core";

/** A file found on the disk: the spelling it has there and its content. */
export interface FoundFile {
  spelling: string;
  file: DiskFile;
}

/**
 * What the executor needs of the device. The reads (`fileAt`, `colliding`)
 * check preconditions; every other method performs one effect and is called
 * only once its precondition held.
 */
export interface EffectShell {
  /** The file at `path` under the platform's file key, or null. */
  fileAt(path: string): Promise<FoundFile | null>;
  /**
   * The spellings of every file on the disk that collides with `path` under
   * the platform's file key: the same name, a file where a folder of `path`
   * would be, or a file under `path` (design §3.2).
   */
  colliding(path: string): Promise<string[]>;
  /** Overwrites the file at `spelling` in place. */
  overwrite(spelling: string, content: string, kind: Kind): Promise<void>;
  /** Creates a new file at `path`, which no file collides with. */
  create(path: string, content: string, kind: Kind): Promise<void>;
  /** Deletes the file at `spelling`. */
  remove(spelling: string): Promise<void>;
  /** Moves the file at `spelling`, with its contents, to `to`. */
  move(spelling: string, to: string): Promise<void>;
  readFile(path: string): Promise<void>;
  upload(content: string): Promise<void>;
  commit(doc: string, outbox: Outbox): Promise<void>;
  pull(cursor: number): Promise<void>;
  persistJournal(journal: Journal): Promise<void>;
  report(subject: string | null, path: string, reason: string): Promise<void>;
}

/** What became of one effect: performed, or skipped because its precondition failed. */
export type Outcome = "performed" | "skipped";

/** One effect run, in the order returned. */
export interface Ran {
  effect: Effect;
  outcome: Outcome;
}

/** The shell failed while running an effect; `ran` are the effects run before it. */
export class EffectsInterrupted extends Error {
  constructor(
    readonly ran: readonly Ran[],
    readonly failed: Effect,
    options: { cause: unknown },
  ) {
    super(
      `effect executor: interrupted at effect ${String(ran.length + 1)} (${failed.kind})`,
      options,
    );
    this.name = "EffectsInterrupted";
  }
}

/**
 * Runs `effects` in order on `shell`, checking each disk effect's
 * precondition right before it. Resolves with every effect's outcome; rejects
 * with `EffectsInterrupted` at the first failure of the shell.
 */
export async function executeEffects(
  platform: PathPlatform,
  effects: readonly Effect[],
  shell: EffectShell,
): Promise<Ran[]> {
  const space = new PathSpace({ platform });
  const ran: Ran[] = [];
  for (const effect of effects) {
    let outcome: Outcome;
    try {
      outcome = await runOne(space, effect, shell);
    } catch (cause) {
      throw new EffectsInterrupted([...ran], effect, { cause });
    }
    ran.push({ effect, outcome });
  }
  return ran;
}

async function runOne(
  space: PathSpace,
  effect: Effect,
  shell: EffectShell,
): Promise<Outcome> {
  switch (effect.kind) {
    case "write": {
      if (effect.precondition === null) {
        // A new file, only where no file collides with its name.
        if ((await shell.colliding(effect.path)).length > 0) return "skipped";
        await shell.create(effect.path, effect.content, effect.fileKind);
        return "performed";
      }
      const found = await shell.fileAt(effect.path);
      if (found?.file.content !== effect.precondition) return "skipped";
      await shell.overwrite(found.spelling, effect.content, effect.fileKind);
      return "performed";
    }
    case "remove": {
      const found = await shell.fileAt(effect.path);
      if (found?.file.content !== effect.expected) return "skipped";
      await shell.remove(found.spelling);
      return "performed";
    }
    case "move": {
      const found = await shell.fileAt(effect.from);
      if (found?.file.content !== effect.expected) return "skipped";
      // No other file collides with the new name, and neither name is a
      // folder of the other; a rename that only changes the case is allowed.
      const others = (await shell.colliding(effect.to)).filter(
        (spelling) => spelling !== found.spelling,
      );
      if (others.length > 0) return "skipped";
      if (space.nested(found.spelling, effect.to)) return "skipped";
      await shell.move(found.spelling, effect.to);
      return "performed";
    }
    case "read-file":
      await shell.readFile(effect.path);
      return "performed";
    case "upload":
      await shell.upload(effect.content);
      return "performed";
    case "commit":
      await shell.commit(effect.doc, effect.outbox);
      return "performed";
    case "pull":
      await shell.pull(effect.cursor);
      return "performed";
    case "persist-journal":
      await shell.persistJournal(effect.journal);
      return "performed";
    case "report":
      await shell.report(effect.subject, effect.path, effect.reason);
      return "performed";
  }
}
