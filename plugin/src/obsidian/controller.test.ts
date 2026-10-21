import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeviceService } from "../gen/vaultsync/v1/device_pb";
import { ErrorDetailSchema, ErrorReason } from "../gen/vaultsync/v1/errors_pb";
import type { CommitRevisionRequest } from "../gen/vaultsync/v1/sync_pb";
import { DeviceSchema, VaultEncryption, VaultRole, VaultSchema, type Device, type Revision } from "../gen/vaultsync/v1/types_pb";
import { VaultService } from "../gen/vaultsync/v1/vault_pb";
import type { AuthState } from "../core/auth/tokens";
import { InMemoryServer } from "../core/engine/memory-server";
import { InMemoryJournal } from "../core/journal/memory";
import { InMemoryRealtimeServer } from "../core/realtime/memory";
import { createProtocolClient, type ProtocolClient } from "../core/protocol/client";
import { InMemoryVault } from "../core/vault/memory";
import { connectNeedsConfirmation, connectProblem, DeviceLimitError, ensureDevice, listRemoteVaults, SyncController, type ClosableJournal } from "./controller";
import { currentDeviceId, deviceRows, listDevices, removeOtherDevice } from "./devices";
import { parsePluginData, type PluginData } from "./data";
import { DeviceNameError } from "./device-name";
import { SyncSession, type SyncSessionOptions } from "./session";
import type { SyncStatus } from "./status";

const bytes = (value: string) => new TextEncoder().encode(value);

/** An unsigned JWT for `subject`: the plugin only reads its claims. */
const tokenFor = (subject: string) => `e30.${btoa(JSON.stringify({ sub: subject, exp: 4_000_000_000 })).replace(/=+$/, "")}.sig`;

afterEach(() => {
  vi.useRealTimers();
});

