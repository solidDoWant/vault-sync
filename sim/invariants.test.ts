import { describe, expect, it } from "vitest";

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
    expect(violations).toEqual([{ invariant: "lost-write", detail: expect.stringContaining("e1's user wrote bb to bb.md at step 1") as unknown as string }]);
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
  const engine = (deleted: string[]) => [{ name: "e1", deviceId: "engine", deletedDocuments: new Set(deleted) }];

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
