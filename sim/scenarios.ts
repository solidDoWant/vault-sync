// Scripted scenarios: hand-written interleavings that random schedules hit
// only rarely, driven step by step against the real server.

import { SimRun, type RunResult, type SimEndpoints } from "./runner";

export interface LostResponseResult extends RunResult {
  /** Label of the revision whose first response was lost. */
  retried: string;
  /** Labels of the revisions acknowledged to each client, in order. */
  acknowledgedBy: string[][];
}

/**
 * The lost-response interleaving from #12 (SPEC.md §6.2): the server applies
 * c0's commit A but the response is lost; c1 pulls and commits on top of A,
 * moving the head; c0 then retries A with the same revision id. The retry must
 * return A itself, not FAILED_PRECONDITION.
 */
export async function lostResponseAfterHeadMoved(endpoints: SimEndpoints): Promise<LostResponseResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 2 });
  const operation = async (client: number, kind: "create" | "edit" | "pull", arg = 1) => {
    await run.step({ kind: "operation", client, operation: kind, arg });
    await run.drain(client);
  };

  await operation(0, "pull");
  await operation(0, "create");
  await operation(1, "pull");

  // c0 edits the document: deliver its blob upload, then its commit.
  await run.step({ kind: "operation", client: 0, operation: "edit", arg: 2 });
  for (let delivery = 0; run.context.network.pendingRequest(0) !== "CommitRevision"; delivery++) {
    if (delivery > 100) throw new Error("c0 never sent CommitRevision");
    await run.step({ kind: "deliver-request", client: 0 });
    await run.step({ kind: "deliver-response", client: 0 });
  }
  await run.step({ kind: "deliver-request", client: 0 });
  const retried = lastCommitRevisionLabel(run);
  // The server has applied it; the response is lost, and c0 queues a retry
  // with the same revision id.
  await run.step({ kind: "drop-response", pick: 0 });

  // c1 learns about c0's revision and commits on top of it.
  await operation(1, "pull");
  await operation(1, "edit", 3);

  // Only now does c0's retry reach the server.
  await run.drain(0);

  const result = await run.finish();
  const acknowledgedBy = [0, 1].map((client) =>
    result.acknowledged.filter((acknowledgement) => acknowledgement.client === client).map((acknowledgement) => run.context.ids.label(acknowledgement.revisionId)),
  );
  return { ...result, retried, acknowledgedBy };
}

/** The label of the revision in the newest CommitRevision c0 sent, read from the trace. */
function lastCommitRevisionLabel(run: SimRun): string {
  const entry = [...run.trace].reverse().find((line) => line.includes("c0 CommitRevision("));
  const label = /c0 CommitRevision\(\S+ (\S+) /.exec(entry ?? "")?.[1];
  if (label === undefined) throw new Error("no CommitRevision from c0 in the trace");
  return label;
}
