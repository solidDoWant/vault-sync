import { describe, expect, it } from "vitest";

import { ActivityLog, defaultActivityCapacity, type ActivityEntry, type ActivityKind } from "./activity-log";

describe("activity log", () => {
  it("lists entries newest first", () => {
    const log = new ActivityLog();
    log.add({ kind: "uploaded", path: "a.md", time: 1 });
    log.add({ kind: "downloaded", path: "b.md", time: 2 });
    log.add({ kind: "conflict", path: "c.md", time: 3 });
    expect(log.entries().map((entry) => entry.path)).toEqual(["c.md", "b.md", "a.md"]);
  });

  it("keeps the order entries were added in, even with equal times", () => {
    const log = new ActivityLog();
    log.add({ kind: "uploaded", path: "first.md", time: 5 });
    log.add({ kind: "uploaded", path: "second.md", time: 5 });
    expect(log.entries().map((entry) => entry.path)).toEqual(["second.md", "first.md"]);
  });

  it("holds exactly its capacity", () => {
    const log = new ActivityLog(3);
    for (const time of [1, 2, 3]) log.add({ kind: "uploaded", path: `${String(time)}.md`, time });
    expect(log.size).toBe(3);
    expect(log.entries().map((entry) => entry.time)).toEqual([3, 2, 1]);
  });

  it("drops the oldest entry once one more than its capacity is added", () => {
    const log = new ActivityLog(3);
    for (const time of [1, 2, 3, 4]) log.add({ kind: "uploaded", path: `${String(time)}.md`, time });
    expect(log.size).toBe(3);
    expect(log.entries().map((entry) => entry.time)).toEqual([4, 3, 2]);
  });

  it("stays bounded by its default capacity", () => {
    const log = new ActivityLog();
    for (let time = 0; time < 2000; time++) log.add({ kind: "downloaded", path: "note.md", time });
    expect(log.size).toBe(500);
    expect(defaultActivityCapacity).toBe(500);
    expect(log.entries()[0]?.time).toBe(1999);
    expect(log.entries().at(-1)?.time).toBe(1500);
  });

  it("refuses a capacity below one", () => {
    expect(() => new ActivityLog(0)).toThrow(RangeError);
  });

  it("keeps each kind of event with its file name and time", () => {
    const log = new ActivityLog();
    const added: ActivityEntry[] = [
      { kind: "uploaded", path: "up.md", folder: false, time: 1 },
      { kind: "downloaded", path: "down", folder: true, time: 2 },
      { kind: "deleted-on-server", path: "gone-there.md", time: 3 },
      { kind: "deleted-here", path: "gone-here.md", time: 4 },
      { kind: "conflict", path: "note (conflict).md", time: 5 },
      { kind: "connection-problem", time: 6 },
    ];
    for (const entry of added) log.add(entry);
    expect(log.entries()).toEqual([...added].reverse());
    const kinds: ActivityKind[] = log.entries().map((entry) => entry.kind);
    expect(new Set(kinds).size).toBe(6);
  });

  it("hands out copies, so a reader cannot change the log", () => {
    const log = new ActivityLog();
    log.add({ kind: "uploaded", path: "a.md", time: 1 });
    const [entry] = log.entries();
    if (entry !== undefined) entry.path = "changed.md";
    expect(log.entries()[0]?.path).toBe("a.md");
  });
});
