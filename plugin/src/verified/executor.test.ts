// The effect executor (#1041): each disk effect's precondition is checked on
// the disk the earlier effects left (spec/Engine.dfy `EffectTakes`), and a
// failure of the shell anywhere leaves exactly a prefix of the effects the
// compiled core returned run (`CrashCutsShort`, `CutRequestedByCore`).
import BigNumber from "bignumber.js";
import { describe, expect, it } from "vitest";

import { filesystemKey, type PathPlatform } from "../core/vaultpath/platform";
import {
  EffectsInterrupted,
  executeEffects,
  type EffectShell,
  type FoundFile,
  type Ran,
} from "./executor";
import verified from "./gen/verified.cjs";
import {
  CoreDevice,
  type DiskFile,
  type Effect,
  effectFrom,
  type Journal,
  type Kind,
  type Outbox,
  synced,
} from "./local-core";

const D = verified.LocalCoreJs;
const str = (value: string) => verified._dafny.Seq.UnicodeFromString(value);
const some = (value: string) => D.Option.create_Some(str(value)) as never;
const none = () => D.Option.create_None() as never;

class Crash extends Error {}

/**
 * A device's disk, server and journal store in memory. Its own file key
 * comparisons are written here from design §3.2, not taken from the
 * executor. With `failAt`, the shell call with that index (from 0, reads
 * included) throws instead of acting.
 */
class MemoryShell implements EffectShell {
  readonly disk: Map<string, DiskFile>;
  /** Everything the shell did besides the disk, in order. */
  readonly log: string[] = [];
  private calls = 0;

  constructor(
    readonly platform: PathPlatform,
    disk: Record<string, DiskFile> = {},
    readonly failAt = Number.POSITIVE_INFINITY,
  ) {
    this.disk = new Map(Object.entries(disk));
  }

  get callCount(): number {
    return this.calls;
  }

  private call(): void {
    if (this.calls++ === this.failAt) throw new Crash("injected failure");
  }

  private key(path: string): string {
    return filesystemKey(path, this.platform);
  }

  fileAt(path: string): Promise<FoundFile | null> {
    this.call();
    for (const [spelling, file] of this.disk)
      if (this.key(spelling) === this.key(path))
        return Promise.resolve({ spelling, file });
    return Promise.resolve(null);
  }

  colliding(path: string): Promise<string[]> {
    this.call();
    const key = this.key(path);
    return Promise.resolve(
      [...this.disk.keys()].filter((spelling) => {
        const other = this.key(spelling);
        return (
          other === key ||
          other.startsWith(`${key}/`) ||
          key.startsWith(`${other}/`)
        );
      }),
    );
  }

  overwrite(spelling: string, content: string, kind: Kind): Promise<void> {
    this.call();
    if (!this.disk.has(spelling)) throw new Error(`no file ${spelling}`);
    this.disk.set(spelling, { content, kind });
    return Promise.resolve();
  }

  create(path: string, content: string, kind: Kind): Promise<void> {
    this.call();
    this.disk.set(path, { content, kind });
    return Promise.resolve();
  }

  remove(spelling: string): Promise<void> {
    this.call();
    if (!this.disk.delete(spelling)) throw new Error(`no file ${spelling}`);
    return Promise.resolve();
  }

  move(spelling: string, to: string): Promise<void> {
    this.call();
    const file = this.disk.get(spelling);
    if (file === undefined) throw new Error(`no file ${spelling}`);
    this.disk.delete(spelling);
    this.disk.set(to, file);
    return Promise.resolve();
  }

  readFile(path: string): Promise<void> {
    return this.record(`read ${path}`);
  }
  upload(content: string): Promise<void> {
    return this.record(`upload ${content}`);
  }
  commit(doc: string, outbox: Outbox): Promise<void> {
    return this.record(`commit ${doc} ${outbox.rev}`);
  }
  pull(cursor: number): Promise<void> {
    return this.record(`pull ${String(cursor)}`);
  }
  persistJournal(journal: Journal): Promise<void> {
    return this.record(`persist ${JSON.stringify(journal)}`);
  }
  report(subject: string | null, path: string, reason: string): Promise<void> {
    return this.record(`report ${String(subject)} ${path} ${reason}`);
  }

