// Event capture and round inputs of the shell around the verified core
// (#1043; docs/design/verified-core.md §2.3, §3.4). The shell's inputs are
// handed to the compiled core (`onLocal`, `onScan`) so that what a stale event
// would do to a binding is the core's own answer.
import { describe, expect, it } from "vitest";

import { filesystemKey, type PathPlatform } from "../core/vaultpath/platform";
import {
  type CoreInput,
  EventCapture,
  freshDocsNeeded,
  type VaultReader,
} from "./capture";
import {
  type DiskFile,
  type Journal,
  type LocalEvent,
  type Read,
  onLocal,
  onScan,
  synced,
} from "./local-core";

/** An in-memory vault whose listing and reads can run a user's change first. */
class FakeVault implements VaultReader {
  readonly disk = new Map<string, DiskFile>();
  readonly editing = new Set<string>();
  readonly outOfScope = new Set<string>();
  /** Runs once before the next listing is returned. */
  beforeList: (() => void) | null = null;
  /** Runs once after the next read of a path, before it is returned. */
  afterRead: { path: string; run: () => void } | null = null;
  capture: EventCapture | null = null;

  constructor(readonly platform: PathPlatform) {}

  list(): Promise<readonly string[]> {
    const hook = this.beforeList;
    this.beforeList = null;
    hook?.();
    return Promise.resolve([...this.disk.keys()]);
  }

  read(path: string): Promise<Read> {
    const spelling = this.spellingOf(path);
    const read =
      spelling === undefined ? null : (this.disk.get(spelling) ?? null);
    const hook = this.afterRead;
    if (hook !== null && hook.path === path) {
      this.afterRead = null;
      hook.run();
    }
    return Promise.resolve(read === null ? null : { ...read });
  }

  unsaved(): Promise<readonly string[]> {
    return Promise.resolve([...this.editing]);
  }

  inScope(path: string): boolean {
    return !this.outOfScope.has(path);
  }

  private spellingOf(path: string): string | undefined {
    const key = filesystemKey(path, this.platform);
    return [...this.disk.keys()].find(
      (spelling) => filesystemKey(spelling, this.platform) === key,
    );
  }

  /** The vault reports `event`. */
  report(event: LocalEvent): void {
    this.capture?.onEvent(event);
  }

  /** The user writes a file; the vault reports it. */
  write(path: string, content: string): void {
    const spelling = this.spellingOf(path);
    this.disk.set(spelling ?? path, { content, kind: "note" });
    this.report({
      kind: spelling === undefined ? "created" : "modified",
      path,
    });
  }

  /** The user deletes a file; the vault reports it. */
  delete(path: string): void {
    const spelling = this.spellingOf(path);
    if (spelling === undefined) throw new Error(`no file at ${path}`);
    this.disk.delete(spelling);
    this.report({ kind: "deleted", path });
  }

  /** The user renames a file onto a free name; the vault reports it. */
  rename(from: string, to: string): void {
    const spelling = this.spellingOf(from);
    const file = spelling === undefined ? undefined : this.disk.get(spelling);
    if (spelling === undefined || file === undefined)
      throw new Error(`no file at ${from}`);
    this.disk.delete(spelling);
    this.disk.set(to, file);
    this.report({ kind: "renamed", from, to });
  }
}

/** A device: the fake vault, the capture, and the compiled core's journal. */
function device(
  platform: PathPlatform,
  documents: Journal["documents"] = {},
): {
  vault: FakeVault;
  capture: EventCapture;
  inputs: CoreInput[];
  journal: () => Journal;
} {
  const vault = new FakeVault(platform);
  let journal: Journal = { documents: structuredClone(documents), cursor: 0 };
  for (const document of Object.values(documents))
    if (document.binding !== null)
      vault.disk.set(document.binding.spelling, {
        content: document.binding.seen,
        kind: "note",
      });
  const inputs: CoreInput[] = [];
  let step = 0;
  const capture = new EventCapture(vault, (input) => {
    inputs.push(input);
    step++;
    const revs = Object.fromEntries(
      Object.keys(journal.documents).map((id) => [id, `${id}#${String(step)}`]),
    );
    journal = (
      input.kind === "scan"
        ? onScan(platform, journal, input.listing, revs)
        : onLocal(platform, journal, input.event, input.reads, revs)
    ).journal;
  });
  vault.capture = capture;
  return { vault, capture, inputs, journal: () => journal };
}

