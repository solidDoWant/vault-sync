import { describe, expect, it } from "vitest";

import type { PushSummary } from "./engine";
import { files, harness, type Harness } from "./testing";

// #862 item 2, the delete counterpart of #847 (blocked-holder-rename.test.ts):
// the user deletes a note's file and moves another note's file onto its
// synced path, while another device moves that other note to a revision this
// device cannot apply (too large, or unmaterializable here). The blocked note
// keeps its file at the deleted note's synced path (PO-11), and the delete
// leaves that path, so it is no claim on it: the delete is pushed, and the
// server's view converges (INV-8, INV-9).

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

const blockers = [
  { name: "too large", platform: "posix", path: "b.md", content: "x".repeat(40) },
  { name: "too large", platform: "macos", path: "b.md", content: "x".repeat(40) },
  { name: "too large", platform: "windows", path: "b.md", content: "x".repeat(40) },
  { name: "unmaterializable", platform: "windows", path: "ab:c.md", content: "x2\n" },
] as const;

describe.each(blockers)("SyncEngine with a local delete of a note whose synced path a blocked note's file holds (#862, $name, $platform rules)", ({ platform, path, content }) => {
  it("commits the delete, and the blocked note keeps its file", async () => {
    const h = harness({ merge: "default", pathRules: { platform }, maxDownloadBytes: 16 });
    h.server.commit({ documentId: "X", path: "a.md", content: "x\n" });
    h.server.commit({ documentId: "D", path: "d.md", content: "d\n" });
    await h.engine.pull();

    // The user deletes D's file and moves X's onto D's path; meanwhile another
    // device moves X to a revision this device cannot apply.
    await h.vault.delete("d.md");
    await h.vault.rename("a.md", "d.md");
    h.server.commit({ documentId: "X", path, content });
    await h.engine.pull();
    const pushes = await pushUntilQuiet(h);
    await h.engine.pull();

    // The delete reaches the server.
    expect(h.server.liveDocuments().has("d.md")).toBe(false);
    expect([...h.server.liveDocuments().values()]).not.toContain("D");
    expect(pushes.flatMap((summary) => summary.rejected)).toEqual([]);
    // X's revision waits for its blocker, and its file stays where the user moved it.
    expect((await h.journal.listDeferred()).map((deferred) => deferred.revision.documentId)).toEqual(["X"]);
    expect(await files(h.vault)).toEqual(new Map([["d.md", "x\n"]]));
  });
});
