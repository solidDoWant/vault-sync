import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import type { CommitRevisionRequest } from "../../gen/vaultsync/v1/sync_pb";
import type { PushSummary } from "./engine";
import { files, harness, type Harness } from "./testing";

// #862 item 1: a document whose bound file sits at another busy document's
// claim waits instead of pushing (design §6.2, amended for #847). Here the
// claim is the synced path of a document whose rename away is still pending:
// the server has that document there, so a rename onto the path would be
// refused (C3) and sent to a conflict copy, though the path is free as soon
// as the pending rename commits.

const decoder = new TextDecoder();

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

describe("SyncEngine with a local rename onto the synced path of a document whose own rename away is pending (#862)", () => {
  it("waits for that rename, then commits its own rename onto the path without a conflict", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "X", path: "a.md", content: "x\n" });
    h.server.commit({ documentId: "D", path: "d.md", content: "d\n" });
    await h.engine.pull();

    // X's commits are refused for now, so its rename away from a.md stays pending.
    let refuseX = true;
    const commits: string[] = [];
    h.server.interceptor = (method, request) => {
      if (method !== "CommitRevision") return;
      const commit = request as CommitRevisionRequest;
      commits.push(`${commit.documentId}:${decoder.decode(commit.path)}`);
      if (refuseX && commit.documentId === "X") throw new ConnectError("unavailable", Code.InvalidArgument);
    };
    await h.vault.rename("a.md", "b.md");
    await h.engine.push();
    expect(await h.journal.listPending()).toHaveLength(1);

    // The user moves D's file onto a.md, where the server still has X.
    await h.vault.rename("d.md", "a.md");
    commits.length = 0;
    const waiting = await h.engine.push();

    // D's rename waits for X's: it is never sent while X holds a.md on the server.
    expect(commits.filter((commit) => commit.startsWith("D:"))).toEqual([]);
    expect(waiting.conflicts).toBe(0);
    expect(h.server.liveDocuments()).toEqual(new Map([["a.md", "X"], ["d.md", "D"]]));

    refuseX = false;
    const pushes = await pushUntilQuiet(h);

    // Both renames reach the server, with no conflict copy and nothing rejected.
    expect(h.server.liveDocuments()).toEqual(new Map([["b.md", "X"], ["a.md", "D"]]));
    expect(pushes.reduce((total, summary) => total + summary.conflicts, 0)).toBe(0);
    expect(pushes.flatMap((summary) => summary.rejected)).toEqual([]);
    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.listConflicts()).toEqual([]);
    expect(await files(h.vault)).toEqual(new Map([["a.md", "d\n"], ["b.md", "x\n"]]));
  });
});