/** The device and vault services, faked; sync and blobs from an in-memory server. */
function fakeServer(options: { registerDevice?: (name: string, registrationId: string) => string; role?: VaultRole; listVaults?: () => void } = {}) {
  const sync = new InMemoryServer();
  const registered: string[] = [];
  const registrationIds: string[] = [];
  const vaults = [
    create(VaultSchema, {
      id: sync.vaultId,
      name: "Notes",
      encryption: VaultEncryption.NONE,
      role: options.role ?? VaultRole.OWNER,
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
  /** The devices registered and not removed, oldest first. */
  const devices: Device[] = [];
  /** Removed device ids: their commits are refused as the server refuses them (#590). */
  const removed = new Set<string>();
  sync.interceptor = (method, request) => {
    if (method !== "CommitRevision") return;
    const commit = request as CommitRevisionRequest;
    if (removed.has(commit.deviceId)) throw deviceNotFound();
    // A retry under another device id is idempotent only if the device
    // that committed the revision was removed (the installation registered
    // again); otherwise the revision id is reused with other fields.
    const committed = revisionById(sync, commit.revisionId);
    if (committed !== undefined && committed.deviceId !== commit.deviceId && !removed.has(committed.deviceId)) {
      throw new ConnectError("revision id reused with other fields", Code.InvalidArgument);
    }
  };
  const transport = createRouterTransport(({ service }) => {
    service(DeviceService, {
      registerDevice: (request) => {
        registrationIds.push(request.registrationId);
        const id = options.registerDevice?.(request.name, request.registrationId) ?? `device-${String(registered.length + 1)}`;
        registered.push(request.name);
        const device = create(DeviceSchema, { id, name: request.name });
        devices.push(device);
        return { device };
      },
      listDevices: () => ({ devices: devices.filter((device) => !removed.has(device.id)) }),
      removeDevice: (request) => {
        if (!devices.some((device) => device.id === request.deviceId) || removed.has(request.deviceId)) throw new ConnectError("device not found", Code.NotFound);
        removed.add(request.deviceId);
        return {};
      },
    });
    service(VaultService, {
      // One vault per page, so paging is exercised.
      listVaults: (request) => {
        options.listVaults?.();
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
  return { sync, client, registered, registrationIds, devices, removed };
}

function revisionById(server: InMemoryServer, revisionId: string): Revision | undefined {
  for (let seq = 1n; seq <= server.currentHeadSeq; seq++) {
    const revision = server.revisionAt(seq);
    if (revision.id === revisionId) return revision;
  }
  return undefined;
}

/** The server's refusal of a commit from a removed device: NOT_FOUND with the DEVICE_NOT_FOUND reason. */
function deviceNotFound(): ConnectError {
  return new ConnectError("device not found", Code.NotFound, undefined, [{ desc: ErrorDetailSchema, value: { reason: ErrorReason.DEVICE_NOT_FOUND } }]);
}

/** A RESOURCE_EXHAUSTED error, with the machine-readable reason when one is given. */
function resourceExhausted(message: string, reason?: ErrorReason): ConnectError {
  const details = reason === undefined ? [] : [{ desc: ErrorDetailSchema, value: { reason } }];
  return new ConnectError(message, Code.ResourceExhausted, undefined, details);
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
    // The registration id before the call (#428), then the device.
    expect(saves).toBe(2);
    // A restart: the stored plugin data, read back.
    const reloaded = parsePluginData(JSON.parse(JSON.stringify(data)));
    expect(await ensureDevice({ ...options, data: reloaded })).toBe("device-1");

    expect(server.registered).toEqual(["Laptop"]);
  });

  it.each([
    ["registers the name without the invisible characters the server refuses (#548)", "\u202eWork\u200d laptop\u2069\u2028", "Work laptop"],
    ["registers the default name when the setting holds nothing visible (#548)", "\u200b\u202e \u2066", "desktop"],
  ])("%s", async (_, deviceName, registered) => {
    const server = fakeServer();
    const options = { data: { ...settings, deviceName }, save: () => Promise.resolve(), client: server.client, accessToken: () => Promise.resolve(tokenFor("alice")), defaultDeviceName: "desktop" };

    expect(await ensureDevice(options)).toBe("device-1");

    expect(server.registered).toEqual([registered]);
  });

  it.each([
    ["registers a name of exactly 256 bytes as it is (#557)", "n".repeat(256), "n".repeat(256)],
    ["cuts a name of 257 bytes to 256 (#557)", "n".repeat(257), "n".repeat(256)],
    ["cuts a longer name before a character that would cross 256 bytes, never through it (#557)", `${"n".repeat(255)}é and more`, "n".repeat(255)],
    ["cuts after a character that ends exactly at 256 bytes (#557)", `${"n".repeat(253)}日 and more`, `${"n".repeat(253)}日`],
    ["never cuts through an emoji's surrogate pair (#557)", `${"n".repeat(253)}\u{1f600}`, "n".repeat(253)],
  ])("%s", async (_, deviceName, registered) => {
    const server = fakeServer();
    const options = { data: { ...settings, deviceName }, save: () => Promise.resolve(), client: server.client, accessToken: () => Promise.resolve(tokenFor("alice")), defaultDeviceName: "desktop" };

    expect(await ensureDevice(options)).toBe("device-1");

    expect(server.registered).toEqual([registered]);
    expect(new TextEncoder().encode(server.registered[0]).length).toBeLessThanOrEqual(256);
  });

  it("names the Device name setting when the server refuses the name (#557)", async () => {
    const server = fakeServer({
      registerDevice: () => {
        // A format character this device's Unicode tables do not know yet.
        throw new ConnectError("name must be valid UTF-8 without control, format or line separator characters", Code.InvalidArgument);
      },
    });
    const data = { ...settings, deviceName: "Phone\u0890" };
    const failure = ensureDevice({ data, save: () => Promise.resolve(), client: server.client, accessToken: () => Promise.resolve(tokenFor("alice")), defaultDeviceName: "desktop" });

    await expect(failure).rejects.toBeInstanceOf(DeviceNameError);
    await expect(failure).rejects.toThrow(/refused this device's name \(name must be valid UTF-8 without control, format or line separator characters\)\. Change the Device name setting/);
    expect(data.device).toBeUndefined();
  });

  it("names the error code when the server refuses the name without a message (#605)", async () => {
    const server = fakeServer({
      registerDevice: () => {
        throw new ConnectError("", Code.InvalidArgument);
      },
    });
    const failure = ensureDevice({ data: { ...settings }, save: () => Promise.resolve(), client: server.client, accessToken: () => Promise.resolve(tokenFor("alice")), defaultDeviceName: "desktop" });

    await expect(failure).rejects.toBeInstanceOf(DeviceNameError);
    await expect(failure).rejects.toThrow(/refused this device's name \(InvalidArgument\)\. Change the Device name setting/);
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
        throw resourceExhausted("at most 100 devices may be registered", ErrorReason.DEVICE_LIMIT);
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
    // It points at the device list, where a device can be removed (#590).
    await expect(failure).rejects.toThrow(/Remove a device you no longer use from the device list in Vault Sync's settings/);
    await expect(failure).rejects.not.toThrow(/cannot be removed/);
    expect(data.device).toBeUndefined();
  });

  it.each([
    // The server's limiter, even worded like the device limit: only the reason counts (#428).
    ["the per-user limit on concurrent requests", resourceExhausted("at most 100 devices may be registered", ErrorReason.TOO_MANY_CONCURRENT_REQUESTS)],
    // A request over the size limit, or a server too old to send reasons.
    ["a refusal without a reason", resourceExhausted("at most 100 devices may be registered")],
  ])("does not take %s for the device limit", async (_, refusal) => {
    const server = fakeServer({
      registerDevice: () => {
        throw refusal;
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

  it.each([
    ["UNAVAILABLE", new ConnectError("connection reset", Code.Unavailable)],
    ["DEADLINE_EXCEEDED", new ConnectError("deadline exceeded", Code.DeadlineExceeded)],
    ["a RESOURCE_EXHAUSTED without the device-limit reason", resourceExhausted("too many requests")],
    ["a network error", new TypeError("Failed to fetch")],
  ])("retries a registration after %s with the same registration id and name (#428)", async (_, failure) => {
    let lose = true;
    const server = fakeServer({
      registerDevice: () => {
        // The server may have registered the device before the plugin lost
        // the response, so the retry must not look like a new install.
        if (lose) {
          lose = false;
          throw failure;
        }
        return "device-1";
      },
    });
    const data = { ...settings, deviceName: "Laptop" };
    let disk = "";
    const options = {
      data,
      save: () => {
        disk = JSON.stringify(data);
        return Promise.resolve();
      },
      client: server.client,
      accessToken: () => Promise.resolve(tokenFor("alice")),
      defaultDeviceName: "desktop",
    };

    await expect(ensureDevice(options)).rejects.toThrow();
    // A restart reads what was saved; the user renamed the device meanwhile.
    const reloaded = { ...parsePluginData(JSON.parse(disk)), deviceName: "Renamed" };
    expect(await ensureDevice({ ...options, data: reloaded })).toBe("device-1");

    expect(server.registrationIds).toHaveLength(2);
    expect(server.registrationIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(server.registrationIds[1]).toBe(server.registrationIds[0]);
    expect(server.registered).toEqual(["Laptop"]);
    expect(reloaded.device?.id).toBe("device-1");
    expect(reloaded.pendingDevice).toBeUndefined();
  });

  it("uses a new registration id for each account it registers", async () => {
    const server = fakeServer();
    const data = { ...settings };
    const options = { data, save: () => Promise.resolve(), client: server.client, accessToken: () => Promise.resolve(tokenFor("alice")), defaultDeviceName: "desktop" };
    await ensureDevice(options);
    await ensureDevice({ ...options, accessToken: () => Promise.resolve(tokenFor("bob")) });

    expect(server.registrationIds).toHaveLength(2);
    expect(server.registrationIds[0]).not.toBe(server.registrationIds[1]);
  });

  it.each([
    ["INVALID_ARGUMENT", Code.InvalidArgument, DeviceNameError],
    ["ALREADY_EXISTS", Code.AlreadyExists, ConnectError],
  ])("drops the saved registration after a %s refusal, so the next attempt registers anew (#428)", async (_, code, thrown) => {
    let refuse = true;
    const server = fakeServer({
      registerDevice: () => {
        if (refuse) {
          refuse = false;
          throw new ConnectError("refused", code);
        }
        return "device-1";
      },
    });
    const data = { ...settings, deviceName: "Laptop" };
    let disk = "";
    const options = {
      data,
      save: () => {
        disk = JSON.stringify(data);
        return Promise.resolve();
      },
      client: server.client,
      accessToken: () => Promise.resolve(tokenFor("alice")),
      defaultDeviceName: "desktop",
    };

    const failure = ensureDevice(options);
    await expect(failure).rejects.toBeInstanceOf(thrown);
    // What a restart reads holds no registration to resend.
    const reloaded = { ...parsePluginData(JSON.parse(disk)), deviceName: "Renamed" };
    expect(reloaded.pendingDevice).toBeUndefined();
    expect(await ensureDevice({ ...options, data: reloaded })).toBe("device-1");

    expect(server.registrationIds).toHaveLength(2);
    expect(server.registrationIds[1]).not.toBe(server.registrationIds[0]);
    expect(server.registered).toEqual(["Renamed"]);
  });

  it("registers the renamed device after the server refused its name (#428, #557)", async () => {
    const server = fakeServer({
      registerDevice: (name) => {
        // A name the server refuses for a rule this device does not apply.
        if (name.startsWith("Refused")) throw new ConnectError("name must be valid UTF-8 without control, format or line separator characters", Code.InvalidArgument);
        return "device-1";
      },
    });
    const data = { ...settings, deviceName: "Refused phone" };
    const options = { data, save: () => Promise.resolve(), client: server.client, accessToken: () => Promise.resolve(tokenFor("alice")), defaultDeviceName: "desktop" };

    await expect(ensureDevice(options)).rejects.toBeInstanceOf(DeviceNameError);
    // Trying again without renaming is refused again: nothing was registered.
    await expect(ensureDevice(options)).rejects.toBeInstanceOf(DeviceNameError);
    data.deviceName = "Phone";
    expect(await ensureDevice(options)).toBe("device-1");

    expect(server.registered).toEqual(["Phone"]);
    expect(data.device?.id).toBe("device-1");
    expect(data.pendingDevice).toBeUndefined();
  });

  it.each([
    ["account", "bob", undefined],
    ["server", "alice", "https://other.example"],
  ])("does not resend another %s's unfinished registration (#428)", async (_, subject, serverUrl) => {
    let fail = true;
    const server = fakeServer({
      registerDevice: () => {
        if (fail) {
          fail = false;
          throw new ConnectError("connection reset", Code.Unavailable);
        }
        return "device-1";
      },
    });
    const data = { ...settings, deviceName: "Laptop" };
    const options = { data, save: () => Promise.resolve(), client: server.client, accessToken: () => Promise.resolve(tokenFor("alice")), defaultDeviceName: "desktop" };

    await expect(ensureDevice(options)).rejects.toThrow();
    data.deviceName = "Work laptop";
    if (serverUrl !== undefined) data.serverUrl = serverUrl;
    expect(await ensureDevice({ ...options, accessToken: () => Promise.resolve(tokenFor(subject)) })).toBe("device-1");

    expect(server.registrationIds).toHaveLength(2);
    expect(server.registrationIds[1]).not.toBe(server.registrationIds[0]);
    expect(server.registered).toEqual(["Work laptop"]);
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
  it("gives its sessions the platform's path rules (#418)", async () => {
    const server = fakeServer();
    server.sync.commit({ documentId: "ok", path: "ok.md", content: "fine\n" });
    server.sync.commit({ documentId: "reserved", path: "CON.md", content: "a reserved name\n" });
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId), { pathRules: { platform: "windows" } });

    await f.controller.update();
    await statusBecomes(f.statuses, "idle");

    expect(await f.vault.list()).toEqual(["ok.md"]);
    expect((await f.controller.session?.unmaterializable())?.map(({ path, reason }) => ({ path, reason }))).toEqual([{ path: "CON.md", reason: "reserved-name" }]);
  });

  it("names conflict copies after the Device name setting without its invisible characters (#557)", async () => {
    const server = fakeServer();
    server.sync.commit({ documentId: "remote", path: "a.md", content: "remote version\n" });
    const f = fixture(server, connected({ ...settings, deviceName: "\u202eWork\u200b lap\u2066top\u2069\u200d" }, server.sync.vaultId));
    await f.vault.write("a.md", bytes("local version\n"));

    await f.controller.update();
    await statusBecomes(f.statuses, "idle");

    const copies = (await f.vault.list()).filter((path) => path !== "a.md");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^a \(conflict Work laptop \d{4}-\d{2}-\d{2} \d{6}\)\.md$/u);
    await f.controller.stop();
  });

  it("shows the server's refusal of the device name with the setting to change (#557)", async () => {
    const server = fakeServer({
      registerDevice: () => {
        throw new ConnectError("name must be valid UTF-8 without control, format or line separator characters", Code.InvalidArgument);
      },
    });
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));

    await f.controller.update();

    expect(await statusBecomes(f.statuses, "error")).toMatchObject({ message: expect.stringMatching(/Change the Device name setting/) as unknown });
    await f.controller.stop();
  });

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
        throw resourceExhausted("at most 100 devices may be registered", ErrorReason.DEVICE_LIMIT);
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

  describe("history", () => {
    it.each([
      ["an owner", VaultRole.OWNER, true],
      ["an editor", VaultRole.EDITOR, true],
      ["a viewer", VaultRole.VIEWER, false],
    ])("lets %s restore versions only if the server allows it (#417)", async (_name, role, allowed) => {
      const server = fakeServer({ role });
      const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
      await f.controller.update();
      await statusBecomes(f.statuses, "idle");

      const history = f.controller.history();
      if (history?.canRestore === undefined) throw new Error("no history");
      expect(await history.canRestore()).toBe(allowed);
      await f.controller.stop();
    });

    it("leaves the decision to the server when the role cannot be read", async () => {
      let failing = false;
      const server = fakeServer({
        role: VaultRole.VIEWER,
        listVaults: () => {
          if (failing) throw new ConnectError("unreachable", Code.Unavailable);
        },
      });
      const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
      await f.controller.update();
      await statusBecomes(f.statuses, "idle");
      failing = true;

      const history = f.controller.history();
      if (history?.canRestore === undefined) throw new Error("no history");
      expect(await history.canRestore()).toBe(true);
      await f.controller.stop();
    });
  });
});

describe("a device removed from another device (#590)", () => {
  it("tells the user, keeps the unsynced edit on disk, and pushes it once the user registers this device again", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");

    server.removed.add("device-1");
    await f.vault.write("unsynced.md", bytes("written after the removal"));
    await f.controller.syncNow();

    const status = await statusBecomes(f.statuses, "device-removed");
    expect(status?.message).toMatch(/This device was removed from your account/);
    expect(status?.message).toMatch(/register this device again in Vault Sync's settings/);
    expect(status?.message).not.toMatch(/NOT_FOUND|not found/i);
    await vi.waitFor(() => {
      expect(f.events).toEqual([`start ${server.sync.vaultId} as device-1`, `stopped ${server.sync.vaultId}`]);
    });
    expect(new TextDecoder().decode(await f.vault.read("unsynced.md"))).toBe("written after the removal");
    expect(server.sync.liveFiles()).toEqual(new Map());
    // Stored, so a restart of Obsidian waits for the user too.
    expect(parsePluginData(JSON.parse(JSON.stringify(f.data))).device).toMatchObject({ id: "device-1", removed: true });

    // Never registered again without the user: not on an update or a restart.
    await f.controller.update();
    await f.controller.restart();
    expect(f.statuses.at(-1)?.state).toBe("device-removed");
    expect(server.registered).toEqual(["desktop"]);
    expect(f.events).toHaveLength(2);

    await f.controller.registerAgain();
    await statusBecomes(f.statuses, "idle");
    expect(server.registered).toEqual(["desktop", "desktop"]);
    expect(f.data.device).toEqual({ id: "device-2", serverUrl: "https://sync.example", issuer: "https://auth.example/", subject: "alice" });
    expect(server.sync.liveFiles()).toEqual(new Map([["unsynced.md", "written after the removal"]]));
    expect(server.sync.revisionAt(1n).deviceId).toBe("device-2");
    expect(await f.controller.session?.rejected()).toEqual([]);
    await f.controller.stop();
  });

  it("does not report an edit as refused when its commit landed, its response was lost, and the device was removed before the retry", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");

    let lost = false;
    server.sync.responseInterceptor = (method, request) => {
      if (method !== "CommitRevision" || lost) return;
      lost = true;
      // The commit landed; the device is removed before the response arrives.
      server.removed.add((request as CommitRevisionRequest).deviceId);
      throw new ConnectError("connection reset", Code.Unavailable);
    };
    await f.vault.write("note.md", bytes("the edit"));
    await f.controller.syncNow();
    await statusBecomes(f.statuses, "device-removed");
    expect(server.sync.currentHeadSeq).toBe(1n);

    await f.controller.registerAgain();
    const status = await statusBecomes(f.statuses, "idle");

    expect(status).toEqual({ state: "idle", conflicts: 0, pending: 0 });
    expect(await f.controller.session?.rejected()).toEqual([]);
    // Committed once, by the device that committed it.
    expect(server.sync.currentHeadSeq).toBe(1n);
    expect(server.sync.revisionAt(1n).deviceId).toBe("device-1");
    expect(server.sync.liveFiles()).toEqual(new Map([["note.md", "the edit"]]));
    expect(new TextDecoder().decode(await f.vault.read("note.md"))).toBe("the edit");
    await f.controller.stop();
  });

  it("does not take a NOT_FOUND without the device reason for a removed device", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");

    server.sync.interceptor = (method) => {
      if (method === "CommitRevision") throw new ConnectError("vault not found", Code.NotFound);
    };
    await f.vault.write("note.md", bytes("the edit"));
    await f.controller.syncNow();

    await statusBecomes(f.statuses, "error");
    expect(f.data.device?.removed).toBeUndefined();
    expect(f.events).toEqual([`start ${server.sync.vaultId} as device-1`]);
    await f.controller.stop();
  });

  it("registers again only a device marked removed", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");

    await f.controller.registerAgain();

    expect(server.registered).toEqual(["desktop"]);
    expect(f.data.device?.id).toBe("device-1");
    await f.controller.stop();
  });
});

describe("the device list (#590)", () => {
  const formatDate = (date: Date) => date.toISOString();

  it("lists the user's devices with their last activity and marks this one", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    await ensureDevice({ data: { ...settings }, save: () => Promise.resolve(), client: server.client, accessToken: () => Promise.resolve(tokenFor("alice")), defaultDeviceName: "‮Phone" });
    const phone = server.devices[1];
    if (phone === undefined) throw new Error("no second device");
    phone.lastActivityTime = timestampFromDate(new Date("2026-10-20T14:03:00Z"));

    const rows = deviceRows(await listDevices(server.client), currentDeviceId(f.data), formatDate);

    expect(rows).toEqual([
      { id: "device-1", label: "⁨desktop⁩", current: true, description: "This device. Has not synced a change yet." },
      { id: "device-2", label: "⁨Phone⁩", current: false, description: "Last synced a change 2026-10-20T14:03:00.000Z." },
    ]);
    await f.controller.stop();
  });

  it("removes another device, which then cannot sync, and never this one", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    await ensureDevice({ data: { ...settings }, save: () => Promise.resolve(), client: server.client, accessToken: () => Promise.resolve(tokenFor("alice")), defaultDeviceName: "Phone" });

    await expect(removeOtherDevice(server.client, f.data, "device-1")).rejects.toThrow(/cannot remove itself/);
    await removeOtherDevice(server.client, f.data, "device-2");

    expect(deviceRows(await listDevices(server.client), currentDeviceId(f.data), formatDate).map((row) => row.id)).toEqual(["device-1"]);
    expect(server.removed).toEqual(new Set(["device-2"]));
    await f.controller.stop();
  });
});
