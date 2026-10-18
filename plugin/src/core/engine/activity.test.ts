import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryJournal } from "../journal/memory";
import { createProtocolClient } from "../protocol/client";
import { InMemoryVault } from "../vault/memory";
import { SyncEngine, type PushSummary, type SyncEngineOptions } from "./engine";
import { InMemoryServer } from "./memory-server";

// The hooks a status display uses: when sync is busy, and how automatic pushes end.

afterEach(() => {
  vi.useRealTimers();
});

function engine(options: Partial<SyncEngineOptions> = {}) {
  const server = new InMemoryServer();
  const vault = new InMemoryVault();
  return {
    server,
    vault,
    engine: new SyncEngine({
      vaultId: server.vaultId,
      deviceId: "device-1",
      api: createProtocolClient({ transport: server.transport }),
      vault,
      journal: new InMemoryJournal(),
      pushDebounceMs: null,
      ...options,
    }),
  };
}

describe("SyncEngine activity hooks", () => {
  it("reports busy once for back-to-back pulls and pushes, and idle when the last settles, before its caller resumes", async () => {
    const changes: string[] = [];
    const { engine: sync } = engine({
      onBusyChange: (busy) => changes.push(busy ? "busy" : "idle"),
    });

    const pull = sync.pull().then(() => changes.push("pull resolved"));
    const push = sync.push().then(() => changes.push("push resolved"));
    expect(changes).toEqual(["busy"]);
    await Promise.all([pull, push]);

    expect(changes).toEqual(["busy", "pull resolved", "idle", "push resolved"]);
  });

  it("reports idle after a failed push too", async () => {
    const changes: boolean[] = [];
    const { engine: sync, server } = engine({
      onBusyChange: (busy) => changes.push(busy),
    });
    server.interceptor = () => {
      throw new Error("down");
    };

    await expect(sync.push()).rejects.toThrow();
    expect(changes).toEqual([true, false]);
  });

  it("hands the summary of a successful automatic push to onPushComplete", async () => {
    vi.useFakeTimers();
    const summaries: PushSummary[] = [];
    const errors: unknown[] = [];
    const {
      engine: sync,
      vault,
      server,
    } = engine({
      pushDebounceMs: 100,
      onPushComplete: (summary) => summaries.push(summary),
      onPushError: (error) => errors.push(error),
    });

    await vault.write("a.md", new TextEncoder().encode("typed"));
    await vi.advanceTimersByTimeAsync(100);
    await sync.settled();

    expect(summaries).toEqual([{ committed: 1, conflicts: 0, pending: 0, rejected: [] }]);
    expect(errors).toEqual([]);
    expect(server.liveFiles()).toEqual(new Map([["a.md", "typed"]]));
  });
});
