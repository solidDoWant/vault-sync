import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { FeedRevision } from "./invariants";
import { copiedFrom, pathMatcher } from "./invariants";
import { checkLineage, type LineageEntry } from "./lineage";

const copy = "b (conflict e1 2026-01-02 030405).md";

/** A timeline under construction: each entry at the server head seq given. */
class Timeline {
  readonly entries: LineageEntry[] = [];

  user(type: "create" | "modify" | "delete", path: string, inode: string, seq: bigint, hash?: string): this {
    return this.change({ type, path, inode, actor: "user", serverSeq: seq, ...(hash === undefined ? {} : { hash }) });
  }
  engine(type: "create" | "modify" | "delete", path: string, inode: string, seq: bigint, hash?: string): this {
    return this.change({ type, path, inode, actor: "engine", serverSeq: seq, ...(hash === undefined ? {} : { hash }) });
  }
  rename(actor: "user" | "engine", from: string, to: string, inode: string, seq: bigint): this {
    return this.change({ type: "rename", path: to, oldPath: from, inode, actor, serverSeq: seq });
  }
  crash(seq: bigint): this {
    this.entries.push({ kind: "crash", serverSeq: seq, step: 0 });
    return this;
  }
  restore(documentId: string, seq: bigint): this {
    this.entries.push({ kind: "restore", documentId, serverSeq: seq, step: 0 });
    return this;
  }
  /** A settled point covering every entry so far. */
  settled(seq: bigint): this {
    this.entries.push({ kind: "settled", since: this.entries.length, serverSeq: seq, step: 0 });
    return this;
  }
  private change(entry: Omit<Extract<LineageEntry, { kind: "change" }>, "kind" | "step">): this {
    this.entries.push({ kind: "change", step: 0, ...entry });
    return this;
  }
}

const revision = (overrides: Partial<FeedRevision>): FeedRevision => ({
  revisionId: `r${String(overrides.seq ?? 1n)}`,
  documentId: "d1",
  seq: 1n,
  path: "a.md",
  deleted: false,
  deviceId: "engine",
  contentHash: "aa",
  size: 1n,
  ...overrides,
});

function check(feed: FeedRevision[], timeline: Timeline, platform: "posix" | "windows" = "posix"): string[] {
  return checkLineage(feed, [{ name: "e1", deviceId: "engine", timeline: timeline.entries, match: pathMatcher(platform), copyOf: (path) => copiedFrom(path, "e1") }], (id) => id).map(
    (violation) => `${violation.invariant}: ${violation.detail}`,
  );
}

/** The user creates a.md (inode 1, content aa), which the engine commits as d1 at seq 1. */
const created = () => new Timeline().user("create", "a.md", "1", 0n, "aa");
const synced = revision({});
const phantom = (seq: bigint) => `phantom-delete: e1 deleted d1 at a.md (seq ${String(seq)}, r${String(seq)}) although its user never deleted a file bound to it`;