  private record(entry: string): Promise<void> {
    this.call();
    this.log.push(entry);
    return Promise.resolve();
  }

  state(): { disk: Record<string, DiskFile>; log: string[] } {
    return { disk: Object.fromEntries(this.disk), log: [...this.log] };
  }
}

const note = (content: string): DiskFile => ({ content, kind: "note" });

const write = (
  path: string,
  content: string,
  precondition: string | null,
  target: string | null = "A",
): Effect => ({
  kind: "write",
  target,
  path,
  content,
  fileKind: "note",
  precondition,
});
const remove = (path: string, expected: string): Effect => ({
  kind: "remove",
  doc: "A",
  path,
  expected,
});
const move = (from: string, to: string, expected: string): Effect => ({
  kind: "move",
  mover: "A",
  from,
  to,
  expected,
});

const outbox: Outbox = {
  rev: "A#2",
  baseRev: "A@1",
  path: "a.md",
  content: "a2",
  kind: "note",
  deleted: false,
  sealed: true,
  rejected: false,
};

describe("effectFrom", () => {
  it("reads every effect the compiled core can return", () => {
    const dafnyOutbox = D.Outbox.create_Outbox(
      str("A#2"),
      some("A@1"),
      str("a.md"),
      str("a2"),
      D.Kind.create_Note(),
      false,
      true,
      false,
    );
    const journal = D.Journal.create_Journal(
      verified._dafny.Map.Empty,
      new BigNumber(3),
      verified._dafny.Seq.of(),
      verified._dafny.Seq.of(),
    );
    const effects = [
      D.Effect.create_Write(
        none(),
        str("c.md"),
        str("c1"),
        D.Kind.create_Binary(),
        some("c0"),
      ),
      D.Effect.create_Write(
        some("A"),
        str("a.md"),
        str("a2"),
        D.Kind.create_Note(),
        none(),
      ),
      D.Effect.create_Remove(str("A"), str("a.md"), str("a1")),
      D.Effect.create_Move(none(), str("a.md"), str("b.md"), str("a1")),
      D.Effect.create_Move(some("A"), str("a.md"), str("b.md"), str("a1")),
      D.Effect.create_ReadFile(str("a.md")),
      D.Effect.create_Upload(str("a2")),
      D.Effect.create_Commit(str("A"), dafnyOutbox),
      D.Effect.create_Pull(new BigNumber(7)),
      D.Effect.create_PersistJournal(journal),
      D.Effect.create_Report(none(), str("x.md"), str("unsupported")),
      D.Effect.create_Report(some("A"), str("a.md"), str("conflict")),
    ];

    expect(effects.map(effectFrom)).toEqual([
      {
        kind: "write",
        target: null,
        path: "c.md",
        content: "c1",
        fileKind: "binary",
        precondition: "c0",
      },
      write("a.md", "a2", null, "A"),
      remove("a.md", "a1"),
      { ...move("a.md", "b.md", "a1"), mover: null },
      move("a.md", "b.md", "a1"),
      { kind: "read-file", path: "a.md" },
      { kind: "upload", content: "a2" },
      { kind: "commit", doc: "A", outbox },
      { kind: "pull", cursor: 7 },
      { kind: "persist-journal", journal: { documents: {}, cursor: 3 } },
      { kind: "report", subject: null, path: "x.md", reason: "unsupported" },
      { kind: "report", subject: "A", path: "a.md", reason: "conflict" },
    ]);
  });
});

