import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { conflictCopyName, maxPartBytes, maxPathBytes } from "./conflict-name";
import { Device } from "./testing";

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).length;

function setup(): { server: InMemoryServer; a: Device; b: Device; tick: () => void } {
  let clock = Date.UTC(2026, 9, 29, 12, 0);
  const server = new InMemoryServer({ now: () => new Date(clock) });
  const device = (id: string, userName: string) => new Device(server, id, { now: () => clock, userName }, { now: () => clock });
  return {
    server,
    a: device("device-a", "Alice"),
    b: device("device-b", "Bob"),
    tick: () => {
      clock += 60_000;
    },
  };
}

/** A and B both hold `path` with `content`. */
async function shared(a: Device, b: Device, path: string, content: string): Promise<void> {
  await a.write(path, content);
  await a.sync();
  await b.sync();
}

/** Syncs A then B until both have met each other's changes. */
async function converge(a: Device, b: Device): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await a.sync();
    await b.sync();
  }
}

function commitCalls(server: InMemoryServer): { count: number } {
  const calls = { count: 0 };
  server.interceptor = (method) => {
    if (method === "CommitRevision") calls.count++;
  };
  return calls;
}

describe("rule M: content merge", () => {
  it("text equal after normalizing line endings and the trailing newline takes the remote version, with no copy", async () => {
    const { server, a, b } = setup();
    await shared(a, b, "a.md", "one\ntwo\n");
    await a.write("a.md", "one\ntwo\nthree\n");
    await a.sync();
    await b.write("a.md", "one\r\ntwo\r\nthree");
    const revisions = server.revisionCount;
    await b.sync();
    expect(await b.files()).toEqual({ "a.md": "one\ntwo\nthree\n" });
    expect(server.revisionCount).toBe(revisions);
    expect((await b.journal.load()).pending).toEqual([]);
  });

  it("text whose merge base was pruned keeps the remote version at the path and the local one as a copy", async () => {
    const { server, a, b } = setup();
    await shared(a, b, "a.md", "one\n");
    const base = server.head([...(await a.journal.load()).docs.keys()][0] ?? "");
    await a.write("a.md", "one, remote\n");
    await a.sync();
    if (base !== undefined) server.purge(base.id);
    await b.write("a.md", "one, local\n");
    await b.sync();
    await a.sync();
    expect(await b.files()).toEqual({ "a.md": "one, remote\n", "a (Conflicted copy Bob device-b 202610291200).md": "one, local\n" });
    expect(await a.files()).toEqual(await b.files());
  });

  it("text whose merge base was pruned and that is unchanged here takes the remote version", async () => {
    const { server, a, b } = setup();
    await shared(a, b, "a.md", "one\n");
    const base = server.head([...(await a.journal.load()).docs.keys()][0] ?? "");
    await a.write("a.md", "one, remote\n");
    await a.sync();
    if (base !== undefined) server.purge(base.id);
    await b.vault.rename("a.md", "b.md");
    await b.sync();
    expect(await b.files()).toEqual({ "b.md": "one, remote\n" });
  });

  it("blob edits at the same time: the remote version wins at the path, and the local one is the copy", async () => {
    const { a, b } = setup();
    await shared(a, b, "a.png", "base");
    await a.write("a.png", "remote");
    await a.sync();
    await b.write("a.png", "local");
    await b.sync();
    expect(await b.files()).toEqual({ "a.png": "remote", "a (Conflicted copy Bob device-b 202610291200).png": "local" });
  });
});

const basesBase = "views:\n  - type: table\n    name: Books\n    limit: 10\n  - type: cards\n    name: Gallery\n";

describe("rule M: Bases (.base) files", () => {
  it("edits to different views on two devices merge into one file with no conflict copy", async () => {
    const { a, b } = setup();
    await shared(a, b, "Library.base", basesBase);
    await a.write("Library.base", "views:\n  - type: table\n    name: Books\n    limit: 200\n  - type: cards\n    name: Gallery\n");
    await a.sync();
    await b.write("Library.base", "views:\n  - type: table\n    name: Books\n    limit: 10\n  - type: cards\n    name: Gallery\n    order:\n      - file.name\n");
    await converge(a, b);
    const merged = "views:\n  - type: table\n    name: Books\n    limit: 200\n  - type: cards\n    name: Gallery\n    order:\n      - file.name\n";
    expect(await b.files()).toEqual({ "Library.base": merged });
    expect(await a.files()).toEqual(await b.files());
  });

  it("both devices changing one view's limit differently fall back to the blob rule's conflict copy", async () => {
    const { a, b } = setup();
    await shared(a, b, "Library.base", basesBase);
    const remote = basesBase.replace("limit: 10", "limit: 200");
    const local = basesBase.replace("limit: 10", "limit: 3000");
    await a.write("Library.base", remote);
    await a.sync();
    await b.write("Library.base", local);
    await b.sync();
    expect(await b.files()).toEqual({ "Library.base": remote, "Library (Conflicted copy Bob device-b 202610291200).base": local });
  });
});

