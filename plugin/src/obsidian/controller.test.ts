import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeviceService } from "../gen/vaultsync/v1/device_pb";
import { DeviceSchema, VaultEncryption, VaultSchema } from "../gen/vaultsync/v1/types_pb";
import { VaultService } from "../gen/vaultsync/v1/vault_pb";
import type { AuthState } from "../core/auth/tokens";
import { InMemoryServer } from "../core/engine/memory-server";
import { InMemoryJournal } from "../core/journal/memory";
import { InMemoryRealtimeServer } from "../core/realtime/memory";
import { createProtocolClient, type ProtocolClient } from "../core/protocol/client";
import { InMemoryVault } from "../core/vault/memory";
import { connectNeedsConfirmation, connectProblem, DeviceLimitError, ensureDevice, listRemoteVaults, SyncController, type ClosableJournal } from "./controller";
import { parsePluginData, type PluginData } from "./data";
import { SyncSession, type SyncSessionOptions } from "./session";
import type { SyncStatus } from "./status";

const bytes = (value: string) => new TextEncoder().encode(value);

/** An unsigned JWT for `subject`: the plugin only reads its claims. */
const tokenFor = (subject: string) => `e30.${btoa(JSON.stringify({ sub: subject, exp: 4_000_000_000 })).replace(/=+$/, "")}.sig`;

afterEach(() => {
  vi.useRealTimers();
});

/** The device and vault services, faked; sync and blobs from an in-memory server. */
function fakeServer(options: { registerDevice?: (name: string) => string } = {}) {
  const sync = new InMemoryServer();
  const registered: string[] = [];
  const vaults = [
    create(VaultSchema, {
      id: sync.vaultId,
      name: "Notes",
      encryption: VaultEncryption.NONE,
    }),
    create(VaultSchema, {
      id: "vault-2",
      name: "Work",
      encryption: VaultEncryption.NONE,
    }),
    create(VaultSchema, {
      id: "vault-3",
      name: "Secret",
      encryption: VaultEncryption.E2EE,
    }),
  ];
  const transport = createRouterTransport(({ service }) => {
    service(DeviceService, {
      registerDevice: (request) => {
        const id = options.registerDevice?.(request.name) ?? `device-${String(registered.length + 1)}`;
        registered.push(request.name);
        return { device: create(DeviceSchema, { id, name: request.name }) };
      },
    });
    service(VaultService, {
      // One vault per page, so paging is exercised.
      listVaults: (request) => {
        const index = request.pageToken === "" ? 0 : Number(request.pageToken);
        return {
          vaults: vaults.slice(index, index + 1),
          nextPageToken: index + 1 < vaults.length ? String(index + 1) : "",
        };
      },
    });
  });
  const client: ProtocolClient = {
    ...createProtocolClient({ transport: sync.transport }),
    devices: createClient(DeviceService, transport),
    vaults: createClient(VaultService, transport),
  };
  return { sync, client, registered };
}

const settings: PluginData = {
  ...parsePluginData({
    serverUrl: "https://sync.example",
    oidcIssuer: "https://auth.example/",
    oidcClientId: "vault-sync",
  }),
};

function connected(data: PluginData, vaultId: string): PluginData {
  data.vault = {
    id: vaultId,
    name: "Notes",
    serverUrl: "https://sync.example",
  };
  return data;
}

/** A journal that records whether it was closed. */
function closable(): ClosableJournal & { closed: boolean } {
  return Object.assign(new InMemoryJournal(), {
    closed: false,
    close() {
      this.closed = true;
    },
  });
}

interface Fixture {
  data: PluginData;
  auth: { state: AuthState; subject: string };
  vault: InMemoryVault;
  statuses: SyncStatus[];
  saves: number;
  events: string[];
  controller: SyncController;
}

