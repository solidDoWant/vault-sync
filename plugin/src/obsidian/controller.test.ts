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
import { InMemoryServer } from "../core/sync/memory-server";
import { MemorySyncJournal } from "../core/sync/journal";
import { InMemoryRealtimeServer } from "../core/realtime/memory";
import { createProtocolClient, type ProtocolClient } from "../core/protocol/client";
import { InMemoryVault } from "../core/vault/memory";
import { connectNeedsConfirmation, connectProblem, DeviceLimitError, ensureDevice, listRemoteVaults, renameDevice, SyncController, type ClosableJournal } from "./controller";
import { currentDeviceId, DeviceListLoads, DeviceRemovals, deviceRows, type DeviceRow, listDevices, removeOtherDevice } from "./devices";
import { parsePluginData, type PluginData } from "./data";
import { DeviceNameEdits, DeviceNameError } from "./device-name";
import { SyncSession, type SyncSessionOptions } from "./session";
import { statusText, type SyncStatus } from "./status";

const bytes = (value: string) => new TextEncoder().encode(value);

/** An unsigned JWT for `subject`: the plugin only reads its claims. */
const tokenFor = (subject: string) => `e30.${btoa(JSON.stringify({ sub: subject, exp: 4_000_000_000, preferred_username: subject, name: `${subject} Example` })).replace(/=+$/, "")}.sig`;

afterEach(() => {
  vi.useRealTimers();
});

