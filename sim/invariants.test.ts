import { describe, expect, it } from "vitest";

import { InMemoryJournal } from "../plugin/src/core/journal/memory";
import { InMemoryVault } from "../plugin/src/core/vault/memory";
import { pathPool } from "./client";
import { EngineUser } from "./engine-user";
import { checkEngineEchoes, checkLostWrites, checkPhantomDeletes, checkResurrections, UserLedger, type EngineChanges, type FeedRevision, type UserChange } from "./invariants";

const at = "step 1";

function ledgerWith(...hashes: string[]): UserLedger {
  const ledger = new UserLedger();
  for (const hash of hashes) ledger.write({ hash, path: `${hash}.md`, at });
  return ledger;
}

describe("checkLostWrites", () => {
  it("accepts writes whose content is in a final vault or in history", () => {
    expect(checkLostWrites("e1", ledgerWith("aa", "bb"), new Set(["aa", "bb", "cc"]))).toEqual([]);
  });

  it("reports a write whose content survives nowhere, naming the engine, path and step", () => {
    const violations = checkLostWrites("e1", ledgerWith("aa", "bb"), new Set(["aa"]));
    expect(violations).toEqual([{ invariant: "lost-write", detail: expect.stringContaining("e1's user wrote bb to bb.md at step 1") as unknown }]);
  });

  it("accepts a write the user replaced or deleted themselves", () => {
    const ledger = ledgerWith("aa");
    ledger.replace("aa");
    expect(checkLostWrites("e1", ledger, new Set())).toEqual([]);
  });

  it("accepts a write that survives as what the merge path made of it, transitively", () => {
    const ledger = ledgerWith("aa");
    ledger.merged("aa", "merged");
    ledger.merged("merged", "copy");
    expect(checkLostWrites("e1", ledger, new Set(["copy"]))).toEqual([]);
    // The merge result was replaced by the user: the write is no longer owed.
    const replaced = ledgerWith("aa");
    replaced.merged("aa", "merged");
    replaced.replace("merged");
    expect(checkLostWrites("e1", replaced, new Set())).toEqual([]);
  });

  it("reports a write whose merge results are lost too, without looping on a merge cycle", () => {
    const ledger = ledgerWith("aa");
    ledger.merged("aa", "bb");
    ledger.merged("bb", "aa");
    expect(checkLostWrites("e1", ledger, new Set(["unrelated"])).map((violation) => violation.invariant)).toEqual(["lost-write"]);
  });

  it("owes the unreplaced writes and their merge results", () => {
    const ledger = ledgerWith("aa", "bb");
    ledger.replace("bb");
    ledger.merged("aa", "cc");
    expect(ledger.owed()).toEqual(new Set(["aa", "cc"]));
  });
});

