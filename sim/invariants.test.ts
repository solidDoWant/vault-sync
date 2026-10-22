import { describe, expect, it } from "vitest";

import { sha256Hex } from "../plugin/src/core/hash";
import { InMemoryVault } from "../plugin/src/core/vault/memory";
import { pathPool } from "./client";
import { EngineUser } from "./engine-user";
import { carriesLocalEdit, checkEngineEchoes, copiedFrom, KnownContents, checkLostWrites, checkPhantomDeletes, checkResurrections, UserLedger, type FeedRevision } from "./invariants";

const at = "step 1";

function ledgerWith(...hashes: string[]): UserLedger {
  const ledger = new UserLedger();
  for (const hash of hashes) ledger.write({ hash, path: `${hash}.md`, at });
  return ledger;
}

describe("copiedFrom", () => {
  it("strips a device's conflict suffix only where it ends a segment's name, before the extension", () => {
    expect(copiedFrom("b (conflict e1 2026-01-02 030405).md", "e1")).toEqual(["b.md"]);
    expect(copiedFrom("b (conflict e1 2026-01-02 030405 2).md", "e1")).toEqual(["b.md"]);
    expect(copiedFrom("notes (conflict e1 2026-01-02 030405)/c.md", "e1")).toEqual(["notes/c.md"]);
  });

  it("does not take a name with the suffix mid-name for a copy (#503, #822 item 5)", () => {
    // A rename to `b x.md` is not the copy `b (conflict …) x.md` names.
    expect(copiedFrom("b (conflict e1 2026-01-02 030405) x.md", "e1")).toEqual([]);
    // Nor another device's copy.
    expect(copiedFrom("b (conflict e2 2026-01-02 030405).md", "e1")).toEqual([]);
  });
});

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
    ledger.replace("aa", "aa.md");
    expect(checkLostWrites("e1", ledger, new Set())).toEqual([]);
  });

  it("reports a lost write of content X although the user later overwrote another file holding X", () => {
    const ledger = new UserLedger();
    ledger.write({ hash: "xx", path: "a.md", at });
    ledger.write({ hash: "xx", path: "b.md", at });
    ledger.replace("xx", "b.md");
    expect(checkLostWrites("e1", ledger, new Set()).map((violation) => violation.detail)).toEqual([expect.stringContaining("e1's user wrote xx to a.md") as unknown as string]);
    expect(ledger.owed()).toEqual(new Set(["xx"]));
  });

  it("does not excuse a write by a replacement that came before it, as of the same content at the same path", () => {
    const ledger = new UserLedger();
    ledger.write({ hash: "xx", path: "a.md", at });
    ledger.replace("xx", "a.md");
    ledger.write({ hash: "xx", path: "a.md", at: "step 2" });
    expect(checkLostWrites("e1", ledger, new Set()).map((violation) => violation.detail)).toEqual([expect.stringContaining("at step 2") as unknown as string]);
  });

  it("judges a write through an alias spelling by its file: overwriting I.md replaces a write to ı.md on Windows (#736)", () => {
    const ledger = new UserLedger("windows");
    ledger.write({ hash: "xx", path: "ı.md", at });
    ledger.replace("xx", "I.md");
    expect(checkLostWrites("e1", ledger, new Set())).toEqual([]);
  });

  it("keeps following a write in Straße.md when the user deletes the separate file STRASSE.md on the faithful filesystem (#736)", () => {
    const ledger = new UserLedger("windows");
    ledger.write({ hash: "xx", path: "Straße.md", at });
    ledger.deleted("STRASSE.md");
    ledger.renamed("Straße.md", "notes/f.md");
    ledger.replace("xx", "notes/f.md");
    expect(checkLostWrites("e1", ledger, new Set())).toEqual([]);
  });

  it("follows a write's file where the engine moved it, so overwriting it there replaces it", () => {
    const ledger = new UserLedger();
    ledger.write({ hash: "xx", path: "d.md", at });
    ledger.replace("xx", "A.md");
    expect(checkLostWrites("e1", ledger, new Set()).map((violation) => violation.invariant)).toEqual(["lost-write"]);
    ledger.fileMoved("d.md", "A.md");
    ledger.replace("xx", "A.md");
    expect(checkLostWrites("e1", ledger, new Set())).toEqual([]);
  });

  it("follows a write to the engine's conflict copy of its file once the user renames the copy, so overwriting the renamed copy replaces it", () => {
    const ledger = new UserLedger();
    ledger.write({ hash: "xx", path: "notes/c.md", at });
    ledger.forkCopy("notes/c.md", "notes/c (conflict e3 2026-01-02 030405).md");
    ledger.renamed("notes/c (conflict e3 2026-01-02 030405).md", "a.md");
    ledger.replace("xx", "b.md");
    expect(checkLostWrites("e1", ledger, new Set()).map((violation) => violation.invariant)).toEqual(["lost-write"]);
    ledger.replace("xx", "a.md");
    expect(checkLostWrites("e1", ledger, new Set())).toEqual([]);
  });

  it("forks to the engine's conflict copy only the writes whose file is at the original path when the copy is written, not one renamed away before (#761)", () => {
    const ledger = new UserLedger();
    ledger.write({ hash: "xx", path: "a.md", at });
    ledger.renamed("a.md", "z.md");
    // Another write of the same content at a.md, from which the engine writes its conflict copy.
    ledger.write({ hash: "xx", path: "a.md", at: "step 2" });
    const copy = "a (conflict e3 2026-01-02 030405).md";
    ledger.forkCopy("a.md", copy);
    ledger.replace("xx", copy);
    // z.md is lost: the user's overwrite of the copy replaced only the second write.
    expect(checkLostWrites("e1", ledger, new Set()).map((violation) => violation.detail)).toEqual([expect.stringContaining("e1's user wrote xx to a.md at step 1") as unknown as string]);
  });

  describe("given the engine's conflict copy of a user's file, which the user renamed after the file itself was deleted or renamed away (#745)", () => {
    const encode = (content: string) => new TextEncoder().encode(content);
    /** The user writes at `writtenAt` and renames the file to `original`, where the merge copies it. */
    const setup = async (original: string, writtenAt = original) => {
      const vault = new InMemoryVault();
      const ledger = new UserLedger();
      const user = new EngineUser({ name: "e5", vault, ledger, now: () => at, pathPool });
      await user.write(writtenAt, encode("mine"));
      if (writtenAt !== original) await user.rename(writtenAt, original);
      const copy = original.replace(/\.md$/u, " (conflict e5 2026-01-02 030405).md");
      // The merge keeps the user's content as the engine's conflict copy and the remote content at the file's path.
      await user.engineWrote(copy, () => vault.write(copy, encode("mine")));
      await vault.write(original, encode("theirs"));
      // Every content but the user's first one is still in the vault.
      const lost = () => checkLostWrites("e5", ledger, new Set(["theirs", "new"].map((content) => sha256Hex(encode(content))))).map((violation) => violation.detail);
      return { user, vault, copy, lost };
    };

    it("credits the user's overwrite of the renamed copy after the user deleted the original file (seed 100121)", async () => {
      const { user, copy, lost } = await setup("STRASSE.md");
      await user.remove("STRASSE.md");
      await user.rename(copy, "A.md");
      expect(lost()).toEqual([expect.stringContaining(`wrote ${sha256Hex(encode("mine")).slice(0, 8)} to STRASSE.md`) as unknown as string]);
      await user.write("A.md", encode("new"));
      expect(lost()).toEqual([]);
    });

    it("credits the user's overwrite of the renamed copy after the user renamed the original file away (seed 100106)", async () => {
      const { user, copy, lost } = await setup("b.md", "CON.md");
      await user.rename("b.md", "d.md");
      await user.rename(copy, "notes/c.md");
      await user.write("notes/c.md", encode("new"));
      expect(lost()).toEqual([]);
    });

    it("does not credit an overwrite of the renamed copy to a write the user made at the original path after the copy", async () => {
      const { user, vault, copy, lost } = await setup("b.md");
      // A later write of the same content at b.md, whose file is then lost without the user deleting it.
      await user.write("b.md", encode("mine"));
      await vault.delete("b.md");
      await user.rename(copy, "A.md");
      await user.write("A.md", encode("new"));
      expect(lost()).toHaveLength(1);
    });
  });

  it("follows a write's file through the user's renames: overwriting it at its new path replaces it", () => {
    const ledger = new UserLedger("macos");
    ledger.write({ hash: "xx", path: "a.md", at });
    ledger.renamed("a.md", "b.md");
    ledger.replace("xx", "B.md");
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
    replaced.replace("merged", "aa.md");
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
    ledger.replace("bb", "bb.md");
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
  const resurrections = (feed: FeedRevision[]) => checkResurrections(feed, new Set(["scripted"]), new Set(["engine"]), label).map((violation) => violation.detail);
  const deletedThenBack = (deviceId: string) => [revision({ deviceId: "scripted" }), revision({ seq: 2n, deleted: true, deviceId: "scripted", contentHash: "" }), revision({ seq: 3n, revisionId: "r3", contentHash: "bb", deviceId })];

  it("reports a document brought back by a device no client of the run uses, and ignores live revisions after live ones", () => {
    expect(resurrections(deletedThenBack("stranger"))).toEqual(["unknown device stranger brought back d1 at a.md (seq 3, r3) after its delete at a.md (seq 2) although no client of the run uses that device"]);
    expect(resurrections([revision({ deviceId: "stranger" }), revision({ seq: 2n, deviceId: "stranger" })])).toEqual([]);
  });

  it("leaves scripted clients' and engines' revisions to their judges", () => {
    expect(resurrections(deletedThenBack("scripted"))).toEqual([]);
    expect(resurrections(deletedThenBack("engine"))).toEqual([]);
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

  it("leaves scripted clients' and engines' tombstones to their judges", () => {
    const feed = [revision({}), revision({ seq: 2n, deleted: true, deviceId: "scripted" }), revision({ seq: 3n, deleted: true })];
    expect(checkPhantomDeletes(feed, new Set(["scripted"]), new Set(["engine"]), label)).toEqual([]);
  });

  it("reports a tombstone from a device no client of the run uses", () => {
    const violations = checkPhantomDeletes([revision({ deleted: true, deviceId: "stranger" })], new Set(["scripted"]), new Set(["engine"]), label);
    expect(violations.map((violation) => violation.invariant)).toEqual(["phantom-delete"]);
  });

  it("ignores live revisions", () => {
    expect(checkPhantomDeletes([revision({ deviceId: "stranger" })], new Set(), new Set(), label)).toEqual([]);
  });
});

describe("checkEngineEchoes", () => {
  it("accepts exactly the events a change of the user's emitted and reports every other one as the engine's own", () => {
    const user = [
      { type: "modify", path: "a.md" },
      { type: "rename", path: "c.md", oldPath: "a.md" },
    ] as const;
    const engine = [
      { type: "create", path: "b.md" },
      { type: "delete", path: "d.md" },
    ] as const;
    const reported = checkEngineEchoes("e1", [user[0], engine[0], user[1], engine[1]], new Set(user)).map((violation) => violation.detail);
    expect(reported).toEqual(["e1 reported its own create of b.md as a local change", "e1 reported its own delete of d.md as a local change"]);
  });

  it("reports an engine echo at a path the user changed earlier in the run: no path excuses another event", () => {
    const userWrite = { type: "modify", path: "a.md" } as const;
    const echo = { type: "modify", path: "a.md" } as const;
    expect(checkEngineEchoes("e1", [userWrite, echo], new Set([userWrite])).map((violation) => violation.detail)).toEqual(["e1 reported its own modify of a.md as a local change"]);
  });
});

describe("carriesLocalEdit", () => {
  const text = (value: string) => new TextEncoder().encode(value);

  it("accepts the local content itself, also binary", () => {
    expect(carriesLocalEdit(new Uint8Array([0xff, 0]), new Uint8Array([0xff, 0]), null)).toBe(true);
  });

  it("accepts a merged result that holds every line the local edit added over the base, whatever its line endings", () => {
    expect(carriesLocalEdit(text("a\nlocal\nb\n"), text("remote\r\na\r\nlocal\r\nb\r\n"), text("a\nb\n"))).toBe(true);
    // A local edit that only removed a line has nothing to carry.
    expect(carriesLocalEdit(text("a\n"), text("a\nb\nremote\n"), text("a\nb\n"))).toBe(true);
  });

  it("rejects a local line the merge joined to another line, which no line merge does (#750)", () => {
    // The local line `local` survives only as the tail of the remote's unterminated last line.
    expect(carriesLocalEdit(text("a\nb\nlocal\n"), text("a\nremote, unterminatedlocal\n"), text("a\nb\n"))).toBe(false);
    // Seed 100121: the local's unterminated last line with the remote's appended line run into it.
    expect(carriesLocalEdit(text("x\nlocal"), text("x\nlocalremote\n"), text("base\n"))).toBe(false);
    // The same merge with the lines kept apart carries the edit.
    expect(carriesLocalEdit(text("x\nlocal"), text("x\nlocal\nremote"), text("base\n"))).toBe(true);
  });

  it("accepts a correct merge in which the remote side deleted a line the local side kept", () => {
    expect(carriesLocalEdit(text("a\nb\nlocal\n"), text("a\nlocal\n"), text("a\nb\n"))).toBe(true);
  });

  it("rejects a result that dropped a line the local edit added: the remote content reported as merged", () => {
    expect(carriesLocalEdit(text("a\nlocal\n"), text("a\nremote\n"), text("a\n"))).toBe(false);
    // A line added a second time counts: the base holds it once.
    expect(carriesLocalEdit(text("a\na\n"), text("b\n"), text("a\n"))).toBe(false);
  });

  it("rejects a result that holds a short added line only within another line (#717)", () => {
    // `a`, `-` and `first` occur in the remote's text, but not as lines.
    expect(carriesLocalEdit(text("x\na\n"), text("x\nbanana\n"), text("x\n"))).toBe(false);
    expect(carriesLocalEdit(text("x\n-\n"), text("x\n- item\n"), text("x\n"))).toBe(false);
    expect(carriesLocalEdit(text("x\nfirst\n"), text("x\nfrom the first engine's user\n"), text("x\n"))).toBe(false);
  });

  it("needs each added line in the result as often as the local edit added it", () => {
    expect(carriesLocalEdit(text("x\n-\n-\n"), text("x\n-\nremote\n"), text("x\n"))).toBe(false);
    expect(carriesLocalEdit(text("x\n-\n-\n"), text("x\n-\n-\nremote\n"), text("x\n"))).toBe(true);
  });

  it("without a base, needs every local line in the result", () => {
    expect(carriesLocalEdit(text("a\nlocal\n"), text("a\n"), null)).toBe(false);
    expect(carriesLocalEdit(text("a\n"), text("remote\na\n"), null)).toBe(true);
    expect(carriesLocalEdit(text("a\nb\nlocal\n"), text("a\nlocal\n"), null)).toBe(false);
  });

  it("rejects any other result for binary local content", () => {
    expect(carriesLocalEdit(new Uint8Array([0xff]), new Uint8Array([0xff, 1]), null)).toBe(false);
  });
});

describe("KnownContents", () => {
  it("finds a content it was given by its SHA-256, and nothing else", () => {
    const known = new KnownContents();
    const content = new TextEncoder().encode("a\nb\n");
    known.add(content);
    // SHA-256 of "a\nb\n", computed independently (sha256sum).
    expect(known.get("911169ddaaf146aff539f58c26c489af3b892dff0fe283c1c264c65ae5aa59a2")).toEqual(content);
    expect(known.get(sha256Hex(new TextEncoder().encode("a\n")))).toBeNull();
  });
});

describe("lost-write of a merge the hook reports as merged (#717)", () => {
  const text = (value: string) => new TextEncoder().encode(value);
  /** The local write, then what the observer records of a merge of it into `result`; the lost-write violations, with only `result` surviving. */
  function lostWrites(local: Uint8Array, result: Uint8Array, base: Uint8Array | null): string[] {
    const ledger = new UserLedger();
    ledger.write({ hash: sha256Hex(local), path: "a.md", at });
    if (carriesLocalEdit(local, result, base)) ledger.merged(sha256Hex(local), sha256Hex(result));
    return checkLostWrites("e1", ledger, new Set([sha256Hex(result)])).map((violation) => violation.invariant);
  }

  it("reports a merge hook that drops a one-word local addition but reports it as merged", () => {
    const remote = text("x\nfrom the first engine's user\n");
    expect(lostWrites(text("x\nfirst\n"), remote, text("x\n"))).toEqual(["lost-write"]);
  });

  it("reports nothing for a correct merge where the remote deleted an unchanged line, with the base the device held", () => {
    const known = new KnownContents();
    const base = text("a\nb\n");
    known.add(base);
    // The hook did not read the base: the observer finds it by the journal's base hash.
    expect(lostWrites(text("a\nb\nlocal\n"), text("a\nlocal\n"), known.get(sha256Hex(base)))).toEqual([]);
  });
});
