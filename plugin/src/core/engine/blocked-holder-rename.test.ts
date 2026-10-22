import { describe, expect, it } from "vitest";

import type { PushSummary } from "./engine";
import { files, harness, type Harness } from "./testing";

// A note's local rename away from its synced path, while another note whose
// own newest revision is blocked (too large, or unmaterializable here) still
// has its file at that path (#847, from simulation seed 100196). The blocked
// note keeps its file (PO-11 only says it must not keep a server claim off
// the path), and the local rename is no claim on the path it leaves: it is
// pushed, so the server's view converges (INV-8, INV-9).

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

describe.each(blockers)("SyncEngine with a local rename away from a path a blocked note's file holds (#847, $name, $platform rules)", ({ platform, path, content }) => {
  it("commits the rename, and the blocked note keeps its file", async () => {
    const h = harness({ merge: "default", pathRules: { platform }, maxDownloadBytes: 16 });
    h.server.commit({ documentId: "X", path: "a.md", content: "x\n" });
    h.server.commit({ documentId: "D", path: "d.md", content: "d\n" });
    await h.engine.pull();

    // The user moves D's file and edits X's; meanwhile another device moves X to a path
    // this device cannot hold, and D onto X's old path.
    await h.vault.rename("d.md", "e.md");
    await h.vault.write("a.md", new TextEncoder().encode("x edited\n"));
    h.server.commit({ documentId: "X", path, content });
    h.server.commit({ documentId: "D", path: "a.md", content: "d\n" });
    await h.engine.pull();
    const pushes = await pushUntilQuiet(h);
    await h.engine.pull();

    // The local rename wins (PO-9) and reaches the server.
    expect(h.server.liveDocuments().get("e.md")).toBe("D");
    expect(h.server.liveDocuments().has("a.md")).toBe(false);
    expect(await h.journal.listPending()).toEqual([]);
    expect(pushes.flatMap((summary) => summary.rejected)).toEqual([]);
    // X's revision waits for its blocker, and its file stays where it was.
    expect((await h.journal.listDeferred()).map((deferred) => deferred.revision.documentId)).toEqual(["X"]);
    expect(await files(h.vault)).toEqual(new Map([["a.md", "x edited\n"], ["e.md", "d\n"]]));
  });
});