describe("phantom-delete on inodes", () => {
  it("accepts a tombstone that follows the user's delete of the document's file", () => {
    expect(check([synced, revision({ seq: 2n, deleted: true })], created().user("delete", "a.md", "1", 1n))).toEqual([]);
  });

  it("reports a tombstone without a delete, or after the user deleted another document's file (#532)", () => {
    expect(check([synced, revision({ seq: 2n, deleted: true })], created())).toEqual([phantom(2n)]);
    const other = created().user("create", "b.md", "2", 0n, "bb").user("delete", "b.md", "2", 2n);
    expect(check([synced, revision({ documentId: "d2", seq: 2n, path: "b.md", contentHash: "bb" }), revision({ seq: 3n, deleted: true })], other)).toEqual([phantom(3n)]);
  });

  it("reports a tombstone after the document came back in another file, when only its earlier file was deleted (#822 item 3)", () => {
    // The user deleted d1's file (the engine's tombstone at seq 2), re-created it in inode 2 (back at seq 3), and the engine deleted d1 again although inode 2 is still there.
    const feed = [synced, revision({ seq: 2n, deleted: true, contentHash: "" }), revision({ seq: 3n, contentHash: "bb" }), revision({ seq: 4n, deleted: true })];
    const recreated = created().user("delete", "a.md", "1", 1n).user("create", "a.md", "2", 2n, "bb");
    expect(check(feed, recreated)).toEqual([phantom(4n)]);
    // Once the user deletes the new file too, the second tombstone is theirs.
    expect(check(feed, recreated.user("delete", "a.md", "2", 3n))).toEqual([]);
  });

  it("reports a tombstone when the deleted file was rebound to another document before it (#822 item 3)", () => {
    // The user deletes d1's file, and the engine commits what it had read from it as d2 (the file is d2's now), then deletes d1.
    const timeline = created().user("delete", "a.md", "1", 1n);
    const feed = [synced, revision({ documentId: "d2", seq: 2n, path: "a.md" }), revision({ seq: 3n, deleted: true })];
    expect(check(feed, timeline).filter((line) => line.startsWith("phantom-delete"))).toEqual([phantom(3n)]);
  });

  it("reports a tombstone the engine committed before the user's delete", () => {
    expect(check([synced, revision({ seq: 2n, deleted: true })], created().user("delete", "a.md", "1", 2n))).toEqual([phantom(2n)]);
  });

  it("keeps a file bound when the engine writes its own document's content where another document once had that content", () => {
    // d1 (inode 5) is the user's moved file at b.md; d2 once had content cc at b.md; the engine writes d1's newest content, also cc, into inode 5.
    const feed = [revision({ deviceId: "scripted", contentHash: "bb" }), revision({ documentId: "d2", seq: 2n, path: "b.md", contentHash: "cc", deviceId: "scripted" }), revision({ seq: 3n, contentHash: "cc", deviceId: "scripted" }), revision({ seq: 4n, path: "b.md", contentHash: "cc" })];
    const timeline = new Timeline().engine("create", "a.md", "5", 1n, "bb").rename("user", "a.md", "b.md", "5", 1n).engine("modify", "b.md", "5", 3n, "cc");
    expect(check(feed, timeline)).toEqual([]);
  });

  it("binds the file the engine wrote from a pulled revision to that revision's document", () => {
    const pulled = revision({ deviceId: "scripted", contentHash: "bb" });
    const timeline = new Timeline().engine("create", "a.md", "5", 1n, "bb").user("delete", "a.md", "5", 1n);
    expect(check([pulled, revision({ seq: 2n, deleted: true })], timeline)).toEqual([]);
    // Not a write of other content there.
    const other = new Timeline().engine("create", "a.md", "5", 1n, "cc").user("delete", "a.md", "5", 1n);
    expect(check([pulled, revision({ seq: 2n, deleted: true })], other)).toEqual([phantom(2n)]);
  });

  it("binds a file the user deleted before the engine committed what it had read from it", () => {
    // The engine read a.md, the user deleted it, the engine committed it as d1 and then its delete.
    const timeline = new Timeline().user("create", "a.md", "1", 0n, "aa").user("delete", "a.md", "1", 0n);
    expect(check([synced, revision({ seq: 2n, deleted: true })], timeline)).toEqual([]);
    // Also when the user wrote other content into the file before deleting it.
    const edited = new Timeline().user("create", "a.md", "1", 0n, "aa").user("modify", "a.md", "1", 0n, "zz").user("delete", "a.md", "1", 0n).user("create", "a.md", "2", 0n, "yy");
    expect(check([synced, revision({ seq: 2n, deleted: true })], edited)).toEqual([]);
    // Not when the deleted file was at another path.
    const elsewhere = new Timeline().user("create", "b.md", "1", 0n, "aa").user("delete", "b.md", "1", 0n);
    expect(check([synced, revision({ seq: 2n, deleted: true })], elsewhere)).toEqual([phantom(2n)]);
  });

  it("follows the document's file through the engine's move to its conflict copy (§5.5 X-4, #509)", () => {
    const timeline = created().rename("engine", "a.md", copy, "1", 1n).user("delete", copy, "1", 1n);
    expect(check([synced, revision({ seq: 2n, deleted: true })], timeline)).toEqual([]);
    // The file the engine wrote at a.md afterwards is not d1's.
    const wrongFile = created().rename("engine", "a.md", copy, "1", 1n).engine("create", "a.md", "2", 1n, "zz").user("delete", "a.md", "2", 1n);
    expect(check([synced, revision({ seq: 2n, deleted: true })], wrongFile)).toEqual([phantom(2n)]);
  });

  // #167 item 2, #280: the user renames synced d1 from a.md to b.md, the app
  // is killed before the engine handled the rename, and the restart pushes a
  // tombstone of d1 plus a new document d2 from the renamed file.
  describe("given a rename lost to a crash (§5.5 X-2)", () => {
    const lost = () => created().rename("user", "a.md", "b.md", "1", 1n).crash(1n);
    const tombstone = revision({ seq: 2n, deleted: true });
    const create = revision({ documentId: "d2", seq: 3n, path: "b.md" });
    const identity = (seq: bigint) => `identity: e1 committed d2 at b.md (seq ${String(seq)}, r${String(seq)}) from inode 1, which is d1's file`;

    it("excuses the tombstone and the create of the renamed file as a new document after the crash, in either order", () => {
      expect(check([synced, tombstone, create], lost())).toEqual([]);
      expect(check([synced, revision({ ...create, seq: 2n }), revision({ seq: 3n, deleted: true })], lost())).toEqual([]);
      // At the engine's conflict copy of the path, the same inode (X-3).
      expect(check([synced, tombstone, revision({ ...create, path: copy })], lost().rename("engine", "b.md", copy, "1", 2n))).toEqual([]);
    });

    it("excuses the tombstone when the user deleted the renamed file after the crash (X-7)", () => {
      expect(check([synced, tombstone], lost().user("delete", "b.md", "1", 1n))).toEqual([]);
    });

    it("reports both when the engine settled after the rename, before the crash: it had seen the rename", () => {
      const seen = created().rename("user", "a.md", "b.md", "1", 1n).settled(1n).crash(1n);
      expect(check([synced, tombstone, create], seen)).toEqual([identity(3n), phantom(2n)]);
    });

    it("reports both without a crash, or with the crash before the rename", () => {
      const running = created().rename("user", "a.md", "b.md", "1", 1n);
      expect(check([synced, tombstone, create], running)).toEqual([identity(3n), phantom(2n)]);
      const crashedFirst = created().crash(1n).rename("user", "a.md", "b.md", "1", 1n);
      expect(check([synced, tombstone, create], crashedFirst)).toEqual([identity(3n), phantom(2n)]);
    });

    it("reports both when the crash came after the tombstone and the create", () => {
      const late = created().rename("user", "a.md", "b.md", "1", 1n).crash(3n);
      expect(check([synced, tombstone, create], late)).toEqual([identity(3n), phantom(2n)]);
    });

    it("reports both when the engine committed the renamed file as an edit of an existing document (§5.5 X-8 removed by R11)", () => {
      const existing = revision({ documentId: "d2", seq: 0n, revisionId: "r0", path: "b.md", contentHash: "cc", deviceId: "scripted" });
      const edit = revision({ documentId: "d2", seq: 3n, path: "b.md" });
      expect(check([existing, synced, tombstone, edit], lost())).toEqual([identity(3n), phantom(2n)]);
    });

    it("reports the tombstone the engine pushed before the crash, even when the renamed file's create came after it (#822 item 2)", () => {
      // The rename, then the tombstone at seq 2, then the crash, then the create at seq 3: the create is in the window, the tombstone is not.
      const crashAfterTombstone = created().rename("user", "a.md", "b.md", "1", 1n).crash(2n);
      expect(check([synced, tombstone, create], crashAfterTombstone)).toEqual([phantom(2n)]);
    });

    it("reports the tombstone when the engine committed nothing from the renamed file", () => {
      expect(check([synced, tombstone], lost())).toEqual([phantom(2n)]);
      expect(check([synced, tombstone, revision({ ...create, deviceId: "scripted" })], lost())).toEqual([phantom(2n)]);
    });
  });
});