/** The device and vault services, faked; sync and blobs from an in-memory server. */
function fakeServer(
  options: {
    registerDevice?: (name: string, registrationId: string) => string;
    /** The name a registration answers with: a retry gets the device's current name, which a rename may have changed. */
    registeredName?: string;
    /** Called before every RenameDevice; throwing refuses it. */
    renameDevice?: (name: string) => void;
    role?: VaultRole;
    listVaults?: () => void;
  } = {},
) {
  const sync = new InMemoryServer();
  const registered: string[] = [];
  const registrationIds: string[] = [];
  /** The names RenameDevice was called with. */
  const renames: string[] = [];
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
  sync.interceptor = (method: string, request: unknown) => {
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
        const device = create(DeviceSchema, { id, name: options.registeredName ?? request.name });
        devices.push(device);
        return { device };
      },
      renameDevice: (request) => {
        renames.push(request.name);
        options.renameDevice?.(request.name);
        const device = devices.find((candidate) => candidate.id === request.deviceId && !removed.has(candidate.id));
        if (device === undefined) throw new ConnectError("device not found", Code.NotFound);
        device.name = request.name;
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
  return { sync, client, registered, registrationIds, renames, devices, removed, vaults };
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
  return Object.assign(new MemorySyncJournal(), {
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
  /** What the last save wrote to data.json, as Obsidian stores it; a restart of Obsidian reads it. */
  saved: string | undefined;
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
    saved: undefined,
    events,
    controller: new SyncController({
      data: () => data,
      save: () => {
        result.saves++;
        result.saved = JSON.stringify(data);
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

describe("renaming this device from the Device name setting", () => {
  const alice = () => Promise.resolve(tokenFor("alice"));

  /** A device registered as "Laptop" for alice, and the options to rename it. */
  async function registered(server: ReturnType<typeof fakeServer>) {
    const data: PluginData = { ...settings, deviceName: "Laptop" };
    const options = { data, save: () => Promise.resolve(), client: server.client, accessToken: alice, defaultDeviceName: "desktop" };
    await ensureDevice(options);
    return options;
  }

  it("renames the device to the edited setting, and the device list shows the new name", async () => {
    const server = fakeServer();
    const options = await registered(server);
    options.data.deviceName = "Work laptop";

    expect(await renameDevice(options, "Laptop")).toBe(true);

    expect(server.renames).toEqual(["Work laptop"]);
    expect((await listDevices(server.client)).map((device) => device.name)).toEqual(["Work laptop"]);
    expect(options.data.device?.name).toBe("Work laptop");
    expect(options.data.device?.id).toBe("device-1");
    // Stored, so a restart does not rename again.
    const reloaded = parsePluginData(JSON.parse(JSON.stringify(options.data)));
    expect(await renameDevice({ ...options, data: reloaded })).toBe(false);
    expect(server.renames).toEqual(["Work laptop"]);
  });

  it("does not call RenameDevice when the setting still names the device as the server accepted it", async () => {
    const server = fakeServer();
    const options = await registered(server);
    options.data.deviceName = "  Laptop\u200b ";

    expect(await renameDevice(options, "Laptop")).toBe(false);
    expect(server.renames).toEqual([]);
  });

  it("does nothing without a registered device, for another account's device or a removed one", async () => {
    const server = fakeServer();
    const unregistered = { data: { ...settings, deviceName: "Phone" }, save: () => Promise.resolve(), client: server.client, accessToken: alice, defaultDeviceName: "desktop" };
    expect(await renameDevice(unregistered)).toBe(false);

    const options = await registered(server);
    options.data.deviceName = "Phone";
    expect(await renameDevice({ ...options, accessToken: () => Promise.resolve(tokenFor("bob")) })).toBe(false);
    const device = options.data.device;
    if (device === undefined) throw new Error("not registered");
    options.data.device = { ...device, removed: true };
    expect(await renameDevice(options)).toBe(false);
    expect(server.renames).toEqual([]);
  });

  it("puts the setting back to the last name the server accepted when the rename fails", async () => {
    const server = fakeServer({
      renameDevice: () => {
        throw new ConnectError("name is not a valid device name", Code.InvalidArgument);
      },
    });
    const options = await registered(server);
    let saves = 0;
    options.save = () => {
      saves++;
      return Promise.resolve();
    };
    options.data.deviceName = "Phone\u0890";

    await expect(renameDevice(options, "Something else")).rejects.toThrow(/name is not a valid device name/);

    expect(options.data.deviceName).toBe("Laptop");
    expect(options.data.device?.name).toBe("Laptop");
    expect(saves).toBe(1);
    expect((await listDevices(server.client)).map((device) => device.name)).toEqual(["Laptop"]);
  });

  it("puts the setting back to its value before the edit for a device stored without the server's name", async () => {
    const server = fakeServer({
      renameDevice: () => {
        throw new ConnectError("unavailable", Code.Unavailable);
      },
    });
    const options = await registered(server);
    const device = options.data.device;
    if (device === undefined) throw new Error("not registered");
    options.data.device = { id: device.id, serverUrl: device.serverUrl, issuer: device.issuer, subject: device.subject };
    options.data.deviceName = "Phone";

    await expect(renameDevice(options, "")).rejects.toThrow();
    expect(options.data.deviceName).toBe("");
  });

  it("renames the device to the setting once a registration completes that was pending when the setting changed", async () => {
    const server = fakeServer();
    // A registration as "Laptop" was saved, and its response lost.
    const data: PluginData = { ...settings, deviceName: "Laptop" };
    const options = { data, save: () => Promise.resolve(), client: server.client, accessToken: alice, defaultDeviceName: "desktop" };
    const lost = fakeServer({
      registerDevice: () => {
        throw new ConnectError("unavailable", Code.Unavailable);
      },
    });
    await expect(ensureDevice({ ...options, client: lost.client })).rejects.toThrow();
    expect(data.pendingDevice?.name).toBe("Laptop");
    data.deviceName = "Work laptop";

    expect(await ensureDevice(options)).toBe("device-1");

    expect(server.registered).toEqual(["Laptop"]);
    expect(server.renames).toEqual(["Work laptop"]);
    expect(data.device?.name).toBe("Work laptop");
    expect(data.deviceName).toBe("Work laptop");
  });

  it("keeps the name the server returns when the setting did not change while the registration was pending", async () => {
    // The device was renamed from another installation before this retry.
    const server = fakeServer({ registeredName: "Renamed elsewhere" });
    const data: PluginData = { ...settings, deviceName: "Laptop" };

    expect(await ensureDevice({ data, save: () => Promise.resolve(), client: server.client, accessToken: alice, defaultDeviceName: "desktop" })).toBe("device-1");

    expect(server.renames).toEqual([]);
    expect(data.device?.name).toBe("Renamed elsewhere");
    expect(data.deviceName).toBe("Renamed elsewhere");
  });

  it("registers the device even when the rename after the pending registration fails, and reports the failure", async () => {
    const server = fakeServer({
      renameDevice: () => {
        throw new ConnectError("unavailable", Code.Unavailable);
      },
    });
    const data: PluginData = { ...settings, deviceName: "Laptop" };
    const failures: unknown[] = [];
    const options = { data, save: () => Promise.resolve(), client: server.client, accessToken: alice, defaultDeviceName: "desktop", onRenameFailed: (error: unknown) => failures.push(error) };
    const lost = fakeServer({
      registerDevice: () => {
        throw new ConnectError("unavailable", Code.Unavailable);
      },
    });
    await expect(ensureDevice({ ...options, client: lost.client })).rejects.toThrow();
    data.deviceName = "Work laptop";

    expect(await ensureDevice(options)).toBe("device-1");

    expect(server.renames).toEqual(["Work laptop"]);
    expect(failures).toHaveLength(1);
    expect(data.deviceName).toBe("Laptop");
    expect(data.device?.name).toBe("Laptop");
  });
});

describe("DeviceNameEdits", () => {
  it("renames once the edits have settled, not on every keystroke, with the setting from before the first edit", async () => {
    vi.useFakeTimers();
    const renames: string[] = [];
    const edits = new DeviceNameEdits(1000, (before) => {
      renames.push(before);
      return Promise.resolve();
    });

    edits.edited("Laptop");
    await vi.advanceTimersByTimeAsync(999);
    edits.edited("Laptop W");
    await vi.advanceTimersByTimeAsync(999);
    edits.edited("Laptop Wo");
    await vi.advanceTimersByTimeAsync(999);
    expect(renames).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(renames).toEqual(["Laptop"]);

    edits.edited("Laptop Work");
    await vi.advanceTimersByTimeAsync(1000);
    expect(renames).toEqual(["Laptop", "Laptop Work"]);
  });

  it("drops an edit that has not settled when cancelled", async () => {
    vi.useFakeTimers();
    const renames: string[] = [];
    const edits = new DeviceNameEdits(1000, (before) => {
      renames.push(before);
      return Promise.resolve();
    });
    edits.edited("Laptop");
    edits.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(renames).toEqual([]);
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
    expect((await f.controller.session?.listProblems())?.skipped.map(({ path, reason }) => ({ path, reason }))).toEqual([{ path: "CON.md", reason: "reserved-name" }]);
  });

  it("names conflict copies after the signed-in user's name and the Device name setting, without its invisible characters (#557)", async () => {
    const server = fakeServer();
    server.sync.commit({ documentId: "remote", path: "a.md", content: "remote version\n" });
    const f = fixture(server, connected({ ...settings, deviceName: "\u202eWork\u200b lap\u2066top\u2069\u200d" }, server.sync.vaultId));
    await f.vault.write("a.md", bytes("local version\n"));

    await f.controller.update();
    await statusBecomes(f.statuses, "idle");

    const copies = (await f.vault.list()).filter((path) => path !== "a.md");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^a \(Conflicted copy alice Example Work laptop \d{12}\)\.md$/u);
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

describe("a viewer device", () => {
  it("reads its role every sync cycle: as a viewer it pushes nothing and keeps a local copy, and as an editor it syncs on the next cycle", async () => {
    const server = fakeServer({ role: VaultRole.VIEWER });
    server.sync.commit({ documentId: "doc-a", path: "a.md", content: "shared" });
    const copies: [string, string][] = [];
    const readOnly: boolean[] = [];
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId), {
      onReadOnly: (value) => readOnly.push(value),
      keepLocalCopy: (path, content) => {
        copies.push([path, new TextDecoder().decode(content)]);
        return Promise.resolve();
      },
    });
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    expect(f.controller.readOnly).toBe(true);
    expect(readOnly).toEqual([true]);
    const head = server.sync.currentHeadSeq;

    await f.vault.write("a.md", new TextEncoder().encode("changed outside Obsidian"));
    await f.controller.syncNow();
    expect(server.sync.currentHeadSeq).toBe(head);
    expect(copies).toEqual([["a.md", "changed outside Obsidian"]]);
    expect(new TextDecoder().decode(await f.vault.read("a.md"))).toBe("shared");

    const member = server.vaults[0];
    if (member === undefined) throw new Error("no vault");
    member.role = VaultRole.EDITOR;
    await f.vault.write("a.md", new TextEncoder().encode("an editor's edit"));
    await f.controller.syncNow();
    expect(f.controller.readOnly).toBe(false);
    expect(readOnly).toEqual([true, false]);
    expect(server.sync.liveFiles().get("a.md")).toBe("an editor's edit");
    await f.controller.stop();
  });
  it("leaves viewer mode when the vault is disconnected", async () => {
    const server = fakeServer({ role: VaultRole.VIEWER });
    const readOnly: boolean[] = [];
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId), {
      onReadOnly: (value) => readOnly.push(value),
    });
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    expect(readOnly).toEqual([true]);

    delete f.data.vault;
    await f.controller.update();

    expect(f.controller.readOnly).toBe(false);
    expect(readOnly).toEqual([true, false]);
  });

  it("leaves viewer mode when another vault, where the user is an editor, is connected", async () => {
    const server = fakeServer({ role: VaultRole.VIEWER });
    const work = server.vaults[1];
    if (work === undefined) throw new Error("no vault");
    work.role = VaultRole.EDITOR;
    const readOnly: boolean[] = [];
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId), {
      onReadOnly: (value) => readOnly.push(value),
    });
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    expect(readOnly).toEqual([true]);

    connected(f.data, "vault-2");
    await f.controller.update();
    // The in-memory server syncs only the first vault, so the session for
    // vault-2 fails its pull; the role is read before that, at the start of the cycle.
    await vi.waitFor(() => {
      expect(readOnly).toEqual([true, false]);
    });
    expect(f.controller.readOnly).toBe(false);
    await f.controller.stop();
  });
});

describe("a device that loses access to its vault", () => {
  /** Makes the server answer as it does once the user lost access: the vault is no longer listed and every vault request is NOT_FOUND. */
  function loseAccess(server: ReturnType<typeof fakeServer>, reason?: ErrorReason): void {
    const index = server.vaults.findIndex((vault) => vault.id === server.sync.vaultId);
    server.vaults.splice(index, 1);
    const details = reason === undefined ? [] : [{ desc: ErrorDetailSchema, value: { reason } }];
    server.sync.interceptor = () => {
      throw new ConnectError("vault not found", Code.NotFound, undefined, details);
    };
  }

  it.each<[string, ErrorReason | undefined, SyncStatus["state"], string]>([
    ["removed or left", undefined, "not-member", "Vault Sync: no longer a member"],
    ["deleted", ErrorReason.VAULT_DELETED, "vault-deleted", "Vault Sync: vault deleted"],
  ])("stops syncing within one cycle when %s, keeps its files and journal, and shows why", async (_case, reason, state, text) => {
    const server = fakeServer();
    server.sync.commit({ documentId: "doc-a", path: "a.md", content: "shared" });
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");

    loseAccess(server, reason);
    await f.vault.write("a.md", bytes("edited after the loss"));
    await f.vault.write("new.md", bytes("a new note"));
    await f.controller.syncNow();

    const status = await statusBecomes(f.statuses, state);
    expect(status === undefined ? "" : statusText(status)).toBe(text);
    expect(f.controller.session).toBeUndefined();
    expect(f.events.at(-1)).toBe(`stopped ${server.sync.vaultId}`);
    expect(new TextDecoder().decode(await f.vault.read("a.md"))).toBe("edited after the loss");
    expect(new TextDecoder().decode(await f.vault.read("new.md"))).toBe("a new note");
    expect(f.data.vault?.id).toBe(server.sync.vaultId);

    // Nothing restarts it: an update for the same vault shows the loss again.
    await f.controller.update();
    expect(f.controller.session).toBeUndefined();
    expect(f.statuses.at(-1)?.state).toBe(state);
    expect(f.events.filter((event) => event.startsWith("start"))).toHaveLength(1);
  });

  it("syncs again once it was disconnected and connected after access came back", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    const vault = server.vaults[0];
    if (vault === undefined) throw new Error("no vault");
    loseAccess(server);
    await f.controller.syncNow();
    await statusBecomes(f.statuses, "not-member");

    server.vaults.unshift(vault);
    server.sync.interceptor = undefined;
    delete f.data.vault;
    await f.controller.update();
    connected(f.data, server.sync.vaultId);
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    expect(f.controller.session).toBeDefined();
    await f.controller.stop();
  });

  it("keeps syncing when the vault is missing from the list but the server still serves it", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    server.vaults.splice(0, 1);

    await f.vault.write("b.md", bytes("pushed"));
    await f.controller.syncNow();

    await statusBecomes(f.statuses, "idle");
    expect(server.sync.liveFiles().get("b.md")).toBe("pushed");
    await f.controller.stop();
  });

  it("leaves viewer mode when a viewer loses access", async () => {
    const server = fakeServer({ role: VaultRole.VIEWER });
    const readOnly: boolean[] = [];
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId), { onReadOnly: (value) => readOnly.push(value) });
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    loseAccess(server);
    await f.controller.syncNow();
    await statusBecomes(f.statuses, "not-member");
    expect(readOnly).toEqual([true, false]);
    expect(f.controller.readOnly).toBe(false);
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
    expect(f.saved).toBeDefined();
    expect(parsePluginData(JSON.parse(f.saved ?? "{}")).device).toMatchObject({ id: "device-1", removed: true });

    // Never registered again without the user: not on an update or a restart.
    await f.controller.update();
    await f.controller.restart();
    expect(f.statuses.at(-1)?.state).toBe("device-removed");
    expect(server.registered).toEqual(["desktop"]);
    expect(f.events).toHaveLength(2);

    await f.controller.registerAgain();
    await statusBecomes(f.statuses, "idle");
    expect(server.registered).toEqual(["desktop", "desktop"]);
    expect(f.data.device).toEqual({ id: "device-2", serverUrl: "https://sync.example", issuer: "https://auth.example/", subject: "alice", name: "desktop" });
    expect(server.sync.liveFiles()).toEqual(new Map([["unsynced.md", "written after the removal"]]));
    expect(server.sync.revisionAt(1n).deviceId).toBe("device-2");
    expect((await f.controller.session?.listProblems())?.refused).toEqual([]);
    await f.controller.stop();
  });

  it("still waits for the user after Obsidian restarts from the saved data (#625)", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    server.removed.add("device-1");
    await f.vault.write("unsynced.md", bytes("written after the removal"));
    await f.controller.syncNow();
    await statusBecomes(f.statuses, "device-removed");
    await f.controller.stop();

    // A new plugin instance, as after a restart, with only what data.json holds.
    const restarted = fixture(server, parsePluginData(JSON.parse(f.saved ?? "{}")));
    await restarted.controller.update();

    expect(restarted.statuses.at(-1)?.state).toBe("device-removed");
    expect(restarted.events).toEqual([]);
    expect(server.registered).toEqual(["desktop"]);
    await restarted.controller.stop();
  });

  it("does not report an edit as refused when its commit landed, its response was lost, and the device was removed before the retry", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");

    let lost = false;
    server.sync.responseInterceptor = (method: string, request: unknown) => {
      if (method !== "CommitRevision" || lost) return;
      lost = true;
      // The commit landed; the device is removed before the response arrives.
      server.removed.add((request as CommitRevisionRequest).deviceId);
      throw new ConnectError("connection reset", Code.Unavailable);
    };
    await f.vault.write("note.md", bytes("the edit"));
    await f.controller.syncNow();
    expect(server.sync.currentHeadSeq).toBe(1n);

    // The next sync finds the landed commit in the change list before it would commit again.
    await f.controller.syncNow();
    const status = await statusBecomes(f.statuses, "idle");

    expect(status).toEqual({ state: "idle", conflicts: 0, pending: 0 });
    expect((await f.controller.session?.listProblems())?.refused).toEqual([]);
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

    server.sync.interceptor = (method: string) => {
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

  it("sends one removal when the same device is removed twice, while the first runs or after it (#625)", async () => {
    const server = fakeServer();
    const f = fixture(server, connected({ ...settings }, server.sync.vaultId));
    await f.controller.update();
    await statusBecomes(f.statuses, "idle");
    await ensureDevice({ data: { ...settings }, save: () => Promise.resolve(), client: server.client, accessToken: () => Promise.resolve(tokenFor("alice")), defaultDeviceName: "Phone" });
    const requests: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const removals = new DeviceRemovals(async (deviceId) => {
      requests.push(deviceId);
      await held;
      await removeOtherDevice(server.client, f.data, deviceId);
    });

    const first = removals.start("device-2");
    const second = removals.start("device-2");
    expect(removals.has("device-2")).toBe(true);
    release();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    await expect(removals.start("device-2")).resolves.toBe(false);
    expect(requests).toEqual(["device-2"]);
    expect(server.removed).toEqual(new Set(["device-2"]));
    await f.controller.stop();
  });

  it("lets a failed removal be tried again (#625)", async () => {
    let attempts = 0;
    const removals = new DeviceRemovals(() => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error("offline")) : Promise.resolve();
    });

    await expect(removals.start("device-2")).rejects.toThrow("offline");
    expect(removals.has("device-2")).toBe(false);
    await expect(removals.start("device-2")).resolves.toBe(true);
    expect(attempts).toBe(2);
  });
});

