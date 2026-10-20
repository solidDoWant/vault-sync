import { describe, expect, it } from "vitest";

import type { PathRules } from "../vaultpath/platform";
import type { PushSummary } from "./engine";
import { files, harness, type Harness } from "./testing";

// A remote rename of a note onto a file named like the note's local folder
// by path key (Notes/C.md renamed to NOTES), while the user edited the note
// (#359). Path keys ignore case on every platform, so every name in Notes/
// is under the file NOTES the merge result goes to: the local edit's
// conflict copy has to go under a conflict-named folder instead.

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

const platforms: PathRules["platform"][] = ["posix", "macos", "windows"];

describe("SyncEngine with a remote rename onto a file named like the local file's folder (#359)", () => {
  for (const platform of platforms) {
    it(`keeps the remote version at NOTES and the local edit under a conflict-named folder, nothing deferred (${platform})`, async () => {
      const h = harness({ merge: "default", pathRules: { platform } });
      h.server.commit({ documentId: "N", path: "Notes/C.md", content: "base\n" });
      await h.engine.pull();
      await h.vault.write("Notes/C.md", bytes("mine\n"));
      h.server.commit({ documentId: "N", path: "NOTES", content: "theirs\n" });

      await h.engine.pull();
      const first = await pushUntilQuiet(h);
      await h.engine.pull();
      const second = await pushUntilQuiet(h);

      const live = h.server.liveFiles();
      // Exactly two live files: no duplicate copies of the local version.
      expect([...live.values()].sort()).toEqual(["mine\n", "theirs\n"]);
      expect(live.get("NOTES")).toBe("theirs\n");
      expect(h.server.liveDocuments().get("NOTES")).toBe("N");
      const copyPath = [...live].find(([, value]) => value === "mine\n")?.[0] ?? "";
      expect(copyPath).toMatch(/^Notes \(conflict .*\)\/C\.md$/);
      expect((await h.journal.listConflicts()).map((record) => [record.reason, record.path, record.copyPath])).toEqual([["overlapping-edits", "NOTES", copyPath]]);
      expect(await files(h.vault)).toEqual(live);
      expect(await h.journal.listDeferred()).toEqual([]);
      expect(await h.journal.listPending()).toEqual([]);
      expect([...first, ...second].flatMap((summary) => summary.rejected)).toEqual([]);
      // Nothing more to do: a further push commits nothing.
      const last = await h.engine.push();
      expect([last.committed, last.conflicts]).toEqual([0, 0]);
      expect(h.server.liveFiles()).toEqual(live);
    });
  }
});
