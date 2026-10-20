import { describe, expect, it } from "vitest";

import type { PushSummary } from "./engine";
import { threeWayMerge, type MergeHook } from "./merge";
import { files, harness, type Harness } from "./testing";

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
    const live = (await h.journal.listDocuments()).filter((state) => !state.deleted).map((state) => state.path.toLowerCase());
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