const binding = (journal: Journal, id: string): string | null =>
  journal.documents[id]?.binding?.spelling ?? null;

describe("local event reads", () => {
  it("hands the core a local event with the read of the path it names, under the file key", async () => {
    const { vault, capture, inputs } = device("windows");
    vault.disk.set("Notes/A.md", { content: "a", kind: "note" });
    capture.onEvent({ kind: "modified", path: "notes/a.md" });
    await capture.idle();
    expect(inputs).toEqual([
      {
        kind: "local",
        event: { kind: "modified", path: "notes/a.md" },
        reads: { "notes/a.md": { content: "a", kind: "note" } },
      },
    ]);
  });

  it("hands the core a rename with the reads of both its names", async () => {
    const { vault, capture, inputs } = device("posix");
    vault.disk.set("a.md", { content: "a", kind: "note" });
    vault.rename("a.md", "b.md");
    await capture.idle();
    expect(inputs).toEqual([
      {
        kind: "local",
        event: { kind: "renamed", from: "a.md", to: "b.md" },
        reads: { "a.md": null, "b.md": { content: "a", kind: "note" } },
      },
    ]);
  });

  it("hands over events outside a scan even when the disk reads as before", async () => {
    const { vault, capture, inputs } = device("posix");
    vault.disk.set("a.md", { content: "a", kind: "note" });
    await capture.scan();
    vault.write("a.md", "a");
    await capture.idle();
    expect(inputs.map((input) => input.kind)).toEqual(["scan", "local"]);
  });
});

describe("start-up scan", () => {
  it("hands the core the listing with every file's content and kind", async () => {
    const { vault, capture, inputs } = device("posix");
    vault.disk.set("a.md", { content: "a", kind: "note" });
    vault.disk.set("p.png", { content: "p", kind: "binary" });
    await capture.scan();
    expect(inputs).toEqual([
      {
        kind: "scan",
        listing: new Map([
          ["a.md", { content: "a", kind: "note" }],
          ["p.png", { content: "p", kind: "binary" }],
        ]),
      },
    ]);
  });

  it("drops a rename the listing already shows, and the document keeps its file (#979)", async () => {
    // The user renames a.md while the scan lists the disk, before the
    // listing: the scan matches a.md → b.md, and the rename's own event
    // arrives after.
    const { vault, capture, inputs, journal } = device("posix", {
      x: synced("x", "a.md", "A"),
    });
    vault.beforeList = () => {
      vault.rename("a.md", "b.md");
    };
    await capture.scan();
    expect(inputs.map((input) => input.kind)).toEqual(["scan"]);
    expect(binding(journal(), "x")).toBe("b.md");
  });

  it("drops a delete and a create the listing already shows", async () => {
    const { vault, capture, inputs } = device("posix", {
      x: synced("x", "a.md", "A"),
    });
    vault.beforeList = () => {
      vault.delete("a.md");
      vault.write("c.md", "C");
    };
    await capture.scan();
    expect(inputs.map((input) => input.kind)).toEqual(["scan"]);
  });

  it("hands over, after the scan, a rename made after the listing read the file", async () => {
    const { vault, capture, inputs, journal } = device("posix", {
      x: synced("x", "a.md", "A"),
    });
    vault.afterRead = {
      path: "a.md",
      run: () => {
        vault.rename("a.md", "b.md");
      },
    };
    await capture.scan();
    expect(inputs).toEqual([
      {
        kind: "scan",
        listing: new Map([["a.md", { content: "A", kind: "note" }]]),
      },
      {
        kind: "local",
        event: { kind: "renamed", from: "a.md", to: "b.md" },
        reads: { "a.md": null, "b.md": { content: "A", kind: "note" } },
      },
    ]);
    expect(binding(journal(), "x")).toBe("b.md");
  });

  it("hands over, after the scan, an edit made after the listing read the file", async () => {
    const { vault, capture, inputs } = device("posix", {
      x: synced("x", "a.md", "A"),
    });
    vault.afterRead = {
      path: "a.md",
      run: () => {
        vault.write("a.md", "A2");
      },
    };
    await capture.scan();
    expect(inputs.at(-1)).toEqual({
      kind: "local",
      event: { kind: "modified", path: "a.md" },
      reads: { "a.md": { content: "A2", kind: "note" } },
    });
  });

  it("compares a stale event's names with the listing under the file key", async () => {
    const { vault, capture, inputs, journal } = device("windows", {
      x: synced("x", "a.md", "A"),
    });
    vault.beforeList = () => {
      // The vault spells the names otherwise than the disk does.
      vault.disk.delete("a.md");
      vault.disk.set("B.md", { content: "A", kind: "note" });
      vault.report({ kind: "renamed", from: "A.md", to: "b.md" });
    };
    await capture.scan();
    expect(inputs.map((input) => input.kind)).toEqual(["scan"]);
    expect(binding(journal(), "x")).toBe("B.md");
  });

  it("refuses a listing in which two names are one file", async () => {
    const { vault, capture } = device("windows");
    vault.disk.set("a.md", { content: "a", kind: "note" });
    vault.disk.set("A.md", { content: "b", kind: "note" });
    await expect(capture.scan()).rejects.toThrow(/one file/);
  });
});

