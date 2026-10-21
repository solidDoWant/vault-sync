import { describe, expect, it } from "vitest";

import type { DocumentState, PendingOperation } from "../journal/journal";
import { InMemoryJournal } from "../journal/memory";
import type { FileStat } from "../vault/adapter";
import { posixPathRules, type PathRules } from "../vaultpath/platform";
import { PathClaims, type CopyNaming } from "./claims";
import { PathSpace } from "./pathspace";

const date = new Date(Date.UTC(2026, 9, 18, 4, 5, 6));
const stamp = "dev 2026-10-18 040506";

/** A vault that lists `files`, and stats `hidden` too (files outside the sync scope). */
function vault(files: string[], hidden: string[] = []) {
  return {
    list: () => Promise.resolve(files),
    stat: (path: string): Promise<FileStat | null> => Promise.resolve(files.includes(path) || hidden.includes(path) ? { size: 0, mtime: 0 } : null),
    isSynced: (path: string) => !hidden.includes(path),
  };
}

function documentState(documentId: string, path: string, deleted = false): DocumentState {
  return { documentId, path, revisionId: `r-${documentId}`, seq: 1n, baseHash: "", size: 0n, kind: "text", deleted };
}

function operation(documentId: string, path: string, deleted = false): PendingOperation {
  return { revisionId: `p-${documentId}-${path}`, documentId, baseRevisionId: "", path, contentHash: "", size: 0n, kind: "text", deleted };
}

interface Setup {
  rules?: PathRules;
  files?: string[];
  hidden?: string[];
  documents?: DocumentState[];
  deferred?: { documentId: string; path: string; deleted?: boolean }[];
  pending?: PendingOperation[];
  copies?: string[];
}

async function claims(setup: Setup): Promise<{ claims: PathClaims; naming: CopyNaming }> {
  const rules = setup.rules ?? posixPathRules;
  const journal = new InMemoryJournal();
  for (const state of setup.documents ?? []) await journal.putDocument(state);
  for (const { documentId, path, deleted } of setup.deferred ?? []) {
    await journal.putDeferred({
      revision: { documentId, revisionId: `d-${documentId}`, seq: 2n, parentRevisionId: "", path, contentHash: "", size: 0n, kind: "text", deleted: deleted ?? false },
      reason: "local-changes",
    });
  }
  for (const pending of setup.pending ?? []) await journal.addPending(pending);
  for (const [index, copyPath] of (setup.copies ?? []).entries()) {
    await journal.putConflict({ id: `c${String(index)}`, documentId: "logged", path: "x.md", reason: "concurrent-create", copyPath, copyHash: "", remoteRevisionId: "", at: 0 });
  }
  return {
    claims: await PathClaims.load(new PathSpace(rules), journal, vault(setup.files ?? [], setup.hidden)),
    naming: { deviceName: "dev", date, rules, maxAttempts: 100 },
  };
}