describe("executeEffects: preconditions", () => {
  interface Case {
    name: string;
    platform?: PathPlatform;
    disk: Record<string, DiskFile>;
    effect: Effect;
    outcome: "performed" | "skipped";
    after?: Record<string, DiskFile>;
  }
  const cases: Case[] = [
    {
      name: "a conditional write overwrites the file holding the expected content",
      disk: { "a.md": note("a1") },
      effect: write("a.md", "a2", "a1"),
      outcome: "performed",
      after: { "a.md": note("a2") },
    },
    {
      name: "a conditional write overwrites the file under its own spelling where case folds",
      platform: "windows",
      disk: { "a.md": note("a1") },
      effect: write("A.md", "a2", "a1"),
      outcome: "performed",
      after: { "a.md": note("a2") },
    },
    {
      name: "a conditional write does nothing when the file holds other content",
      disk: { "a.md": note("edited") },
      effect: write("a.md", "a2", "a1"),
      outcome: "skipped",
    },
    {
      name: "a conditional write does nothing when no file is there",
      disk: {},
      effect: write("a.md", "a2", "a1"),
      outcome: "skipped",
    },
    {
      name: "a conditional write does not take a file of another name on posix",
      disk: { "A.md": note("a1") },
      effect: write("a.md", "a2", "a1"),
      outcome: "skipped",
    },
    {
      name: "a write on no file creates the file at a free name",
      disk: { "b.md": note("b1") },
      effect: write("a.md", "a1", null),
      outcome: "performed",
      after: { "b.md": note("b1"), "a.md": note("a1") },
    },
    {
      name: "a write on no file does nothing when a file is there",
      disk: { "a.md": note("other") },
      effect: write("a.md", "a1", null),
      outcome: "skipped",
    },
    {
      name: "a write on no file does nothing when another spelling of the name is there",
      platform: "windows",
      disk: { "A.md": note("other") },
      effect: write("a.md", "a1", null),
      outcome: "skipped",
    },
    {
      name: "a write on no file creates another spelling where case does not fold",
      disk: { "A.md": note("other") },
      effect: write("a.md", "a1", null),
      outcome: "performed",
      after: { "A.md": note("other"), "a.md": note("a1") },
    },
    {
      name: "a write on no file does nothing where one of its folders is a file",
      disk: { notes: note("n") },
      effect: write("notes/a.md", "a1", null),
      outcome: "skipped",
    },
    {
      name: "a write on no file does nothing where its name is a folder of a file",
      disk: { "notes/a.md": note("a1") },
      effect: write("notes", "n", null),
      outcome: "skipped",
    },
    {
      name: "a remove deletes the file holding the expected content",
      disk: { "a.md": note("a1"), "b.md": note("b1") },
      effect: remove("a.md", "a1"),
      outcome: "performed",
      after: { "b.md": note("b1") },
    },
    {
      name: "a remove does nothing when the file holds other content",
      disk: { "a.md": note("edited") },
      effect: remove("a.md", "a1"),
      outcome: "skipped",
    },
    {
      name: "a remove does nothing when no file is there",
      disk: {},
      effect: remove("a.md", "a1"),
      outcome: "skipped",
    },
    {
      name: "a move takes the file holding the expected content to a free name",
      disk: { "a.md": note("a1") },
      effect: move("a.md", "b.md", "a1"),
      outcome: "performed",
      after: { "b.md": note("a1") },
    },
    {
      name: "a move does nothing when the file holds other content",
      disk: { "a.md": note("edited") },
      effect: move("a.md", "b.md", "a1"),
      outcome: "skipped",
    },
    {
      name: "a move does nothing when the file is gone",
      disk: {},
      effect: move("a.md", "b.md", "a1"),
      outcome: "skipped",
    },
    {
      name: "a move does nothing when another file holds the new name",
      disk: { "a.md": note("a1"), "b.md": note("b1") },
      effect: move("a.md", "b.md", "a1"),
      outcome: "skipped",
    },
    {
      name: "a move does nothing when another spelling of the new name is there",
      platform: "windows",
      disk: { "a.md": note("a1"), "B.md": note("b1") },
      effect: move("a.md", "b.md", "a1"),
      outcome: "skipped",
    },
    {
      name: "a move changes only the case of a name",
      platform: "windows",
      disk: { "a.md": note("a1") },
      effect: move("a.md", "A.md", "a1"),
      outcome: "performed",
      after: { "A.md": note("a1") },
    },
    {
      name: "a move does nothing into a folder of its own name",
      disk: { "a.md": note("a1") },
      effect: move("a.md", "a.md/b.md", "a1"),
      outcome: "skipped",
    },
    {
      name: "a move does nothing onto one of its own folders",
      disk: { "notes/a.md": note("a1") },
      effect: move("notes/a.md", "notes", "a1"),
      outcome: "skipped",
    },
    {
      name: "a move does nothing where a folder of the new name is a file",
      disk: { "a.md": note("a1"), notes: note("n") },
      effect: move("a.md", "notes/a.md", "a1"),
      outcome: "skipped",
    },
  ];

  it.each(cases)(
    "$name",
    async ({ platform = "posix", disk, effect, outcome, after }) => {
      const shell = new MemoryShell(platform, disk);

      const ran = await executeEffects(platform, [effect], shell);

      expect(ran).toEqual([{ effect, outcome }]);
      expect(shell.state()).toEqual({ disk: after ?? disk, log: [] });
    },
  );

  it("checks each precondition on the disk the earlier effects left", async () => {
    const shell = new MemoryShell("posix", { "a.md": note("a1") });
    const effects = [
      write("b.md", "b1", null),
      move("b.md", "c.md", "b1"),
      write("c.md", "c2", "b1"),
      remove("a.md", "a1"),
      remove("a.md", "a1"),
    ];

    const ran = await executeEffects("posix", effects, shell);

    expect(ran.map((entry) => entry.outcome)).toEqual([
      "performed",
      "performed",
      "performed",
      "performed",
      "skipped",
    ]);
    expect(shell.state().disk).toEqual({ "c.md": note("c2") });
  });

  it("runs the effects after a skipped one", async () => {
    const shell = new MemoryShell("posix", { "a.md": note("edited") });
    const effects: Effect[] = [
      write("a.md", "a2", "a1"),
      write("b.md", "b1", null),
      { kind: "upload", content: "b1" },
    ];

    const ran = await executeEffects("posix", effects, shell);

    expect(ran.map((entry) => entry.outcome)).toEqual([
      "skipped",
      "performed",
      "performed",
    ]);
    expect(shell.state()).toEqual({
      disk: { "a.md": note("edited"), "b.md": note("b1") },
      log: ["upload b1"],
    });
  });

  it("runs the effects that do not touch the disk in order", async () => {
    const shell = new MemoryShell("posix");
    const journal: Journal = { documents: {}, cursor: 4 };
    const effects: Effect[] = [
      { kind: "read-file", path: "a.md" },
      { kind: "upload", content: "a2" },
      { kind: "commit", doc: "A", outbox },
      { kind: "pull", cursor: 4 },
      { kind: "persist-journal", journal },
      { kind: "report", subject: null, path: "x.md", reason: "unsupported" },
    ];

    const ran = await executeEffects("posix", effects, shell);

    expect(ran.every((entry) => entry.outcome === "performed")).toBe(true);
    expect(shell.log).toEqual([
      "read a.md",
      "upload a2",
      "commit A A#2",
      "pull 4",
      `persist ${JSON.stringify(journal)}`,
      "report null x.md unsupported",
    ]);
  });
});

