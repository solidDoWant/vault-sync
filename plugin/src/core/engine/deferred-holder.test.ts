import { describe, expect, it } from "vitest";

import type { PushSummary } from "./engine";
import { threeWayMerge, type MergeHook } from "./merge";
import { files, harness, newestServerClaims, type Harness } from "./testing";

// Another document arrives at the synced path of a note whose own remote move
// the merge path holds, after the user deleted the note's file (#379, from
// simulation seed 1004): the path is still the held note's in the journal.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string) => encoder.encode(value);

/** Pushes until a push commits nothing, at most `limit` times. */
async function pushUntilQuiet(h: Harness, limit = 5): Promise<PushSummary[]> {
  const summaries: PushSummary[] = [];
  for (let push = 0; push < limit; push++) {
    const summary = await h.engine.push();
    summaries.push(summary);
    if (summary.committed === 0 && summary.conflicts === 0) break;
  }
  return summaries;
}

describe.each(["posix", "macos", "windows"] as const)("SyncEngine with a new document at a held note's synced path (#379, %s rules)", (platform) => {
  it("applies the new document only once the held note moved away, and converges", async () => {
    // The merge path holds note A's remote revisions until `hold` is lifted.
    let hold = true;
    const merge: MergeHook = (request) => (hold && request.remote.documentId === "A" ? Promise.resolve({ status: "deferred" }) : threeWayMerge(request));
    const h = harness({ merge, pathRules: { platform } });
    h.server.commit({ documentId: "A", path: "x.md", content: "a\n" });
    await h.engine.pull();

    // The user edits x.md while another device moves A to y.md: deferred.
    await h.vault.write("x.md", bytes("mine\n"));
    h.server.commit({ documentId: "A", path: "y.md", content: "a\n" });
    await h.engine.pull();
    expect((await h.journal.listDeferred()).map((deferred) => deferred.revision.documentId)).toEqual(["A"]);

    // The user deletes the file, and another device creates C at x.md.
    await h.vault.delete("x.md");
    h.server.commit({ documentId: "C", path: "x.md", content: "c\n" });
    await h.engine.pull();
    // The journal never holds two live documents at one path.
    const live = (await newestServerClaims(h.journal)).map(([, path]) => path.toLowerCase());
    expect(new Set(live).size).toBe(live.length);

    // The merge path lets A go, and another device moves C on.
    hold = false;
    const pushes = await pushUntilQuiet(h);
    h.server.commit({ documentId: "C", path: "z.md", content: "c\n" });
    await h.engine.pull();
    pushes.push(...(await pushUntilQuiet(h)));
    await h.engine.pull();

    const documents = h.server.liveDocuments();
    expect(documents.get("z.md")).toBe("C");
    expect(h.server.liveFiles().get("z.md")).toBe("c\n");
    // C's content never became A's, and C was never deleted.
    expect(h.server.history("A").map((revision) => decoder.decode(h.server.contentOf(revision)))).not.toContain("c\n");
    expect(h.server.history("C").every((revision) => !revision.deleted)).toBe(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.journal.listDeferred()).toEqual([]);
    expect(await h.journal.listPending()).toEqual([]);
    expect(pushes.flatMap((summary) => summary.rejected)).toEqual([]);
  });
});