const canvasBase = '{"nodes":[{"id":"a","type":"text","text":"A","x":0,"y":0,"width":250,"height":60},{"id":"b","type":"text","text":"B","x":0,"y":100,"width":250,"height":60}],"edges":[]}';

describe("rule M: other merged types", () => {
  it("canvas edits on two devices (one moves a node, the other recolours it) merge with no conflict copy", async () => {
    const { a, b } = setup();
    await shared(a, b, "Board.canvas", canvasBase);
    await a.write("Board.canvas", canvasBase.replace('"x":0,"y":0', '"x":40,"y":0'));
    await a.sync();
    await b.write("Board.canvas", canvasBase.replace('"text":"A",', '"text":"A","color":"4",'));
    await converge(a, b);
    const merged = canvasBase.replace('"text":"A","x":0,"y":0', '"text":"A","x":40,"y":0,"color":"4"');
    expect(JSON.parse((await b.files())["Board.canvas"] ?? "")).toEqual(JSON.parse(merged));
    expect(Object.keys(await b.files())).toEqual(["Board.canvas"]);
    expect(await a.files()).toEqual(await b.files());
  });

  it("both devices moving the same canvas node fall back to the blob rule's conflict copy", async () => {
    const { a, b } = setup();
    await shared(a, b, "Board.canvas", canvasBase);
    const remote = canvasBase.replace('"x":0,"y":0', '"x":40,"y":0');
    const local = canvasBase.replace('"x":0,"y":0', '"x":90,"y":0');
    await a.write("Board.canvas", remote);
    await a.sync();
    await b.write("Board.canvas", local);
    await b.sync();
    expect(await b.files()).toEqual({ "Board.canvas": remote, "Board (Conflicted copy Bob device-b 202610291200).canvas": local });
  });

  it("CSV edits to different rows on two devices merge with no conflict copy", async () => {
    const { a, b } = setup();
    const csv = "id,qty\n1,3\n2,5\n3,7\n";
    await shared(a, b, "Stock.csv", csv);
    await a.write("Stock.csv", csv.replace("1,3", "1,40"));
    await a.sync();
    await b.write("Stock.csv", csv.replace("3,7", "3,800"));
    await converge(a, b);
    expect(await b.files()).toEqual({ "Stock.csv": "id,qty\n1,40\n2,5\n3,800\n" });
    expect(await a.files()).toEqual(await b.files());
  });

  it("an overlapping CSV edit falls back to the blob rule's conflict copy", async () => {
    const { a, b } = setup();
    const csv = "id,qty\n1,3\n2,5\n3,7\n";
    await shared(a, b, "Stock.csv", csv);
    await a.write("Stock.csv", csv.replace("2,5", "2,60"));
    await a.sync();
    await b.write("Stock.csv", csv.replace("2,5", "2,900"));
    await b.sync();
    expect(await b.files()).toEqual({ "Stock.csv": csv.replace("2,5", "2,60"), "Stock (Conflicted copy Bob device-b 202610291200).csv": csv.replace("2,5", "2,900") });
  });
});

