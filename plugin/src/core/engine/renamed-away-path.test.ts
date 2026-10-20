import { describe, expect, it } from "vitest";

import type { PushSummary } from "./engine";
import { files, harness, type Harness } from "./testing";

// A new file at the synced path a local rename moved a note away from, while
// another device renamed and edited the note (#352, POSIX rules, where a file
// NOTES and a folder notes/ can coexist).

const encoder = new TextEncoder();
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

describe("SyncEngine with a new file at a renamed-away note's synced path (#352)", () => {
  it("syncs the new file and the local edit, and lands the remote rename", async () => {
    const h = harness({ merge: "default", pathRules: { platform: "posix" } });
    h.server.commit({ documentId: "N", path: "NOTES", content: "base\n" });
    await h.engine.pull();
    await h.vault.rename("NOTES", "notes/f.md");
    await h.vault.write("notes/f.md", bytes("mine\n"));
    await h.vault.write("NOTES", bytes("other\n"));
    h.server.commit({ documentId: "N", path: "notes/c.md", content: "theirs\n" });

    await h.engine.pull();
    const first = await pushUntilQuiet(h);
    await h.engine.pull();
    const second = await pushUntilQuiet(h);

    const live = h.server.liveFiles();
    expect([...live.values()].sort()).toEqual(["mine\n", "other\n", "theirs\n"]);
    const documents = h.server.liveDocuments();
    const pathOf = (content: string) => [...live].find(([, value]) => value === content)?.[0] ?? "";
    // The local rename wins, so the note stays at notes/f.md with the remote
    // edit, and the local edit is its conflict copy in notes/.
    expect(pathOf("theirs\n")).toBe("notes/f.md");
    expect(documents.get("notes/f.md")).toBe("N");
    expect(pathOf("mine\n")).toMatch(/^notes\/f \(conflict .*\)\.md$/);
    // The server takes NOTES and notes/ for one path (SPEC.md §5), so the new
    // file is its own document at a path-taken copy of NOTES.
    expect(pathOf("other\n")).toMatch(/^NOTES \(conflict .*\)$/);
    expect(documents.get(pathOf("other\n"))).not.toBe("N");
    expect((await h.journal.listConflicts()).map((record) => [record.reason, record.copyPath]).sort()).toEqual([
      ["overlapping-edits", pathOf("mine\n")],
      ["path-taken", pathOf("other\n")],
    ]);
    expect(h.server.history("N").every((revision) => !revision.deleted)).toBe(true);
    expect(await files(h.vault)).toEqual(live);
    expect(await h.journal.listDeferred()).toEqual([]);
    expect(await h.journal.listPending()).toEqual([]);
    expect([...first, ...second].flatMap((summary) => summary.rejected)).toEqual([]);
  });
});