describe("executeEffects: the compiled core's effects", () => {
  it("persists the journal the core returned for a local event", async () => {
    const device = new CoreDevice("posix", { A: synced("A", "a.md", "a1") });
    device.write("a.md", "a2");
    const answer = device.answers[0];
    if (answer === undefined) throw new Error("no answer");
    const shell = new MemoryShell("posix");

    const ran = await executeEffects("posix", answer.effects, shell);

    expect(ran).toEqual(
      answer.effects.map((effect) => ({ effect, outcome: "performed" })),
    );
    expect(shell.log).toEqual([`persist ${JSON.stringify(answer.journal)}`]);
  });

  it("persists nothing when the shell fails before the core's effect", async () => {
    const device = new CoreDevice("posix", { A: synced("A", "a.md", "a1") });
    const answer = device.scan();
    const shell = new MemoryShell("posix", {}, 0);

    const run = executeEffects("posix", answer.effects, shell);

    await expect(run).rejects.toBeInstanceOf(EffectsInterrupted);
    expect(shell.log).toEqual([]);
  });
});

describe("executeEffects: a failure between effects", () => {
  // One step's effects, as a sync round would return them: every kind, a
  // precondition that depends on an earlier effect, and one that fails.
  const journal: Journal = { documents: {}, cursor: 9 };
  const effects: Effect[] = [
    { kind: "pull", cursor: 8 },
    write("x.md", "x1", null, null),
    move("x.md", "y.md", "x1"),
    write("y.md", "y2", "x1"),
    remove("gone.md", "g1"),
    { kind: "read-file", path: "y.md" },
    { kind: "upload", content: "a2" },
    { kind: "commit", doc: "A", outbox },
    remove("a.md", "a1"),
    { kind: "persist-journal", journal },
    { kind: "report", subject: "A", path: "y.md", reason: "conflict" },
  ];
  const start = { "a.md": note("a1"), "b.md": note("b1") };
  const persisted = `persist ${JSON.stringify(journal)}`;
  // The state after the first n effects, written out by hand.
  const after: { disk: Record<string, DiskFile>; log: string[] }[] = [
    { disk: start, log: [] },
    { disk: start, log: ["pull 8"] },
    { disk: { ...start, "x.md": note("x1") }, log: ["pull 8"] },
    { disk: { ...start, "y.md": note("x1") }, log: ["pull 8"] },
    { disk: { ...start, "y.md": note("y2") }, log: ["pull 8"] },
    { disk: { ...start, "y.md": note("y2") }, log: ["pull 8"] },
    { disk: { ...start, "y.md": note("y2") }, log: ["pull 8", "read y.md"] },
    {
      disk: { ...start, "y.md": note("y2") },
      log: ["pull 8", "read y.md", "upload a2"],
    },
    {
      disk: { ...start, "y.md": note("y2") },
      log: ["pull 8", "read y.md", "upload a2", "commit A A#2"],
    },
    {
      disk: { "b.md": note("b1"), "y.md": note("y2") },
      log: ["pull 8", "read y.md", "upload a2", "commit A A#2"],
    },
    {
      disk: { "b.md": note("b1"), "y.md": note("y2") },
      log: ["pull 8", "read y.md", "upload a2", "commit A A#2", persisted],
    },
    {
      disk: { "b.md": note("b1"), "y.md": note("y2") },
      log: [
        "pull 8",
        "read y.md",
        "upload a2",
        "commit A A#2",
        persisted,
        "report A y.md conflict",
      ],
    },
  ];

  async function runFailingAt(failAt: number) {
    const shell = new MemoryShell("posix", start, failAt);
    let ran: readonly Ran[];
    let interrupted = false;
    try {
      ran = await executeEffects("posix", effects, shell);
    } catch (error) {
      if (!(error instanceof EffectsInterrupted)) throw error;
      expect(error.cause).toBeInstanceOf(Crash);
      ran = error.ran;
      interrupted = true;
    }
    return { shell, ran, interrupted };
  }

  it("leaves a prefix of the returned effects run, whichever shell call fails", async () => {
    const clean = await runFailingAt(Number.POSITIVE_INFINITY);
    expect(clean.shell.state()).toEqual(after[effects.length]);
    const calls = clean.shell.callCount;

    const prefixes = new Set<number>();
    for (let failAt = 0; failAt <= calls; failAt++) {
      const { shell, ran, interrupted } = await runFailingAt(failAt);
      expect(interrupted).toBe(failAt < calls);
      expect(ran.map((entry) => entry.effect)).toEqual(
        effects.slice(0, ran.length),
      );
      // The shell did exactly what the prefix does, and nothing more.
      expect(shell.state()).toEqual(after[ran.length]);
      // Nothing was started after the failure.
      expect(shell.callCount).toBe(Math.min(failAt + 1, calls));
      prefixes.add(ran.length);
    }
    // A failure was injected between every pair of effects.
    expect([...prefixes].sort((a, b) => a - b)).toEqual(
      Array.from({ length: effects.length + 1 }, (_, index) => index),
    );
  });
});