describe("DeviceListLoads", () => {
  const row = (id: string): DeviceRow => ({ id, label: id, current: false, description: "" });

  /** A device list whose ListDevices calls are held until the test settles them, in any order. */
  function heldList() {
    const calls: { resolve(rows: DeviceRow[]): void; reject(error: Error): void }[] = [];
    const painted: string[][] = [];
    const errors: string[] = [];
    const loads = new DeviceListLoads(() => new Promise<DeviceRow[]>((resolve, reject) => calls.push({ resolve, reject })), {
      rows: (rows) => painted.push(rows.map((shown) => shown.id)),
      error: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    });
    return { loads, calls, painted, errors };
  }

  /** Lets the settled ListDevices calls' callbacks run. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("ignores an older ListDevices response that resolves after a reload's (#634)", async () => {
    const { loads, calls, painted } = heldList();
    loads.load();
    // A removal of device-2 succeeds and reloads the list while the first load is held.
    loads.load();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve([row("device-1")]);
    await settle();
    calls[0]?.resolve([row("device-1"), row("device-2")]);
    await settle();

    expect(painted).toEqual([["device-1"]]);
  });

  it("ignores an older ListDevices failure, and an older success after a reload's failure (#634)", async () => {
    const { loads, calls, painted, errors } = heldList();
    loads.load();
    loads.load();
    calls[1]?.resolve([row("device-1")]);
    await settle();
    calls[0]?.reject(new Error("offline"));
    await settle();
    expect(painted).toEqual([["device-1"]]);
    expect(errors).toEqual([]);

    loads.load();
    loads.load();
    calls[3]?.reject(new Error("offline"));
    await settle();
    calls[2]?.resolve([row("device-1"), row("device-2")]);
    await settle();
    expect(painted).toEqual([["device-1"]]);
    expect(errors).toEqual(["offline"]);
  });

  it("paints the latest load when it resolves last", async () => {
    const { loads, calls, painted } = heldList();
    loads.load();
    loads.load();
    calls[0]?.resolve([row("device-1"), row("device-2")]);
    await settle();
    calls[1]?.resolve([row("device-1")]);
    await settle();

    expect(painted).toEqual([["device-1"]]);
  });

  it("sends and paints nothing once the list is closed (#634)", async () => {
    const { loads, calls, painted, errors } = heldList();
    loads.load();
    loads.close();
    calls[0]?.resolve([row("device-1")]);
    await settle();
    // A removal that settles after the settings were closed reloads the list.
    loads.load();

    expect(calls).toHaveLength(1);
    expect(painted).toEqual([]);
    expect(errors).toEqual([]);
  });
});