function fixture(server: ReturnType<typeof fakeServer>, data: PluginData, overrides: Partial<ConstructorParameters<typeof SyncController>[0]> = {}): Fixture {
  const auth = { state: "signed-in" as AuthState, subject: "alice" };
  const vault = new InMemoryVault();
  const statuses: SyncStatus[] = [];
  const events: string[] = [];
  const journals = new Map<string, ClosableJournal & { closed: boolean }>();
  const result: Fixture = {
    data,
    auth,
    vault,
    statuses,
    saves: 0,
    events,
    controller: new SyncController({
      data: () => data,
      save: () => {
        result.saves++;
        return Promise.resolve();
      },
      authState: () => auth.state,
      client: () => server.client,
      accessToken: () => Promise.resolve(tokenFor(auth.subject)),
      defaultDeviceName: "desktop",
      openJournal: (key) => {
        // One journal per server vault, kept across sessions as IndexedDB keeps it.
        const journal = journals.get(key.vaultId) ?? closable();
        journal.closed = false;
        journals.set(key.vaultId, journal);
        return Promise.resolve(journal);
      },
      vault: () => vault,
      pushDebounceMs: null,
      syncIntervalMs: null,
      onStatus: (status) => statuses.push(status),
      createSession: (options: SyncSessionOptions) => {
        events.push(`start ${options.vaultId} as ${options.deviceId}`);
        const session = new SyncSession(options);
        const stop = session.stop.bind(session);
        session.stop = async () => {
          await stop();
          events.push(`stopped ${options.vaultId}`);
        };
        return session;
      },
      ...overrides,
    }),
  };
  return result;
}

/** Waits until the latest status is `state`. */
async function statusBecomes(statuses: SyncStatus[], state: SyncStatus["state"]): Promise<SyncStatus | undefined> {
  await vi.waitFor(() => {
    expect(statuses.at(-1)?.state).toBe(state);
  });
  return statuses.at(-1);
}

