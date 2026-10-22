import { createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createProtocolClient } from "../plugin/src/core/protocol/client";
import { BlobService } from "../plugin/src/gen/vaultsync/v1/blob_pb";
import { SyncService } from "../plugin/src/gen/vaultsync/v1/sync_pb";
import { DocumentKind } from "../plugin/src/gen/vaultsync/v1/types_pb";
import { pathPool, ScriptedClient, type RunContext, type Violation } from "./client";
import { Ids } from "./ids";
import { settle, SimNetwork } from "./network";

// The scripted client against a trivial in-process server that acknowledges
// every commit, so a test can make the acknowledgement differ from the
// request. The simulation proper always runs against the real server.

/** A scripted client whose server acknowledges each commit with `acknowledgedKind(requested)`. */
function setup(acknowledgedKind: (requested: DocumentKind) => DocumentKind) {
  let seq = 0n;
  const server = createRouterTransport(({ service }) => {
    service(SyncService, {
      listChanges: () => ({ revisions: [], headSeq: seq, hasMore: false }),
      commitRevision: (request) => {
        seq++;
        return {
          revision: {
            id: request.revisionId,
            documentId: request.documentId,
            vaultId: request.vaultId,
            seq,
            parentRevId: request.baseRevId,
            kind: acknowledgedKind(request.kind),
            contentRef: request.contentRef,
            path: request.path,
            deleted: request.deleted,
          },
        };
      },
    });
    service(BlobService, { beginBlob: () => ({ complete: true }) });
  });
  const trace: string[] = [];
  const violations: Violation[] = [];
  const network = new SimNetwork({ describeRequest: (method) => method, describeOutcome: () => "", violation: () => undefined });
  const context: RunContext = {
    vaultId: "vault",
    ids: new Ids(),
    network,
    acknowledged: [],
    violations,
    log: (entry) => trace.push(entry),
    trace,
    stepNumber: () => 0,
    serverSeq: () => seq,
    purgedSeqs: new Set(),
    purgedRevisions: new Set(),
    pathPool,
    restores: () => 0,
    restoredAway: new Map(),
  };
  const client = new ScriptedClient(0, createProtocolClient({ transport: server }), "device", context);
  return { client, context, violations, trace };
}

/** Runs `client`'s create, after the pull it needs first, to completion. */
async function create(client: ScriptedClient): Promise<void> {
  client.start("pull", 0);
  await untilIdle(client);
  client.start("create", 1);
  await untilIdle(client);
}

/** Settles `client`'s network until its operation finished. */
async function untilIdle(client: ScriptedClient): Promise<void> {
  while (!client.idle) await settle();
}

describe("ScriptedClient", () => {
  it("records an acknowledged create that matches its request without a violation", async () => {
    const { client, context, violations, trace } = setup((requested) => requested);
    await create(client);

    expect(violations, trace.join("\n")).toEqual([]);
    expect(context.acknowledged).toHaveLength(1);
  });

  it("reports a protocol violation when the server acknowledges a commit with another kind than it sent (#317)", async () => {
    const { client, violations, trace } = setup(() => DocumentKind.BLOB);
    await create(client);

    expect(violations, trace.join("\n")).toEqual([{ invariant: "protocol", detail: "acknowledged c0.r1 has kind BLOB, but the commit request had TEXT" }]);
  });
});