describe("rule C: conflict copy names", () => {
  const date = new Date(Date.UTC(2026, 9, 29, 7, 5));
  const free = () => false;

  it("names the copy after the file, the local user, the device and the minute, in the same folder", () => {
    expect(conflictCopyName("notes/plan.md", "Alice", "Laptop", date, free)).toBe("notes/plan (Conflicted copy Alice Laptop 202610290705).md");
    expect(conflictCopyName("README", "Alice", "Laptop", date, free)).toBe("README (Conflicted copy Alice Laptop 202610290705)");
  });

  it("reduces the user name to portable characters, and names an unnamed user \"user\"", () => {
    expect(conflictCopyName("plan.md", "Ann: R/D (ops)", "Laptop", date, free)).toBe("plan (Conflicted copy Ann- R-D -ops- Laptop 202610290705).md");
    expect(conflictCopyName("plan.md", " ", "Laptop", date, free)).toBe("plan (Conflicted copy user Laptop 202610290705).md");
  });

  it("appends 2, 3 and so on while the name is taken", () => {
    const taken = new Set(["plan (Conflicted copy Alice Laptop 202610290705).md", "plan (Conflicted copy Alice Laptop 202610290705) 2.md"]);
    expect(conflictCopyName("plan.md", "Alice", "Laptop", date, (path) => taken.has(path))).toBe("plan (Conflicted copy Alice Laptop 202610290705) 3.md");
  });

  it("shortens the name to fit a 255-byte part, and keeps one that fits exactly", () => {
    const suffix = " (Conflicted copy Alice Laptop 202610290705).md";
    const fits = "x".repeat(maxPartBytes - suffix.length);
    expect(conflictCopyName(`${fits}.md`, "Alice", "Laptop", date, free)).toBe(`${fits}${suffix}`);
    const copy = conflictCopyName(`${fits}y.md`, "Alice", "Laptop", date, free);
    expect(copy).toBe(`${fits}${suffix}`);
  });

  it("shortens the name to fit a 1024-byte path", () => {
    const folder = `${"f".repeat(200)}/`.repeat(4);
    const copy = conflictCopyName(`${folder}${"n".repeat(200)}.md`, "Alice", "Laptop", date, free);
    expect(copy).not.toBeNull();
    expect(utf8Length(copy ?? "")).toBeLessThanOrEqual(maxPathBytes);
    expect(copy?.startsWith(`${folder}n`)).toBe(true);
    expect(copy?.endsWith(" (Conflicted copy Alice Laptop 202610290705).md")).toBe(true);
  });
});