describe("identity on inodes", () => {
  // #793, seed 100117's shape: the user deletes d2's file and renames d1's onto its path, and the app is killed before either event is persisted.
  it("reports a lost rename committed as an edit of a document whose file the user also lost to the crash (§5.5 X-8 removed by R11)", () => {
    const both = () => created().user("create", "b.md", "2", 1n, "bb");
    const feed = [synced, revision({ documentId: "d2", seq: 2n, path: "b.md", contentHash: "bb" }), revision({ seq: 3n, deleted: true }), revision({ documentId: "d2", seq: 4n, path: "b.md" })];
    const transfer = ["identity: e1 committed d2 at b.md (seq 4, r4) from inode 1, which is d1's file", phantom(3n)];
    // Inside the window: the start-up scan's content match (E7b) follows the rename, so the transfer is the engine's bug.
    const lost = both().settled(2n).user("delete", "b.md", "2", 2n).rename("user", "a.md", "b.md", "1", 2n).crash(2n);
    expect(check(feed, lost)).toEqual(transfer);
    // Outside the window (the engine settled after both changes): the same.
    const seen = both().settled(2n).user("delete", "b.md", "2", 2n).rename("user", "a.md", "b.md", "1", 2n).settled(2n).crash(2n);
    expect(check(feed, seen)).toEqual(transfer);
    // d1 kept at b.md under its own id, with d2 deleted by the user: no violation.
    const kept = [synced, revision({ documentId: "d2", seq: 2n, path: "b.md", contentHash: "bb" }), revision({ documentId: "d2", seq: 3n, path: "b.md", deleted: true }), revision({ seq: 4n, path: "b.md" })];
    expect(check(kept, lost)).toEqual([]);
  });

  it("accepts commits of a document from its own file, including after a rename", () => {
    const timeline = created().user("modify", "a.md", "1", 1n, "bb").rename("user", "a.md", "c.md", "1", 1n);
    expect(check([synced, revision({ seq: 2n, path: "c.md", contentHash: "bb" })], timeline)).toEqual([]);
  });

  it("reports an edit of a document carrying another document's file (#530 class)", () => {
    const timeline = created().user("create", "b.md", "2", 1n, "bb");
    const feed = [synced, revision({ documentId: "d2", seq: 2n, path: "b.md", contentHash: "bb" }), revision({ seq: 3n, path: "a.md", contentHash: "bb" })];
    expect(check(feed, timeline)).toEqual(["identity: e1 committed d1 at a.md (seq 3, r3) from inode 2, which is d2's file"]);
  });

  it("reports a new document committed from another document's file without a crash", () => {
    const timeline = created().rename("user", "a.md", "b.md", "1", 1n);
    expect(check([synced, revision({ documentId: "d2", seq: 2n, path: "b.md" })], timeline)).toEqual(["identity: e1 committed d2 at b.md (seq 2, r2) from inode 1, which is d1's file"]);
  });

  it("accepts a detached file committed as a new document (PO-4(b), §5.5 X-20), not a displaced one", () => {
    const moved = revision({ seq: 2n, path: "c.md", deviceId: "scripted" });
    const detach = created().rename("engine", "a.md", "a (conflict e1 2026-01-02 030405).md", "1", 2n);
    expect(check([synced, moved, revision({ documentId: "d3", seq: 3n, path: "a (conflict e1 2026-01-02 030405).md" })], detach)).toEqual([]);
    // Moved, but not to a conflict copy: still d1's file.
    const renamed = created().rename("engine", "a.md", "x.md", "1", 2n);
    expect(check([synced, moved, revision({ documentId: "d3", seq: 3n, path: "x.md" })], renamed)).toEqual(["identity: e1 committed d3 at x.md (seq 3, r3) from inode 1, which is d1's file"]);
  });

  it("reports a document's own file the engine moved to its conflict copy and committed as a new document (no X-21: PO-1, §4.4)", () => {
    const copyOfA = "a (conflict e1 2026-01-02 030405).md";
    const moved = created().rename("engine", "a.md", copyOfA, "1", 1n);
    expect(check([synced, revision({ documentId: "d3", seq: 2n, path: copyOfA })], moved)).toEqual([`identity: e1 committed d3 at ${copyOfA} (seq 2, r2) from inode 1, which is d1's file`]);
  });

  it("keeps a file the user renamed onto the path bound, so its detach is a displace (X-20's narrowed rule)", () => {
    // d1 synced at a.md, then the user renamed its file away and back onto a.md: no longer a detach (PropertyWorld.detached).
    const copyOfA = "a (conflict e1 2026-01-02 030405).md";
    const moved = revision({ seq: 2n, path: "c.md", deviceId: "scripted" });
    const timeline = created().rename("user", "a.md", "x.md", "1", 1n).rename("user", "x.md", "a.md", "1", 1n).rename("engine", "a.md", copyOfA, "1", 2n);
    expect(check([synced, moved, revision({ documentId: "d3", seq: 3n, path: copyOfA })], timeline)).toEqual([`identity: e1 committed d3 at ${copyOfA} (seq 3, r3) from inode 1, which is d1's file`]);
  });

  it("matches paths as the platform's filesystem does", () => {
    const timeline = created().user("modify", "A.md", "1", 1n, "bb");
    expect(check([synced, revision({ seq: 2n, path: "A.md", contentHash: "bb" })], timeline, "windows")).toEqual([]);
  });

  it("ignores scripted clients' revisions", () => {
    const timeline = created().user("create", "b.md", "2", 1n, "bb");
    expect(check([synced, revision({ documentId: "d2", seq: 2n, path: "b.md", contentHash: "bb", deviceId: "scripted" })], timeline)).toEqual([]);
  });

  // #844 (seeds 100160 and 100197 with members): the engine read a file, the user then deleted, overwrote or moved it, and
  // the same bytes landed in another document's file (an applied revision, or the user's paste). The commit of what the
  // engine read came from the file that held those bytes at the commit's path (§5.4), not from the other document's file.
  describe("given bytes the engine read from a file that has changed since, which also landed in another document's file (#844)", () => {
    it("binds the commit to the file that held them at its path, which the user then deleted (seed 100160)", () => {
      // d2 is synced at e.md (inode 2). The user creates b.md (inode 1, hh); the engine reads it; d2's next revision, also hh, is applied into inode 2; the user deletes b.md; the engine commits b.md as d1, then its delete.
      const feed = [revision({ documentId: "d2", path: "e.md", contentHash: "qq", deviceId: "scripted" }), revision({ documentId: "d2", seq: 2n, path: "e.md", contentHash: "hh", deviceId: "scripted" }), revision({ seq: 3n, path: "b.md", contentHash: "hh" }), revision({ seq: 4n, path: "b.md", deleted: true })];
      const timeline = new Timeline().engine("create", "e.md", "2", 1n, "qq").user("create", "b.md", "1", 1n, "hh").engine("modify", "e.md", "2", 2n, "hh").user("delete", "b.md", "1", 2n);
      expect(check(feed, timeline)).toEqual([]);
    });

    it("binds the commit to the file that held them at its path, which the user then edited, and keeps the other file its own document's (seed 100197)", () => {
      // d2 is synced at d.md (inode 2). The engine reads copy.md (inode 1, hh) as d1's create; the user edits it to zz and writes hh into d.md; the engine commits d1's create, its edit, and later d2's edit from d.md.
      const feed = [revision({ documentId: "d2", path: "d.md", contentHash: "qq", deviceId: "scripted" }), revision({ seq: 2n, path: "copy.md", contentHash: "hh" }), revision({ seq: 3n, path: "copy.md", contentHash: "zz" }), revision({ documentId: "d2", seq: 4n, path: "d.md", contentHash: "ww" })];
      const timeline = new Timeline().engine("create", "d.md", "2", 1n, "qq").user("create", "copy.md", "1", 1n, "hh").user("modify", "copy.md", "1", 1n, "zz").user("modify", "d.md", "2", 1n, "hh").user("modify", "d.md", "2", 3n, "ww");
      expect(check(feed, timeline)).toEqual([]);
    });

    it("keeps every document's identity whatever the order of the changes (property)", () => {
      const away = fc.constantFrom("delete", "modify", "rename");
      const other = fc.constantFrom("engine", "user");
      fc.assert(
        fc.property(fc.boolean(), away, other, fc.integer({ min: 0, max: 2 }), (movedIn, gone, writer, otherAt) => {
          // d2 is synced at e.md (inode 2). The user creates b.md (inode 1, hh), or creates x.md and renames it to b.md, which the engine reads as d1's create, and then deletes, overwrites or moves it; at `otherAt` among those, hh lands in d2's file.
          const feed: FeedRevision[] = [revision({ documentId: "d2", path: "e.md", contentHash: "qq", deviceId: "scripted" })];
          if (writer === "engine") feed.push(revision({ documentId: "d2", seq: 2n, path: "e.md", contentHash: "hh", deviceId: "scripted" }));
          feed.push(revision({ seq: 3n, path: "b.md", contentHash: "hh" }));
          if (gone === "delete") feed.push(revision({ seq: 4n, path: "b.md", deleted: true }));
          if (gone === "modify") feed.push(revision({ seq: 4n, path: "b.md", contentHash: "zz" }));
          if (gone === "rename") feed.push(revision({ seq: 4n, path: "c.md", contentHash: "hh" }));
          // d2's later edit from its own file.
          feed.push(revision({ documentId: "d2", seq: 5n, path: "e.md", contentHash: "ww" }));
          const steps: ((timeline: Timeline) => Timeline)[] = [
            (timeline) => (movedIn ? timeline.user("create", "x.md", "1", 1n, "hh").rename("user", "x.md", "b.md", "1", 1n) : timeline.user("create", "b.md", "1", 1n, "hh")),
            (timeline) => (gone === "delete" ? timeline.user("delete", "b.md", "1", 2n) : gone === "modify" ? timeline.user("modify", "b.md", "1", 2n, "zz") : timeline.rename("user", "b.md", "c.md", "1", 2n)),
          ];
          const landed = (timeline: Timeline) => (writer === "engine" ? timeline.engine("modify", "e.md", "2", 2n, "hh") : timeline.user("modify", "e.md", "2", 2n, "hh"));
          steps.splice(otherAt, 0, landed);
          const timeline = steps.reduce((built, step) => step(built), new Timeline().engine("create", "e.md", "2", 1n, "qq"));
          timeline.user("modify", "e.md", "2", 4n, "ww");
          expect(check(feed, timeline)).toEqual([]);
        }),
      );
    });
  });
});