describe("checkResurrections", () => {
  const label = (id: string) => id;
  const revision = (overrides: Partial<FeedRevision>): FeedRevision => ({
    revisionId: "r",
    documentId: "d1",
    seq: 1n,
    path: "a.md",
    deleted: false,
    deviceId: "engine",
    contentHash: "aa",
    size: 1n,
    ...overrides,
  });
  const write = (path: string, hash: string, serverSeq: bigint): UserChange => ({ paths: [path], result: { path, hash }, serverSeq, at });
  const resurrections = (feed: FeedRevision[], changes: UserChange[], platform: EngineChanges["platform"] = "posix") =>
    checkResurrections(feed, new Set(["scripted"]), [{ name: "e1", deviceId: "engine", platform, changes }], label).map((violation) => violation.detail);
  // d1 is created by a scripted client at seq 1 and deleted by it at seq 2; the engine brings it back at seq 3, with bb.
  const deletedThenBack = (back: Partial<FeedRevision> = {}) => [
    revision({ deviceId: "scripted" }),
    revision({ seq: 2n, deleted: true, deviceId: "scripted", contentHash: "" }),
    revision({ seq: 3n, revisionId: "r3", contentHash: "bb", ...back }),
  ];
  // The engine's own d1: aa, committed at seq 1, deleted by a scripted client at seq 2, brought back with aa at seq 3.
  const ownThenBack = () => [revision({}), revision({ seq: 2n, deleted: true, deviceId: "scripted", contentHash: "" }), revision({ seq: 3n, revisionId: "r3" })];

  it("reports an engine that brings a deleted document back although its user changed no file of it", () => {
    expect(resurrections(deletedThenBack(), [])).toEqual(["e1 brought back d1 at a.md (seq 3, r3) after its delete at a.md (seq 2) although its user changed no file of it since"]);
    // A change at another path does not explain it.
    expect(resurrections(deletedThenBack(), [write("b.md", "bb", 1n)])).toHaveLength(1);
  });

  it("accepts a document brought back by a scripted client, or by the engine of a user who edited, re-created or renamed its file", () => {
    expect(resurrections(deletedThenBack({ deviceId: "scripted" }), [])).toEqual([]);
    // Edited concurrently with the delete (before it), or re-created after it.
    expect(resurrections(deletedThenBack(), [write("a.md", "bb", 1n)])).toEqual([]);
    expect(resurrections(deletedThenBack(), [write("a.md", "bb", 2n)])).toEqual([]);
    // Renamed from the document's path to a new one, where it comes back.
    expect(resurrections(deletedThenBack({ path: "c.md" }), [{ paths: ["a.md", "c.md"], result: { path: "c.md", hash: "aa" }, serverSeq: 1n, at }])).toEqual([]);
  });

  it("does not count a change made once the document was back", () => {
    expect(resurrections(deletedThenBack(), [write("a.md", "bb", 3n)])).toHaveLength(1);
    expect(resurrections(deletedThenBack(), [write("a.md", "bb", 2n)])).toEqual([]);
  });

  it("does not count a change the engine had already committed before the delete", () => {
    // The user wrote aa before seq 1, which committed it.
    expect(resurrections(ownThenBack(), [write("a.md", "aa", 0n)])).toHaveLength(1);
    // Committed with a later change's content: the earlier change is carried too.
    expect(resurrections(ownThenBack(), [write("a.md", "a0", 0n), write("a.md", "aa", 0n)])).toHaveLength(1);
    // A later change the engine had not committed explains it.
    expect(resurrections(ownThenBack(), [write("a.md", "aa", 0n), write("a.md", "ab", 1n)])).toEqual([]);
    // The engine committed other content after the change, which it then still owed.
    expect(resurrections(ownThenBack(), [write("a.md", "a0", 0n)])).toEqual([]);
  });

  it("does not count a change the engine's own tombstone superseded", () => {
    // The user wrote a.md, then deleted it (the engine's tombstone at seq 2): bringing it back needs a new change.
    const feed = [revision({}), revision({ seq: 2n, deleted: true, contentHash: "" }), revision({ seq: 3n, revisionId: "r3" })];
    expect(resurrections(feed, [write("a.md", "a0", 0n)])).toHaveLength(1);
    expect(resurrections(feed, [write("a.md", "a0", 0n), write("a.md", "aa", 2n)])).toEqual([]);
  });

  it("matches paths as the engine's platform does", () => {
    expect(resurrections(deletedThenBack(), [write("A.md", "bb", 1n)], "posix")).toHaveLength(1);
    expect(resurrections(deletedThenBack(), [write("A.md", "bb", 1n)], "windows")).toEqual([]);
  });

  it("reports a document brought back by a device no client of the run uses, and ignores live revisions after live ones", () => {
    expect(resurrections(deletedThenBack({ deviceId: "stranger" }), [write("a.md", "bb", 1n)])).toEqual([
      "unknown device stranger brought back d1 at a.md (seq 3, r3) after its delete at a.md (seq 2) although no client of the run uses that device",
    ]);
    expect(resurrections([revision({ deviceId: "stranger" }), revision({ seq: 2n, deviceId: "stranger" })], [])).toEqual([]);
  });
});