describe("ensureDevice", () => {
  it("registers once per install and reuses the stored id after a restart", async () => {
    const server = fakeServer();
    const data = { ...settings, deviceName: "Laptop" };
    let saves = 0;
    const options = {
      data,
      save: () => {
        saves++;
        return Promise.resolve();
      },
      client: server.client,
      accessToken: () => Promise.resolve(tokenFor("alice")),
      defaultDeviceName: "desktop",
    };

    expect(await ensureDevice(options)).toBe("device-1");
    expect(saves).toBe(1);
    // A restart: the stored plugin data, read back.
    const reloaded = parsePluginData(JSON.parse(JSON.stringify(data)));
    expect(await ensureDevice({ ...options, data: reloaded })).toBe("device-1");

    expect(server.registered).toEqual(["Laptop"]);
  });

  it("registers a device of its own for another account or server", async () => {
    const server = fakeServer();
    const data = { ...settings };
    const options = {
      data,
      save: () => Promise.resolve(),
      client: server.client,
      accessToken: () => Promise.resolve(tokenFor("alice")),
      defaultDeviceName: "desktop",
    };
    expect(await ensureDevice(options)).toBe("device-1");

    expect(
      await ensureDevice({
        ...options,
        accessToken: () => Promise.resolve(tokenFor("bob")),
      }),
    ).toBe("device-2");
    data.serverUrl = "https://other.example";
    expect(
      await ensureDevice({
        ...options,
        accessToken: () => Promise.resolve(tokenFor("bob")),
      }),
    ).toBe("device-3");
    // The platform's name when the user set none.
    expect(server.registered).toEqual(["desktop", "desktop", "desktop"]);
  });

  it("reports the server's device limit as such, with the server's message", async () => {
    const server = fakeServer({
      registerDevice: () => {
        throw new ConnectError("at most 100 devices may be registered", Code.ResourceExhausted);
      },
    });
    const data = { ...settings };
    const failure = ensureDevice({
      data,
      save: () => Promise.resolve(),
      client: server.client,
      accessToken: () => Promise.resolve(tokenFor("alice")),
      defaultDeviceName: "desktop",
    });

    await expect(failure).rejects.toBeInstanceOf(DeviceLimitError);
    await expect(failure).rejects.toThrow(/reached the server's limit on registered devices \(at most 100 devices may be registered\)/);
    expect(data.device).toBeUndefined();
  });

  it("does not take the per-user limit on concurrent requests for the device limit", async () => {
    const server = fakeServer({
      registerDevice: () => {
        throw new ConnectError("too many concurrent requests from this user; retry once earlier requests complete", Code.ResourceExhausted);
      },
    });
    const failure = ensureDevice({
      data: { ...settings },
      save: () => Promise.resolve(),
      client: server.client,
      accessToken: () => Promise.resolve(tokenFor("alice")),
      defaultDeviceName: "desktop",
    });

    await expect(failure).rejects.toMatchObject({
      code: Code.ResourceExhausted,
    });
    await expect(failure).rejects.not.toBeInstanceOf(DeviceLimitError);
  });
});

describe("vault selection", () => {
  it("lists every vault across pages", async () => {
    const server = fakeServer();
    expect((await listRemoteVaults(server.client)).map((vault) => vault.name)).toEqual(["Notes", "Work", "Secret"]);
  });

  it("asks for confirmation only when both the local and the remote vault have files", () => {
    expect(connectNeedsConfirmation(1, { headSeq: 1n })).toBe(true);
    expect(connectNeedsConfirmation(0, { headSeq: 1n })).toBe(false);
    expect(connectNeedsConfirmation(1, { headSeq: 0n })).toBe(false);
    expect(connectNeedsConfirmation(0, { headSeq: 0n })).toBe(false);
  });

  it("refuses end-to-end encrypted vaults, which the engine cannot sync yet", () => {
    expect(connectProblem(create(VaultSchema, { encryption: VaultEncryption.E2EE }))).toMatch(/encrypted/);
    expect(connectProblem(create(VaultSchema, { encryption: VaultEncryption.NONE }))).toBeUndefined();
  });
});

describe("SyncController", () => {
  it("syncs the connected vault as this install's device once signed in", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.vault.write("a.md", bytes("local"));

    await f.controller.update();
    await statusBecomes(f.statuses, "idle");

    expect(server.sync.liveFiles()).toEqual(new Map([["a.md", "local"]]));
    // The commit carries this install's registered device.
    expect(server.sync.revisionAt(1n).deviceId).toBe("device-1");
    expect(f.data.device).toMatchObject({
      id: "device-1",
      subject: "alice",
      serverUrl: "https://sync.example",
    });
    await f.controller.stop();
  });

  it("does not sync while signed out or not connected", async () => {
    const server = fakeServer();
    const f = fixture(server, { ...settings });
    f.auth.state = "signed-out";
    await f.controller.update();
    expect(f.statuses.at(-1)?.state).toBe("signed-out");

    f.auth.state = "signed-in";
    await f.controller.update();
    expect(f.statuses.at(-1)?.state).toBe("not-connected");
    // A vault on another server is not this server's.
    f.data.vault = {
      id: server.sync.vaultId,
      name: "Notes",
      serverUrl: "https://other.example",
    };
    await f.controller.update();
    expect(f.statuses.at(-1)?.state).toBe("not-connected");

    expect(f.events).toEqual([]);
    expect(server.registered).toEqual([]);
  });

  it("pauses while sign-in is required, and pushes the changes made meanwhile after the next sign-in", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");

    f.auth.state = "sign-in-required";
    await f.controller.update();
    expect(f.statuses.at(-1)).toEqual({
      state: "sign-in-required",
      conflicts: 0,
      pending: 0,
    });
    expect(f.events).toEqual([`start ${server.sync.vaultId} as device-1`, `stopped ${server.sync.vaultId}`]);
    await f.vault.write("offline.md", bytes("written while signed out"));
    expect(server.sync.liveFiles()).toEqual(new Map());

    f.auth.state = "signed-in";
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    expect(server.sync.liveFiles()).toEqual(new Map([["offline.md", "written while signed out"]]));
    // Still the same device: signing in again registers nothing.
    expect(server.registered).toHaveLength(1);
    await f.controller.stop();
  });

  it("stops the old vault's session, and waits for it, before it starts another vault's", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();

    connected(f.data, "vault-2");
    await f.controller.update();

    expect(f.events).toEqual([`start ${server.sync.vaultId} as device-1`, `stopped ${server.sync.vaultId}`, "start vault-2 as device-1"]);
    await f.controller.stop();
    expect(f.events.at(-1)).toBe("stopped vault-2");
  });

  it("keeps one session when nothing changed", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await f.controller.update();
    expect(f.events).toEqual([`start ${server.sync.vaultId} as device-1`]);
    await f.controller.stop();
  });

  it("restarts the session over a fresh vault when asked, as after a config sync setting changed", async () => {
    const server = fakeServer();
    let vaults = 0;
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId), {
      vault: () => {
        vaults++;
        return new InMemoryVault();
      },
    });
    await f.controller.update();

    await f.controller.restart();

    expect(f.events).toEqual([`start ${server.sync.vaultId} as device-1`, `stopped ${server.sync.vaultId}`, `start ${server.sync.vaultId} as device-1`]);
    expect(vaults).toBe(2);
    await f.controller.stop();
  });

  it("starts nothing on a restart while signed out", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    f.auth.state = "signed-out";

    await f.controller.restart();

    expect(f.events).toEqual([]);
  });

  it("shows the device limit as an error and starts no sync", async () => {
    const server = fakeServer({
      registerDevice: () => {
        throw new ConnectError("at most 100 devices may be registered", Code.ResourceExhausted);
      },
    });
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));

    await f.controller.update();

    expect(f.statuses.at(-1)).toMatchObject({
      state: "error",
      message: expect.stringMatching(/limit on registered devices/) as unknown,
    });
    expect(f.events).toEqual([]);
  });

  it("tells the user when the journal waits for another window", async () => {
    const server = fakeServer();
    let unblock: () => void = () => undefined;
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId), {
      openJournal: async (_key, onBlocked) => {
        onBlocked();
        await new Promise<void>((resolve) => (unblock = resolve));
        return closable();
      },
    });

    const updating = f.controller.update();
    await statusBecomes(f.statuses, "waiting-for-journal");
    expect(f.events).toEqual([]);
    unblock();
    await updating;
    expect(f.events).toEqual([`start ${server.sync.vaultId} as device-1`]);
    await f.controller.stop();
  });

  it("retries a start that failed because the server was unreachable", async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    let reachable = false;
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId), {
      syncIntervalMs: 30_000,
      openJournal: () => (reachable ? Promise.resolve(closable()) : Promise.reject(new ConnectError("network error", Code.Unavailable))),
    });

    await f.controller.update();
    expect(f.statuses.at(-1)).toMatchObject({ state: "offline" });
    reachable = true;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(f.events).toEqual([`start ${server.sync.vaultId} as device-1`]);
    await f.controller.stop();
  });

  it("subscribes the session to its vault on the configured server's realtime channel", async () => {
    const server = fakeServer();
    const realtime = new InMemoryRealtimeServer();
    const servers: string[] = [];
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId), {
      realtime: (serverUrl) => {
        servers.push(serverUrl);
        return { connect: realtime.connect, accessToken: () => Promise.resolve(tokenFor("alice")) };
      },
    });

    await f.controller.update();
    await vi.waitFor(() => {
      expect([...(realtime.open[0]?.subscriptions ?? [])]).toEqual([server.sync.vaultId]);
    });
    expect(servers).toEqual(["https://sync.example"]);

    await f.controller.stop();
    await vi.waitFor(() => {
      expect(realtime.open).toEqual([]);
    });
  });
});
