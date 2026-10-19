import { describe, expect, it } from "vitest";

import { checkLostWrites, checkPhantomDeletes, UserLedger, type FeedRevision } from "./invariants";

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
