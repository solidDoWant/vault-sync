import { describe, expect, it, vi } from "vitest";

import type { SyncEngine } from "./engine";
import { harness } from "./testing";

// #862 item 3 (from #897): the end of every pull retries the `alias`
// deferrals whose alias is gone (retryPostponed, #870). Finding that out reads
// every journal document, so a pull with no `alias` deferral, an empty one
// a realtime notification triggers included, must not run it.

/**
 * The engine's alias claims scan (`aliasedPaths`, which lists every journal
 * document). Other steps of a pull list them for their own reasons, so the
 * scan is watched itself.
 */
function aliasScans(engine: SyncEngine) {
  return vi.spyOn(engine as unknown as { aliasedPaths: (...args: unknown[]) => unknown }, "aliasedPaths");
}

describe("SyncEngine's pull and the alias claims scan (#862)", () => {
  it("does not run the alias claims scan on an empty pull with no alias deferral", async () => {
    const h = harness({ merge: "default", maxDownloadBytes: 16 });
    h.server.commit({ documentId: "a", path: "a.md", content: "a\n" });
    // Another kind of deferral: a revision too large for this device.
    h.server.commit({ documentId: "big", path: "big.md", content: "x".repeat(40) });
    await h.engine.pull();
    expect((await h.journal.listDeferred()).map((deferred) => deferred.reason)).toEqual(["too-large"]);

    const scans = aliasScans(h.engine);
    await h.engine.pull();

    expect(scans).not.toHaveBeenCalled();
  });

});