describe("resurrected-delete on inodes", () => {
  // d1 is created by a scripted client at seq 1, which the engine writes into inode 1 at a.md, and deleted by it at seq 2; the engine brings it back at seq 3, with bb.
  const pulled = () => new Timeline().engine("create", "a.md", "1", 1n, "aa");
  const deletedThenBack = (back: Partial<FeedRevision> = {}) => [
    revision({ deviceId: "scripted" }),
    revision({ seq: 2n, deleted: true, deviceId: "scripted", contentHash: "" }),
    revision({ seq: 3n, contentHash: "bb", ...back }),
  ];
  const resurrected = (path = "a.md") => `resurrected-delete: e1 brought back d1 at ${path} (seq 3, r3) after its delete at a.md (seq 2) although its user changed no file of it since`;
  // The engine's own d1: the user's aa in inode 1, committed at seq 1, deleted by a scripted client at seq 2, brought back with aa at seq 3.
  const ownThenBack = () => [revision({}), revision({ seq: 2n, deleted: true, deviceId: "scripted", contentHash: "" }), revision({ seq: 3n })];

  it("reports an engine that brings a deleted document back although its user changed no file of it", () => {
    expect(check(deletedThenBack({ contentHash: "aa" }), pulled())).toEqual([resurrected()]);
    // A change of another file, even with the same content, does not explain it (§5.5 X-10).
    expect(check(deletedThenBack({ contentHash: "aa" }), pulled().user("create", "b.md", "2", 1n, "bb"))).toEqual([resurrected()]);
  });

  it("accepts a document brought back by a scripted client, or by the engine of a user who edited, re-created or renamed its file", () => {
    expect(check(deletedThenBack({ deviceId: "scripted" }), pulled())).toEqual([]);
    // Edited concurrently with the delete (before it), or re-created after it.
    expect(check(deletedThenBack(), pulled().user("modify", "a.md", "1", 1n, "bb"))).toEqual([]);
    expect(check(deletedThenBack(), pulled().user("delete", "a.md", "1", 2n).user("create", "a.md", "2", 2n, "bb"))).toEqual([]);
    // Renamed to a new path, where it comes back.
    expect(check(deletedThenBack({ path: "c.md", contentHash: "aa" }), pulled().rename("user", "a.md", "c.md", "1", 1n))).toEqual([]);
  });

  it("does not count a change of a file that is neither the document's nor at its path (PO-13, #822 item 1)", () => {
    // The engine brings d1 back at a.md with bb, the content the user wrote into a new file b.md after the delete: that file is not d1's, and d1's own file at a.md is unchanged.
    expect(check(deletedThenBack(), pulled().user("create", "b.md", "2", 2n, "bb"))).toEqual([resurrected()]);
  });

  it("accepts a document the user restored after its delete", () => {
    expect(check(deletedThenBack({ contentHash: "aa" }), pulled().restore("d1", 2n))).toEqual([]);
    expect(check(deletedThenBack({ contentHash: "aa" }), pulled().restore("d2", 2n))).toEqual([resurrected()]);
  });

  it("does not count a change made once the document was back", () => {
    expect(check(deletedThenBack({ contentHash: "aa" }), pulled().user("modify", "a.md", "1", 3n, "bb"))).toEqual([resurrected()]);
  });

  it("does not count a change the engine had already committed before the delete", () => {
    const wrote = (...hashes: string[]) => {
      const timeline = new Timeline();
      hashes.forEach((hash, index) => timeline.user(index === 0 ? "create" : "modify", "a.md", "1", 0n, hash));
      return timeline;
    };
    expect(check(ownThenBack(), wrote("aa"))).toEqual([resurrected()]);
    // Committed with a later change's content: the earlier change is carried too.
    expect(check(ownThenBack(), wrote("a0", "aa"))).toEqual([resurrected()]);
    // A later change the engine had not committed explains it.
    expect(check(ownThenBack(), wrote("aa").user("modify", "a.md", "1", 1n, "ab"))).toEqual([]);
  });

  it("does not count a change the engine's own tombstone superseded", () => {
    // The user wrote a.md, then deleted it (the engine's tombstone at seq 2): bringing it back needs a new change.
    const feed = [revision({}), revision({ seq: 2n, deleted: true, contentHash: "" }), revision({ seq: 3n })];
    const deleted = new Timeline().user("create", "a.md", "1", 0n, "aa").user("delete", "a.md", "1", 1n);
    expect(check(feed, deleted)).toEqual([resurrected()]);
    expect(check(feed, deleted.user("create", "a.md", "2", 2n, "aa"))).toEqual([]);
  });

  it("matches paths as the platform's filesystem does", () => {
    // An untracked file at the tombstone's path, by the platform's file key, is adopted (PO-13).
    expect(check(deletedThenBack({ path: "A.md" }), new Timeline().user("create", "A.md", "2", 2n, "bb"), "windows")).toEqual([]);
  });
});