describe("push rules", () => {
  it("P1: a commit refused because the head moved is resolved against the head in the same sync", async () => {
    const { server, a, b, tick } = setup();
    await shared(a, b, "a.md", "one\ntwo\nthree\n");
    // A new mtime: the engine is not watching, and the edit keeps the size.
    tick();
    await b.write("a.md", "one\ntwo\nTHREE\n");
    const documentId = [...(await b.journal.load()).docs.keys()][0] ?? "";
    // B's pull sees nothing new, then A commits before B's push.
    let injected = false;
    server.interceptor = (method) => {
      if (method !== "CommitRevision" || injected) return;
      injected = true;
      server.commit({ documentId, path: "a.md", content: "ONE\ntwo\nthree\n", deviceId: "device-a" });
    };
    await b.sync();
    expect(server.liveFiles()).toEqual(new Map([["a.md", "ONE\ntwo\nTHREE\n"]]));
    expect((await b.journal.load()).pending).toEqual([]);
  });

  it("P2: a create refused because another document took the path binds to it when the content is the same", async () => {
    const { server, b } = setup();
    await b.write("a.md", "same");
    let injected = false;
    server.interceptor = (method) => {
      if (method !== "CommitRevision" || injected) return;
      injected = true;
      server.commit({ documentId: "doc-other", path: "a.md", content: "same", deviceId: "device-a" });
    };
    await b.sync();
    expect(await b.files()).toEqual({ "a.md": "same" });
    expect(server.liveFiles()).toEqual(new Map([["a.md", "same"]]));
    const state = await b.journal.load();
    expect(state.pending).toEqual([]);
    expect([...state.docs.keys()]).toEqual(["doc-other"]);
  });

  it("P2: a create refused because another document took the path with other content is pushed as a conflict copy", async () => {
    const { server, b } = setup();
    await b.write("a.md", "local");
    let injected = false;
    server.interceptor = (method) => {
      if (method !== "CommitRevision" || injected) return;
      injected = true;
      server.commit({ documentId: "doc-other", path: "a.md", content: "remote", deviceId: "device-a" });
    };
    await b.sync();
    const copy = "a (Conflicted copy Bob device-b 202610291200).md";
    expect(await b.files()).toEqual({ "a.md": "remote", [copy]: "local" });
    expect(server.liveFiles()).toEqual(new Map([["a.md", "remote"], [copy, "local"]]));
    expect((await b.journal.load()).conflicts.has(copy)).toBe(true);
  });

  it("W: a create whose commit landed with the reply lost, then moved to a conflict copy, is acknowledged and the pull goes on", async () => {
    const { server, b } = setup();
    await b.write("a.md", "B's note\n");
    // Between B's pull and its push, another document takes a.md and moves on to c.md.
    let injected = false;
    server.interceptor = (method) => {
      if (method !== "CommitRevision" || injected) return;
      injected = true;
      server.commit({ documentId: "doc-other", path: "a.md", content: "A's note\n", deviceId: "device-a" });
      server.commit({ documentId: "doc-other", path: "c.md", deviceId: "device-a" });
    };
    // B's create of a.md is committed, but the reply is lost.
    let lost = false;
    server.responseInterceptor = (method) => {
      if (method !== "CommitRevision" || lost) return;
      lost = true;
      throw new ConnectError("connection reset", Code.Unavailable);
    };
    await expect(b.sync()).rejects.toThrow("connection reset");
    server.interceptor = undefined;
    server.responseInterceptor = undefined;
    await b.sync();
    server.commit({ documentId: "doc-other", path: "c.md", content: "A's note, edited\n", deviceId: "device-a" });
    await b.sync();
    const copy = "a (Conflicted copy Bob device-b 202610291200).md";
    expect(await b.files()).toEqual({ "c.md": "A's note, edited\n", [copy]: "B's note\n" });
    expect(server.liveFiles()).toEqual(new Map([["c.md", "A's note, edited\n"], [copy, "B's note\n"]]));
    const state = await b.journal.load();
    expect(state.cursor.seq).toBe(server.currentHeadSeq);
    expect(state.pending).toEqual([]);
  });

  it("P2: a name that differs from a document this device holds only by case is refused with a reason until it is renamed", async () => {
    const { server, a, b } = setup();
    await shared(a, b, "Note.md", "one");
    await b.write("note.md", "two");
    await b.sync();
    expect(await b.engine.refusedNames()).toEqual([expect.objectContaining({ path: "note.md", reason: expect.stringContaining("another live document") as unknown })]);
    const calls = commitCalls(server);
    await b.sync();
    expect(calls.count).toBe(0);
    await b.vault.rename("note.md", "other.md");
    await b.sync();
    expect(server.liveFiles()).toEqual(new Map([["Note.md", "one"], ["other.md", "two"]]));
    expect(await b.engine.refusedNames()).toEqual([]);
  });

  describe("P2: a name this device vacated with a rename the server refused first (P1)", () => {
    /** A and B both hold x.md and y.md, with their engines watching the vault. */
    async function started(): Promise<{ server: InMemoryServer; a: Device; b: Device }> {
      const { server, a, b } = setup();
      await a.engine.start();
      await b.engine.start();
      await a.write("x.md", "note x\n");
      await a.write("y.md", "note y\n");
      await converge(a, b);
      return { server, a, b };
    }

    it("a rename onto the name is pushed once the vacating rename lands", async () => {
      const { server, a, b } = await started();
      await b.vault.rename("x.md", "z.md");
      await b.vault.rename("y.md", "x.md");
      await a.write("x.md", "note x\nedited on A\n");
      await a.sync();
      await converge(a, b);
      const expected = { "x.md": "note y\n", "z.md": "note x\nedited on A\n" };
      expect(await b.files()).toEqual(expected);
      expect(await a.files()).toEqual(expected);
      expect(server.liveFiles()).toEqual(new Map(Object.entries(expected)));
      expect(await b.engine.refusedNames()).toEqual([]);
      expect((await b.journal.load()).pending).toEqual([]);
    });

    it("a new note at the name reaches the server and the other device", async () => {
      const { server, a, b } = await started();
      await b.vault.rename("x.md", "z.md");
      await b.write("x.md", "new note\n");
      await a.write("x.md", "note x\nedited on A\n");
      await a.sync();
      await converge(a, b);
      const expected = { "x.md": "new note\n", "y.md": "note y\n", "z.md": "note x\nedited on A\n" };
      expect(await b.files()).toEqual(expected);
      expect(await a.files()).toEqual(expected);
      expect(server.liveFiles()).toEqual(new Map(Object.entries(expected)));
      expect(await b.engine.refusedNames()).toEqual([]);
      expect((await b.journal.load()).pending).toEqual([]);
    });
  });

  it("P3: an unportable name is refused with a reason, left untouched and not retried until it is renamed", async () => {
    const { server, b } = setup();
    await b.write("a\\b.md", "content");
    await b.write("ok.md", "fine");
    await b.sync();
    expect(await b.files()).toEqual({ "a\\b.md": "content", "ok.md": "fine" });
    expect(server.liveFiles()).toEqual(new Map([["ok.md", "fine"]]));
    expect(await b.engine.refusedNames()).toEqual([expect.objectContaining({ path: "a\\b.md", reason: expect.any(String) as unknown })]);
    const calls = commitCalls(server);
    await b.write("a\\b.md", "edited");
    await b.sync();
    expect(calls.count).toBe(0);
    await b.vault.rename("a\\b.md", "a-b.md");
    await b.sync();
    expect(server.liveFiles()).toEqual(new Map([["ok.md", "fine"], ["a-b.md", "edited"]]));
  });
});