// The same, but the held note's own remote move waits for a reason no pull
// or push retries: its new path is outside what this device syncs, or the
// revision is over the download cap. The note gives up its claim on the path
// its file was deleted from, so the new document is written there, and the
// note comes back on its own once its revision applies (#379 review).
describe.each(["posix", "macos", "windows"] as const)("SyncEngine with a new document at the deleted path of a note waiting for a reason no pull retries (#379, %s rules)", (platform) => {
  /** Pulls and pushes until quiet, and returns every rejected operation. */
  async function sync(h: Harness): Promise<PushSummary["rejected"]> {
    await h.engine.pull();
    const pushes = await pushUntilQuiet(h);
    await h.engine.pull();
    pushes.push(...(await pushUntilQuiet(h)));
    await h.engine.pull();
    return pushes.flatMap((summary) => summary.rejected);
  }

  async function expectOneDocumentPerPath(h: Harness): Promise<void> {
    const live = (await newestServerClaims(h.journal)).map(([, path]) => path.toLowerCase());
    expect(new Set(live).size).toBe(live.length);
  }

  async function expectConverged(h: Harness): Promise<void> {
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.journal.listDeferred()).toEqual([]);
    expect(await h.journal.listPending()).toEqual([]);
    // C's content never became A's, and C was never deleted.
    expect(h.server.history("A").map((revision) => decoder.decode(h.server.contentOf(revision)))).not.toContain("c\n");
    expect(h.server.history("C").every((revision) => !revision.deleted)).toBe(true);
    await expectOneDocumentPerPath(h);
  }

  it("writes the new document when the note moved out of scope, and the note once it is back in scope", async () => {
    let configSync = false;
    const h = harness({
      merge: threeWayMerge,
      pathRules: { platform },
      wrapVault: (vault) => Object.assign(Object.create(vault) as typeof vault, { isSynced: (path: string) => configSync || !path.startsWith(".obsidian/") }),
    });
    h.server.commit({ documentId: "A", path: "x.md", content: "a\n" });
    await h.engine.pull();

    // Another device moves A into the config folder, which this device does not sync.
    h.server.commit({ documentId: "A", path: ".obsidian/y.md", content: "a\n" });
    await h.engine.pull();
    expect((await h.journal.listDeferred()).map((deferred) => [deferred.revision.documentId, deferred.reason])).toEqual([["A", "out-of-scope"]]);

    // The user deletes x.md, and another device creates C there.
    await h.vault.delete("x.md");
    h.server.commit({ documentId: "C", path: "x.md", content: "c\n" });
    expect(await sync(h)).toEqual([]);

    expect(await files(h.vault)).toEqual(new Map([["x.md", "c\n"]]));
    expect((await h.journal.listDeferred()).map((deferred) => [deferred.revision.documentId, deferred.reason])).toEqual([["A", "out-of-scope"]]);
    expect(await h.journal.listPending()).toEqual([]);
    await expectOneDocumentPerPath(h);

    // Config sync is turned on: A comes back at its own path.
    configSync = true;
    h.restart();
    expect(await sync(h)).toEqual([]);
    expect(await files(h.vault)).toEqual(new Map([[".obsidian/y.md", "a\n"], ["x.md", "c\n"]]));
    await expectConverged(h);
  });

  it("writes the new document when the note's move is over the download cap, and the note once a revision fits", async () => {
    const h = harness({ merge: threeWayMerge, pathRules: { platform }, maxDownloadBytes: 10 });
    h.server.commit({ documentId: "A", path: "x.md", content: "a\n" });
    await h.engine.pull();

    // Another device moves A and makes it larger than this device downloads.
    h.server.commit({ documentId: "A", path: "y.md", content: "a, and a lot more\n" });
    await h.engine.pull();
    expect((await h.journal.listDeferred()).map((deferred) => [deferred.revision.documentId, deferred.reason])).toEqual([["A", "too-large"]]);

    // The user deletes x.md, and another device creates C there.
    await h.vault.delete("x.md");
    h.server.commit({ documentId: "C", path: "x.md", content: "c\n" });
    expect(await sync(h)).toEqual([]);

    expect(await files(h.vault)).toEqual(new Map([["x.md", "c\n"]]));
    expect((await h.journal.listDeferred()).map((deferred) => [deferred.revision.documentId, deferred.reason])).toEqual([["A", "too-large"]]);
    expect(await h.journal.listPending()).toEqual([]);
    await expectOneDocumentPerPath(h);

    // Another device shortens A: it fits now, and comes back at its own path.
    h.server.commit({ documentId: "A", path: "y.md", content: "a2\n" });
    expect(await sync(h)).toEqual([]);
    expect(await files(h.vault)).toEqual(new Map([["x.md", "c\n"], ["y.md", "a2\n"]]));
    await expectConverged(h);
  });

  // The user renames the note's file instead of deleting it. The rename waits
  // with the note, so the server never hears of it while the note waits, and
  // nothing retries the note's revision: the note follows its file to its new
  // path, so the new document is written at the path the file left, and the
  // note's revision then applies to the file where it is (#379 review 2).
  it("writes the new document at the path a local rename moved the out-of-scope note's file from, and keeps one note", async () => {
    let configSync = false;
    const h = harness({
      merge: threeWayMerge,
      pathRules: { platform },
      wrapVault: (vault) => Object.assign(Object.create(vault) as typeof vault, { isSynced: (path: string) => configSync || !path.startsWith(".obsidian/") }),
    });
    h.server.commit({ documentId: "A", path: "x.md", content: "a\n" });
    await h.engine.pull();

    h.server.commit({ documentId: "A", path: ".obsidian/y.md", content: "a\n" });
    await h.engine.pull();
    expect((await h.journal.listDeferred()).map((deferred) => [deferred.revision.documentId, deferred.reason])).toEqual([["A", "out-of-scope"]]);

    // The user renames x.md to w.md, and another device creates C at x.md.
    await h.vault.rename("x.md", "w.md");
    h.server.commit({ documentId: "C", path: "x.md", content: "c\n" });
    expect(await sync(h)).toEqual([]);

    expect(await files(h.vault)).toEqual(new Map([["w.md", "a\n"], ["x.md", "c\n"]]));
    expect((await h.journal.listDeferred()).map((deferred) => [deferred.revision.documentId, deferred.reason])).toEqual([["A", "out-of-scope"]]);
    expect(await h.journal.listPending()).toEqual([]);
    expect((await h.journal.getDocument("A"))?.binding?.spelling).toBe("w.md");
    await expectOneDocumentPerPath(h);

    // Config sync is turned on: A's move applies to its file at w.md.
    configSync = true;
    h.restart();
    expect(await sync(h)).toEqual([]);
    expect(await files(h.vault)).toEqual(new Map([[".obsidian/y.md", "a\n"], ["x.md", "c\n"]]));
    // One document per note: the renamed file never became a new one.
    expect(h.server.liveDocuments()).toEqual(new Map([[".obsidian/y.md", "A"], ["x.md", "C"]]));
    await expectConverged(h);
  });

  it("writes the new document at the path a local rename moved the out-of-scope note's file from, out of scope too, and loses nothing", async () => {
    let configSync = false;
    const h = harness({
      merge: threeWayMerge,
      pathRules: { platform },
      wrapVault: (vault) => Object.assign(Object.create(vault) as typeof vault, { isSynced: (path: string) => configSync || !path.startsWith(".obsidian/") }),
    });
    h.server.commit({ documentId: "A", path: "x.md", content: "a\n" });
    await h.engine.pull();
    h.server.commit({ documentId: "A", path: ".obsidian/y.md", content: "a\n" });
    await h.engine.pull();

    // The user moves x.md into the config folder too, where the note cannot follow it, and another device creates C at x.md.
    await h.vault.rename("x.md", ".obsidian/w.md");
    h.server.commit({ documentId: "C", path: "x.md", content: "c\n" });
    expect(await sync(h)).toEqual([]);
    expect(await files(h.vault)).toEqual(new Map([[".obsidian/w.md", "a\n"], ["x.md", "c\n"]]));
    expect((await h.journal.listDeferred()).map((deferred) => [deferred.revision.documentId, deferred.reason])).toEqual([["A", "out-of-scope"]]);
    await expectOneDocumentPerPath(h);

    // Config sync is turned on: A comes back at its own path, and the moved file is a new document.
    configSync = true;
    h.restart();
    expect(await sync(h)).toEqual([]);
    expect(await files(h.vault)).toEqual(new Map([[".obsidian/w.md", "a\n"], [".obsidian/y.md", "a\n"], ["x.md", "c\n"]]));
    await expectConverged(h);
  });

  it("writes the new document at the path a local rename moved the too-large note's file from, and keeps one note", async () => {
    const h = harness({ merge: threeWayMerge, pathRules: { platform }, maxDownloadBytes: 10 });
    h.server.commit({ documentId: "A", path: "x.md", content: "a\n" });
    await h.engine.pull();

    h.server.commit({ documentId: "A", path: "y.md", content: "a, and a lot more\n" });
    await h.engine.pull();
    expect((await h.journal.listDeferred()).map((deferred) => [deferred.revision.documentId, deferred.reason])).toEqual([["A", "too-large"]]);

    // The user renames x.md to w.md, and another device creates C at x.md.
    await h.vault.rename("x.md", "w.md");
    h.server.commit({ documentId: "C", path: "x.md", content: "c\n" });
    expect(await sync(h)).toEqual([]);

    expect(await files(h.vault)).toEqual(new Map([["w.md", "a\n"], ["x.md", "c\n"]]));
    expect((await h.journal.listDeferred()).map((deferred) => [deferred.revision.documentId, deferred.reason])).toEqual([["A", "too-large"]]);
    expect(await h.journal.listPending()).toEqual([]);
    expect((await h.journal.getDocument("A"))?.binding?.spelling).toBe("w.md");
    await expectOneDocumentPerPath(h);

    // The file at x.md is C's own, which no local rename moved: the user's edit of it is C's, and pushed.
    await h.vault.write("x.md", bytes("c2\n"));
    expect(await sync(h)).toEqual([]);
    expect(h.server.liveFiles()).toEqual(new Map([["y.md", "a, and a lot more\n"], ["x.md", "c2\n"]]));

    // Another device shortens A: it fits now, and applies to its file at w.md.
    h.server.commit({ documentId: "A", path: "y.md", content: "a2\n" });
    expect(await sync(h)).toEqual([]);
    expect(await files(h.vault)).toEqual(new Map([["x.md", "c2\n"], ["y.md", "a2\n"]]));
    expect(h.server.liveDocuments()).toEqual(new Map([["x.md", "C"], ["y.md", "A"]]));
    await expectConverged(h);
  });
});
