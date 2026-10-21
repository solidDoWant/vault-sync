// Scripted multi-user scenarios (#35): a member's role changes while its
// calls are in flight, under faults. The seeded members suite meets these
// interleavings only by chance; here each one happens exactly once.

import { Code } from "@connectrpc/connect";

import { serverFeed } from "./invariants";
import { SimRun, type RunResult, type SimEndpoints } from "./runner";

export interface MembershipChangesResult extends RunResult {
  /** The member's commit the server applied before its demotion, whose response was lost. */
  appliedBeforeDemotion: string;
  /** Whether that revision is in the server's change feed after the run. */
  appliedKept: boolean;
  /** The outcomes, as the trace shows them, of the member's calls that reached the server while it was a viewer or removed. */
  refusedWhileViewer: string[];
  refusedWhileRemoved: string[];
  /** The member's acknowledged revisions, and those of them in the feed after the run. */
  memberAcknowledged: string[];
  memberAcknowledgedKept: string[];
  /** Documents the owner created while the member was removed, and those of them the member's client knew of when it was let back in. */
  createdWhileRemoved: string[];
  knownWhenLetBackIn: string[];
  /** The documents the member's client knows at the end. */
  knownAtEnd: string[];
}

/**
 * Two users: the owner (scripted client c0 and engine e2) and a member u1
 * (scripted client c1), who joined as an editor.
 *
 * 1. c1 creates a note (acknowledged) and edits it; the server applies the
 *    edit, but the response is lost. The owner demotes u1 to viewer, and
 *    c1's retry with the same revision id reaches the server: it must be
 *    refused (PERMISSION_DENIED), and the applied edit must stay.
 * 2. As a viewer, c1 still pulls, but its new note's upload is refused.
 * 3. The owner makes u1 an editor again. c1 starts an edit, and its
 *    CommitRevision is in flight when the owner removes u1: when it reaches
 *    the server it must be refused (NOT_FOUND).
 * 4. While u1 is removed the owner creates two notes. c1's pulls must get
 *    nothing.
 * 5. The owner invites u1 again, as an editor. c1 catches up and edits,
 *    and the run ends with no violation.
 */
export async function membershipChanges(endpoints: SimEndpoints): Promise<MembershipChangesResult> {
  const run = await SimRun.start(endpoints, { seed: 35, clients: 2, engines: 1, users: 2, platforms: ["posix"] });
  const network = run.context.network;
  const operation = async (client: number, kind: "create" | "edit" | "pull", arg = 1) => {
    await run.step({ kind: "operation", client, operation: kind, arg });
    await run.drain(client);
  };
  /** Delivers c1's calls until its next request is CommitRevision. */
  const untilCommit = async () => {
    for (let delivery = 0; network.pendingRequest(1) !== "CommitRevision"; delivery++) {
      if (delivery > 100) throw new Error("c1 never sent CommitRevision");
      await run.step({ kind: "deliver-request", client: 1 });
      await run.step({ kind: "deliver-response", client: 1 });
    }
  };
  const membership = (entry: string) => {
    run.context.log(entry);
  };
  /** The trace's server answers to c1's calls since trace line `start`. */
  const memberOutcomesSince = (start: number) => run.trace.slice(start).filter((line) => /#\d+ c1 \w+.* -> /.test(line));
  const documents = async () => new Set((await serverFeed(run.direct, run.context.vaultId)).map((revision) => revision.documentId));

  await operation(0, "pull");
  await operation(1, "pull");
  await operation(1, "create", 1);

  // 1. The edit is applied, its response lost, and u1 demoted before the retry.
  await run.step({ kind: "operation", client: 1, operation: "edit", arg: 2 });
  await untilCommit();
  await run.step({ kind: "deliver-request", client: 1 });
  const appliedBeforeDemotion = /c1 CommitRevision\(\S+ (\S+) /.exec([...run.trace].reverse().find((line) => line.includes("c1 CommitRevision(")) ?? "")?.[1] ?? "?";
  await run.step({ kind: "drop-response", pick: 0 });
  const viewerStart = run.trace.length;
  membership(await run.members.setRoleOf(1, "viewer"));
  await run.drain(1);

  // 2. A viewer pulls, and cannot upload.
  await operation(0, "create", 3);
  await operation(1, "pull");
  await operation(1, "create", 4);
  const refusedWhileViewer = memberOutcomesSince(viewerStart);

  // 3. An editor again; its commit is in flight when it is removed.
  membership(await run.members.setRoleOf(1, "editor"));
  await operation(1, "pull");
  await run.step({ kind: "operation", client: 1, operation: "edit", arg: 5 });
  await untilCommit();
  const removedStart = run.trace.length;
  const before = await documents();
  membership(await run.members.removeMember(1));
  await run.drain(1);

  // 4. The owner changes the vault; c1 must get none of it.
  await operation(0, "create", 6);
  await operation(0, "create", 9);
  await operation(1, "pull");
  await operation(1, "create", 7);
  const refusedWhileRemoved = memberOutcomesSince(removedStart);
  const createdWhileRemoved = [...(await documents())].filter((id) => !before.has(id)).map((id) => run.context.ids.label(id));
  const knownWhenLetBackIn = Object.keys(run.clients[1]?.knownHeads() ?? {})
    .map((id) => run.context.ids.label(id))
    .filter((label) => createdWhileRemoved.includes(label));

  // 5. Back in: c1 catches up and writes again.
  membership(await run.members.rejoin(1, "editor"));
  await operation(1, "pull");
  await operation(1, "edit", 8);

  const result = await run.finish();
  const feed = new Set((await serverFeed(run.direct, run.context.vaultId)).map((revision) => run.context.ids.label(revision.revisionId)));
  const memberAcknowledged = result.acknowledged.filter((acknowledgement) => acknowledgement.client === 1).map((acknowledgement) => run.context.ids.label(acknowledgement.revisionId));
  return {
    ...result,
    appliedBeforeDemotion,
    appliedKept: feed.has(appliedBeforeDemotion),
    refusedWhileViewer,
    refusedWhileRemoved,
    memberAcknowledged,
    memberAcknowledgedKept: memberAcknowledged.filter((label) => feed.has(label)),
    createdWhileRemoved,
    knownWhenLetBackIn,
    knownAtEnd: Object.keys(run.clients[1]?.knownHeads() ?? {}).map((id) => run.context.ids.label(id)),
  };
}

/** The answers in `outcomes`, as `Method -> code` (`ok` for an accepted call): what the scenario's test compares. */
export function answers(outcomes: readonly string[]): string[] {
  return outcomes.map((line) => {
    const match = /#\d+ c\d+ (\w+).* -> (\w+)/.exec(line);
    return match === null ? "?" : `${match[1] ?? "?"} -> ${match[2] ?? "?"}`;
  });
}

/** Whether every answer in `answers` is a refusal with `code`. */
export function allRefused(answered: readonly string[], code: Code): boolean {
  return answered.length > 0 && answered.every((answer) => answer.endsWith(` -> ${Code[code]}`));
}