describe("checkPhantomDeletes", () => {
  const revision = (overrides: Partial<FeedRevision>): FeedRevision => ({
    revisionId: "r",
    documentId: "d1",
    seq: 1n,
    path: "a.md",
    deleted: false,
    deviceId: "engine",
    contentHash: "aa",
    size: 1n,
    ...overrides,
  });
  const label = (id: string) => id;
  const engine = (deleted: string[]) => [{ name: "e1", deviceId: "engine", deletedDocuments: new Set(deleted), platform: "posix" as const, renames: [], crashes: [] }];

  it("accepts tombstones of scripted clients and of documents the engine's user deleted", () => {
    const feed = [revision({}), revision({ seq: 2n, deleted: true, deviceId: "scripted" }), revision({ seq: 3n, documentId: "d2", deleted: true })];
    expect(checkPhantomDeletes(feed, new Set(["scripted"]), engine(["d2"]), label)).toEqual([]);
  });

  it("reports an engine's tombstone for a document its user never deleted", () => {
    const feed = [revision({}), revision({ seq: 2n, deleted: true })];
    const violations = checkPhantomDeletes(feed, new Set(["scripted"]), engine(["d2"]), label);
    expect(violations.map((violation) => violation.invariant)).toEqual(["phantom-delete"]);
    expect(violations[0]?.detail).toContain("e1 deleted d1 at a.md (seq 2");
  });

  it("reports a tombstone from a device no client of the run uses", () => {
    const violations = checkPhantomDeletes([revision({ deleted: true, deviceId: "stranger" })], new Set(["scripted"]), engine(["d1"]), label);
    expect(violations.map((violation) => violation.invariant)).toEqual(["phantom-delete"]);
  });

  it("ignores live revisions", () => {
    expect(checkPhantomDeletes([revision({ deviceId: "stranger" })], new Set(), [], label)).toEqual([]);
  });

  // #167 item 2, #280: the user renames synced d1 (content aa) from a.md to
  // b.md, the app is killed (head seq 1) before the engine records the
  // rename, and the restart's full scan pushes a tombstone of d1 plus a new
  // document d2 at b.md with the same content.
  describe("given a rename the engine lost to a crash", () => {
    const tombstone = revision({ revisionId: "r2", seq: 2n, deleted: true });
    const create = revision({ revisionId: "r3", documentId: "d2", seq: 3n, path: "b.md" });
    /** e1's user renamed a.md (d1's file, content aa) to b.md; `then` runs after it; by default the app is then killed at head seq 1. */
    const lostRename = (options: { documents?: string[]; then?: (ledger: UserLedger) => void; crash?: bigint | null; platform?: "posix" | "windows" } = {}) => {
      const ledger = new UserLedger(options.platform ?? "posix");
      ledger.renamed("a.md", "b.md", new Set(options.documents ?? ["d1"]), "aa");
      options.then?.(ledger);
      if (options.crash !== null) ledger.crashed(options.crash ?? 1n);
      return [{ name: "e1", deviceId: "engine", deletedDocuments: ledger.deletedDocuments, platform: ledger.platform, renames: ledger.renames, crashes: ledger.crashes }];
    };
    const phantoms = (feed: FeedRevision[], engines: ReturnType<typeof lostRename>) => checkPhantomDeletes(feed, new Set(["scripted"]), engines, label).map((violation) => violation.detail);
    const reported = ["e1 deleted d1 at a.md (seq 2, r2) although its user never deleted it"];

    it("excuses the tombstone when the engine created the renamed file at its new path as a new document after the crash", () => {
      expect(phantoms([revision({}), tombstone, create], lostRename())).toEqual([]);
      // The create may come first.
      expect(phantoms([revision({}), revision({ ...create, seq: 2n }), revision({ ...tombstone, seq: 3n })], lostRename())).toEqual([]);
    });

    it("follows the renamed file through the user's later renames and edits until the user deletes it", () => {
      const later = (ledger: UserLedger) => {
        ledger.write({ hash: "bb", path: "b.md", at });
        ledger.renamed("b.md", "c.md", new Set(), "bb");
        ledger.write({ hash: "cc", path: "c.md", at });
      };
      expect(phantoms([revision({}), tombstone, revision({ ...create, path: "c.md", contentHash: "cc" })], lostRename({ then: later }))).toEqual([]);
      expect(phantoms([revision({}), tombstone, revision({ ...create, path: "c.md", contentHash: "bb" })], lostRename({ then: later }))).toEqual([]);
      // Never content or a path the file did not have.
      expect(phantoms([revision({}), tombstone, revision({ ...create, path: "c.md", contentHash: "dd" })], lostRename({ then: later }))).toEqual(reported);
      expect(phantoms([revision({}), tombstone, revision({ ...create, path: "d.md", contentHash: "cc" })], lostRename({ then: later }))).toEqual(reported);
      // Deleted, the file is followed no further: what is written at its path later is another file.
      const deleted = (ledger: UserLedger) => {
        ledger.deleted("b.md");
        ledger.write({ hash: "ee", path: "b.md", at });
      };
      expect(phantoms([revision({}), tombstone, revision({ ...create, contentHash: "ee" })], lostRename({ then: deleted }))).toEqual(reported);
    });

    it("matches paths as the platform does", () => {
      expect(phantoms([revision({}), tombstone, revision({ ...create, path: "B.md" })], lostRename({ platform: "windows" }))).toEqual([]);
      expect(phantoms([revision({}), tombstone, revision({ ...create, path: "B.md" })], lostRename())).toEqual(reported);
    });

    it("excuses it when the server refused the create at that path and the engine kept the file as its own conflict copy (#485)", () => {
      const at = (path: string) => revision({ ...create, path });
      expect(phantoms([revision({}), tombstone, at("b (conflict e1 2026-01-02 030405).md")], lostRename())).toEqual([]);
      expect(phantoms([revision({}), tombstone, at("b (conflict e1 2026-01-02 030405 2).md")], lostRename())).toEqual([]);
      expect(phantoms([revision({}), tombstone, at("B (conflict e1 2026-01-02 030405).md")], lostRename({ platform: "windows" }))).toEqual([]);
      // The outermost folder in the way takes the conflict name (#359).
      const intoFolder = (ledger: UserLedger) => {
        ledger.renamed("b.md", "notes/c.md", new Set(), "aa");
      };
      expect(phantoms([revision({}), tombstone, at("notes (conflict e1 2026-01-02 030405)/c.md")], lostRename({ then: intoFolder }))).toEqual([]);
      // Never another device's copy, a copy of another path, or a copy that is not one by its name.
      expect(phantoms([revision({}), tombstone, at("b (conflict e9 2026-01-02 030405).md")], lostRename())).toEqual(reported);
      expect(phantoms([revision({}), tombstone, at("d (conflict e1 2026-01-02 030405).md")], lostRename())).toEqual(reported);
      expect(phantoms([revision({}), tombstone, at("B (conflict e1 2026-01-02 030405).md")], lostRename())).toEqual(reported);
      expect(phantoms([revision({}), tombstone, at("b (conflict e1).md")], lostRename())).toEqual(reported);
      expect(phantoms([revision({}), tombstone, at("notes (conflict e1 2026-01-02 030405)/d.md")], lostRename({ then: intoFolder }))).toEqual(reported);
    });

    it("excuses it when the engine took the renamed file for a document whose file the user deleted at that path (#254)", () => {
      const replaced = revision({ revisionId: "r3", documentId: "d2", seq: 3n, path: "b.md" });
      const feed = [revision({}), revision({ revisionId: "r0", documentId: "d2", seq: 0n, path: "b.md", contentHash: "cc" }), tombstone, replaced];
      expect(phantoms(feed, lostRename({ then: (ledger) => ledger.deletedDocuments.add("d2") }))).toEqual([]);
      // Not when the user never deleted that document: then it is an edit of a document that existed before.
      expect(phantoms(feed, lostRename())).toEqual(reported);
    });

    it("still reports a genuine phantom delete: no rename, or a rename of another document", () => {
      const noRename = new UserLedger();
      noRename.crashed(1n);
      expect(phantoms([revision({}), tombstone, create], [{ name: "e1", deviceId: "engine", deletedDocuments: new Set(), platform: "posix", renames: noRename.renames, crashes: noRename.crashes }])).toEqual(reported);
      expect(phantoms([revision({}), tombstone, create], lostRename({ documents: ["d9"] }))).toEqual(reported);
    });

    it("reports it when the engine did not crash after the rename, or the tombstone came before the crash", () => {
      expect(phantoms([revision({}), tombstone, create], lostRename({ crash: null }))).toEqual(reported);
      // Killed before the user renamed the file: the running engine saw the rename.
      const crashedFirst = new UserLedger();
      crashedFirst.crashed(1n);
      crashedFirst.renamed("a.md", "b.md", new Set(["d1"]), "aa");
      expect(phantoms([revision({}), tombstone, create], [{ name: "e1", deviceId: "engine", deletedDocuments: new Set(), platform: "posix", renames: crashedFirst.renames, crashes: crashedFirst.crashes }])).toEqual(reported);
      // Committed before the app was killed (head seq 2 at the crash): the running engine lost the rename.
      expect(phantoms([revision({}), tombstone, create], lostRename({ crash: 2n }))).toEqual(reported);
    });

    it("reports it when the engine did not commit the renamed file as another document after the crash", () => {
      // Nothing created.
      expect(phantoms([revision({}), tombstone], lostRename())).toEqual(reported);
      // Created by another device.
      expect(phantoms([revision({}), tombstone, revision({ ...create, deviceId: "scripted" })], lostRename())).toEqual(reported);
      // A tombstone, not a create.
      expect(phantoms([revision({}), tombstone, revision({ ...create, deleted: true })], lostRename())).toEqual([...reported, "e1 deleted d2 at b.md (seq 3, r3) although its user never deleted it"]);
      // The tombstoned document itself.
      expect(phantoms([revision({}), tombstone, revision({ ...create, documentId: "d1", seq: 4n })], lostRename())).toEqual(reported);
      // Created before the crash.
      expect(phantoms([revision({}), revision({ ...create, seq: 1n }), revision({ ...tombstone, seq: 3n })], lostRename({ crash: 2n }))).toEqual(["e1 deleted d1 at a.md (seq 3, r2) although its user never deleted it"]);
    });
  });

  // #509: the user renames synced d1 from a.md to b.md, and before the
  // rename is pushed another device's d2 arrives at b.md: the engine moves
  // the user's file aside to its own conflict copy and writes d2 at b.md.
  // The copy is d1's file, so the user's delete of it is the user deleting d1.
  describe("given the engine's move of the user's renamed file to its own conflict copy (#509)", () => {
    const copy = "b (conflict e1 2026-01-02 030405).md";
    const tombstone = revision({ revisionId: "r2", seq: 2n, deleted: true });
    const encode = (content: string) => new TextEncoder().encode(content);
    const setup = async () => {
      const vault = new InMemoryVault();
      const journal = new InMemoryJournal();
      const ledger = new UserLedger();
      const user = new EngineUser({ name: "e1", vault, journal, ledger, now: () => at, touched: () => undefined, serverSeq: () => 1n, pathPool });
      await vault.write("a.md", encode("aa"));
      await journal.putDocument({ documentId: "d1", path: "a.md", revisionId: "r1", seq: 1n, baseHash: "aa", size: 2n, kind: "text", deleted: false });
      await user.rename("a.md", "b.md");
      /** The engine moves b.md to `to` and writes d2 at b.md, as its pull does. */
      const engineMoves = async (to: string) => {
        await user.engineRenamed("b.md", to, () => vault.rename("b.md", to));
        await vault.write("b.md", encode("theirs"));
        await journal.putDocument({ documentId: "d2", path: "b.md", revisionId: "r3", seq: 3n, baseHash: "bb", size: 6n, kind: "text", deleted: false });
      };
      const phantoms = () =>
        checkPhantomDeletes([revision({}), tombstone], new Set(), [{ name: "e1", deviceId: "engine", deletedDocuments: ledger.deletedDocuments, platform: "posix", renames: ledger.renames, crashes: ledger.crashes }], label).map(
          (violation) => violation.detail,
        );
      return { user, ledger, engineMoves, phantoms };
    };
    const reported = ["e1 deleted d1 at a.md (seq 2, r2) although its user never deleted it"];

    it("excuses the tombstone of the document whose file the user deleted at the copy, and follows the renamed file there", async () => {
      const { user, ledger, engineMoves, phantoms } = await setup();
      await engineMoves(copy);
      expect(ledger.renames[0]?.current).toBe(copy);
      await user.remove(copy);
      expect(phantoms()).toEqual([]);
      expect(ledger.renames[0]?.current).toBeUndefined();
      // The other device's note now at b.md is not the deleted one.
      expect(ledger.deletedDocuments.has("d2")).toBe(false);
    });

    it("still reports the tombstone when the user deleted another file, or the engine's move was not to its own conflict copy", async () => {
      const kept = await setup();
      await kept.engineMoves(copy);
      await kept.user.remove("b.md");
      expect(kept.phantoms()).toEqual(reported);

      const elsewhere = await setup();
      const notACopy = "b (conflict e9 2026-01-02 030405).md";
      await elsewhere.engineMoves(notACopy);
      await elsewhere.user.remove(notACopy);
      expect(elsewhere.phantoms()).toEqual(reported);
    });
  });
});