describe("round input", () => {
  it("holds the listing, the unsaved paths and the out-of-scope paths the round names", async () => {
    const { vault, capture } = device("posix");
    vault.disk.set("a.md", { content: "a", kind: "note" });
    vault.disk.set(".obsidian/app.json", { content: "{}", kind: "note" });
    vault.editing.add("a.md");
    vault.outOfScope.add(".obsidian/app.json");
    vault.outOfScope.add(".obsidian/hotkeys.json");
    const input = await capture.roundInput({ documents: {} }, [
      { path: ".obsidian/hotkeys.json" },
      { path: "b.md" },
    ]);
    expect(input.listing).toEqual(
      new Map([
        ["a.md", { content: "a", kind: "note" }],
        [".obsidian/app.json", { content: "{}", kind: "note" }],
      ]),
    );
    expect(input.unsaved).toEqual(new Set(["a.md"]));
    expect(input.outOfScope).toEqual(
      new Set([".obsidian/app.json", ".obsidian/hotkeys.json"]),
    );
  });

  it("reads the listing after every event handed over before it", async () => {
    const { vault, capture, inputs } = device("posix");
    vault.write("a.md", "a");
    const input = await capture.roundInput({ documents: {} }, []);
    expect(inputs).toHaveLength(1);
    expect([...input.listing.keys()]).toEqual(["a.md"]);
  });

  it("carries 2·|listing| + |documents| + pulled distinct fresh ids, none the journal's (FreshDocsSuffice)", async () => {
    const { vault, capture } = device("posix");
    vault.disk.set("a.md", { content: "a", kind: "note" });
    vault.disk.set("b.md", { content: "b", kind: "note" });
    vault.disk.set("c.md", { content: "c", kind: "note" });
    const documents = {
      x: synced("x", "a.md", "a"),
      y: synced("y", "gone.md", "g"),
    };
    const input = await capture.roundInput({ documents }, [
      { path: "d.md" },
      { path: "e.md" },
      { path: "f.md" },
      { path: "g.md" },
    ]);
    // 2·3 listed files + 2 documents + 4 pulled revisions.
    expect(input.freshDocs).toHaveLength(12);
    expect(new Set(input.freshDocs).size).toBe(12);
    for (const id of input.freshDocs) expect(["x", "y"]).not.toContain(id);
  });

  it("states the fresh-id bound of FreshDocsSuffice", () => {
    expect(freshDocsNeeded(0, 0, 0)).toBe(0);
    expect(freshDocsNeeded(1, 0, 0)).toBe(2);
    expect(freshDocsNeeded(0, 1, 0)).toBe(1);
    expect(freshDocsNeeded(0, 0, 1)).toBe(1);
  });

  it("refuses a fresh id the journal already uses", async () => {
    // No file is listed, so the round needs one id, for the one document.
    const vault = new FakeVault("posix");
    const capture = new EventCapture(
      vault,
      () => undefined,
      () => "x",
    );
    await expect(
      capture.roundInput({ documents: { x: synced("x", "a.md", "a") } }, []),
    ).rejects.toThrow(/not fresh/);
  });

  it("refuses an id handed out twice in one round", async () => {
    const vault = new FakeVault("posix");
    vault.disk.set("a.md", { content: "a", kind: "note" });
    const capture = new EventCapture(
      vault,
      () => undefined,
      () => "same",
    );
    await expect(capture.roundInput({ documents: {} }, [])).rejects.toThrow(
      /not fresh/,
    );
  });
});