describe("PathClaims.freeCopyName", () => {
  it("names the copy next to the path when nothing holds the name", async () => {
    const { claims: table, naming } = await claims({ files: ["notes/Plan.md"] });
    expect(await table.freeCopyName("notes/Plan.md", naming)).toBe(`notes/Plan (conflict ${stamp}).md`);
  });

  const holders: [string, Setup][] = [
    ["a listed file", { files: [`Plan (conflict ${stamp}).md`] }],
    ["a live document", { documents: [documentState("a", `Plan (conflict ${stamp}).md`)] }],
    ["a deferred remote revision", { deferred: [{ documentId: "a", path: `Plan (conflict ${stamp}).md` }] }],
    ["a pending operation", { pending: [operation("a", `Plan (conflict ${stamp}).md`)] }],
    ["a logged conflict copy", { copies: [`Plan (conflict ${stamp}).md`] }],
    ["a listed file of another case, compared by path key on posix", { files: [`PLAN (CONFLICT ${stamp.toUpperCase()}).MD`] }],
    ["a listed file named like a folder of the name", { files: [`Plan (conflict ${stamp}).md/inner.md`] }],
  ];
  for (const [name, setup] of holders) {
    it(`adds a counter when ${name} holds the name`, async () => {
      const { claims: table, naming } = await claims(setup);
      expect(await table.freeCopyName("Plan.md", naming)).toBe(`Plan (conflict ${stamp} 2).md`);
    });
  }

  it("does not count deleted documents or deleted deferred revisions", async () => {
    const { claims: table, naming } = await claims({
      documents: [documentState("a", `Plan (conflict ${stamp}).md`, true)],
      deferred: [{ documentId: "b", path: `Plan (conflict ${stamp}).md`, deleted: true }],
    });
    expect(await table.freeCopyName("Plan.md", naming)).toBe(`Plan (conflict ${stamp}).md`);
  });

  it("compares listed files by the filesystem's name too: ı and I are one NTFS file with two path keys", async () => {
    const listed = [`ı (conflict ${stamp}).md`];
    const windows = await claims({ rules: { platform: "windows" }, files: listed });
    expect(await windows.claims.freeCopyName("I.md", windows.naming)).toBe(`I (conflict ${stamp} 2).md`);
    const posix = await claims({ files: listed });
    expect(await posix.claims.freeCopyName("I.md", posix.naming)).toBe(`I (conflict ${stamp}).md`);
  });

  it("skips a name a file outside the sync scope holds", async () => {
    const { claims: table, naming } = await claims({ hidden: [`Plan (conflict ${stamp}).md`] });
    expect(await table.freeCopyName("Plan.md", naming)).toBe(`Plan (conflict ${stamp} 2).md`);
  });

  it("returns null when no numbered name is free within the attempts", async () => {
    const { claims: table, naming } = await claims({ files: [`Plan (conflict ${stamp}).md`, `Plan (conflict ${stamp} 2).md`] });
    expect(await table.freeCopyName("Plan.md", { ...naming, maxAttempts: 2 })).toBeNull();
    expect(await table.freeCopyName("Plan.md", { ...naming, maxAttempts: 3 })).toBe(`Plan (conflict ${stamp} 3).md`);
  });

  describe("folder rule (#359)", () => {
    it("names a folder that a file holds by path key, keeping the path inside it", async () => {
      const { claims: table, naming } = await claims({ files: ["NOTES"] });
      expect(await table.freeCopyName("Notes/C.md", naming)).toBe(`Notes (conflict ${stamp})/C.md`);
    });

    it("names the outermost folder a document holds", async () => {
      const { claims: table, naming } = await claims({ documents: [documentState("a", "A"), documentState("b", "a/B")] });
      expect(await table.freeCopyName("a/b/c.md", naming)).toBe(`a (conflict ${stamp})/b/c.md`);
    });

    it("names the outermost folder also when an untracked file holds it and a deferred revision an inner one", async () => {
      const { claims: table, naming } = await claims({ files: ["A"], deferred: [{ documentId: "b", path: "a/B" }] });
      expect(await table.freeCopyName("a/b/c.md", naming)).toBe(`a (conflict ${stamp})/b/c.md`);
    });

    // PO-14 under F (#596): ı and the folder I are one name on NTFS and APFS, though their path keys differ.
    for (const platform of ["windows", "macos"] as const) {
      it(`names a folder a listed file holds only under the filesystem's equivalence (${platform}, ı and I/)`, async () => {
        const { claims: table, naming } = await claims({ rules: { platform }, files: ["ı"] });
        expect(await table.freeCopyName("I/c.md", naming)).toBe(`I (conflict ${stamp})/c.md`);
      });

      it(`names the outermost folder when a listed file holds it under F and a document an inner one under K (${platform})`, async () => {
        const { claims: table, naming } = await claims({ rules: { platform }, files: ["ı"], documents: [documentState("b", "I/B")] });
        expect(await table.freeCopyName("I/b/c.md", naming)).toBe(`I (conflict ${stamp})/b/c.md`);
      });
    }

    it("keeps the path's folders where no equivalence joins them to a listed file (posix, ı and I/)", async () => {
      const { claims: table, naming } = await claims({ files: ["ı"] });
      expect(await table.freeCopyName("I/c.md", naming)).toBe(`I/c (conflict ${stamp}).md`);
    });

    it("does not let a pending operation's path hold a folder", async () => {
      const { claims: table, naming } = await claims({ pending: [operation("a", "notes", true)] });
      expect(await table.freeCopyName("notes/c.md", naming)).toBe(`notes/c (conflict ${stamp}).md`);
    });
  });

  describe("exempt document", () => {
    // A remote rename of the previous copy `Plan (conflict …).md` back to
    // `Plan.md`, where a file is in the way: the copy of that file may take
    // the name the merged document vacates.
    it("lets the file the operation moves away from take no name (#319)", async () => {
      const vacated = `Plan (conflict ${stamp}).md`;
      const { claims: table, naming } = await claims({ files: [vacated, "Plan.md"] });
      expect(await table.freeCopyName("Plan.md", naming, { documentId: "moved", file: vacated, result: "Plan.md" })).toBe(vacated);
      expect(await table.freeCopyName("Plan.md", naming, { documentId: "moved", file: undefined, result: "Plan.md" })).toBe(`Plan (conflict ${stamp} 2).md`);
    });

    it("lets its synced path take no name where its result does not go (#299)", async () => {
      const vacated = `Plan (conflict ${stamp}).md`;
      const { claims: table, naming } = await claims({ documents: [documentState("moved", vacated)] });
      expect(await table.freeCopyName("Plan.md", naming, { documentId: "moved", file: undefined, result: "Plan.md" })).toBe(vacated);
      expect(await table.freeCopyName("Plan.md", naming, { documentId: "moved", file: undefined, result: null })).toBe(vacated);
      expect(await table.freeCopyName("Plan.md", naming)).toBe(`Plan (conflict ${stamp} 2).md`);
    });

    it("keeps its synced path claimed when its result goes there", async () => {
      const { claims: table, naming } = await claims({ documents: [documentState("merged", `PLAN (CONFLICT ${stamp.toUpperCase()}).MD`)] });
      const exempt = { documentId: "merged", file: undefined, result: `Plan (conflict ${stamp}).md` };
      expect(await table.freeCopyName("Plan.md", naming, exempt)).toBe(`Plan (conflict ${stamp} 2).md`);
    });

    it("lets no file block a folder of its result (#352)", async () => {
      const { claims: table, naming } = await claims({ files: ["NOTES", "notes/f.md"] });
      const exempt = { documentId: "merged", file: undefined, result: "notes/f.md" };
      expect(await table.freeCopyName("notes/f.md", naming, exempt)).toBe(`notes/f (conflict ${stamp}).md`);
      expect(await table.freeCopyName("notes/f.md", naming)).toBe(`notes (conflict ${stamp})/f.md`);
    });

    it("exempts nothing of another document", async () => {
      const { claims: table, naming } = await claims({ documents: [documentState("other", `Plan (conflict ${stamp}).md`)] });
      const exempt = { documentId: "merged", file: undefined, result: "elsewhere.md" };
      expect(await table.freeCopyName("Plan.md", naming, exempt)).toBe(`Plan (conflict ${stamp} 2).md`);
    });
  });
});

describe("PathClaims.collisions", () => {
  it("lists every claim colliding by path key, folders included, with its kind and document", async () => {
    const { claims: table } = await claims({
      files: ["Notes/c.md", "other.md"],
      documents: [documentState("a", "NOTES/C.md"), documentState("b", "elsewhere.md")],
      deferred: [{ documentId: "c", path: "notes" }],
      pending: [operation("d", "notes/C.md/x.md")],
      copies: ["NOTES/c.MD"],
    });
    expect(table.collisions("notes/c.md", "server")).toEqual([
      { kind: "disk", path: "Notes/c.md" },
      { kind: "server-known", path: "NOTES/C.md", documentId: "a" },
      { kind: "server-newer", path: "notes", documentId: "c" },
      { kind: "outgoing", path: "notes/C.md/x.md", documentId: "d" },
      { kind: "reserved", path: "NOTES/c.MD", documentId: "logged" },
    ]);
  });

  it("compares by spelling on posix under the file equivalence", async () => {
    const { claims: table } = await claims({ files: ["Notes/c.md", "notes/c.md"] });
    expect(table.collisions("notes/c.md", "file")).toEqual([{ kind: "disk", path: "notes/c.md" }]);
  });
});