describe("checkEngineEchoes", () => {
  const echoes = (...args: Parameters<typeof checkEngineEchoes>) => checkEngineEchoes(...args).map((violation) => violation.detail);

  it("accepts changes at paths the user changed and reports every other one as the engine's own", () => {
    const events = [
      { type: "modify", path: "a.md" },
      { type: "create", path: "b.md" },
      { type: "rename", path: "c.md", oldPath: "a.md" },
      { type: "delete", path: "d.md" },
    ] as const;
    expect(echoes("e1", events, new Set(["a.md", "c.md"]), "posix")).toEqual(["e1 reported its own create of b.md as a local change", "e1 reported its own delete of d.md as a local change"]);
  });

  // A case-insensitive vault keeps the spelling a file has: the user's write
  // of STRASSE.md over straße.md is reported as a modify of straße.md (#247).
  it.each([
    ["macos", "STRASSE.md", "straße.md"],
    ["windows", "A.md", "a.md"],
    ["macos", "notes/Cafe\u0301.md", "NOTES/café.md"],
    ["windows", "Notes/A.md", "notes/a.md"],
  ] as const)("under %s rules, attributes a change the vault reports at another spelling of the user's path %s to the user", (platform, touched, reported) => {
    expect(echoes("e1", [{ type: "modify", path: reported }], new Set([touched]), platform)).toEqual([]);
  });

  it.each(["macos", "windows"] as const)("under %s rules, still reports the engine's own change at a path the user never changed under any spelling", (platform) => {
    expect(echoes("e1", [{ type: "modify", path: "straße.md" }], new Set(["STRASS.md", "strasse.md.md", "a.md"]), platform)).toEqual(["e1 reported its own modify of straße.md as a local change"]);
  });

  it("under posix rules, where a.md and A.md are two files, reports the engine's own change at a case variant of the user's path", () => {
    expect(echoes("e1", [{ type: "modify", path: "a.md" }], new Set(["A.md"]), "posix")).toEqual(["e1 reported its own modify of a.md as a local change"]);
    expect(echoes("e1", [{ type: "modify", path: "straße.md" }], new Set(["STRASSE.md"]), "posix")).toEqual(["e1 reported its own modify of straße.md as a local change"]);
  });
});
