import { describe, expect, it } from "vitest";

import type { ActivityEntry } from "./activity-log";
import { InMemoryServer } from "./memory-server";
import { Device, encryptedServer } from "./testing";

/** A device whose engine records every sync event it reports. */
function recording(server: InMemoryServer, deviceId: string, time = 1000): { device: Device; events: ActivityEntry[] } {
  const events: ActivityEntry[] = [];
  const device = new Device(server, deviceId, { now: () => time, onEvent: (event) => events.push(event) });
  return { device, events };
}

describe("sync events", () => {
  it("reports each pushed file as uploaded and a pushed deletion as deleted on the server", async () => {
    const server = new InMemoryServer();
    const { device: a, events } = recording(server, "device-a", 42);
    await a.write("note.md", "one");
    await a.sync();
    expect(events).toEqual([{ kind: "uploaded", path: "note.md", folder: false, time: 42 }]);

    events.length = 0;
    await a.vault.delete("note.md");
    await a.sync();
    expect(events).toEqual([{ kind: "deleted-on-server", path: "note.md", folder: false, time: 42 }]);
  });

  it("reports each applied remote change as downloaded and a remote deletion as deleted here", async () => {
    const server = new InMemoryServer();
    const { device: a } = recording(server, "device-a");
    const { device: b, events } = recording(server, "device-b", 7);
    await a.write("note.md", "one");
    await a.sync();
    await b.sync();
    expect(events).toEqual([{ kind: "downloaded", path: "note.md", folder: false, time: 7 }]);

    events.length = 0;
    await a.vault.delete("note.md");
    await a.sync();
    await b.sync();
    expect(events).toEqual([{ kind: "deleted-here", path: "note.md", folder: false, time: 7 }]);
  });

  it("does not report this device's own commits again when it pulls them", async () => {
    const server = new InMemoryServer();
    const { device: a, events } = recording(server, "device-a");
    await a.write("note.md", "one");
    await a.sync();
    await a.sync();
    expect(events.map((event) => event.kind)).toEqual(["uploaded"]);
  });

  it("reports a conflict copy with its path", async () => {
    const server = new InMemoryServer();
    const { device: a } = recording(server, "device-a");
    const { device: b, events } = recording(server, "device-b");
    await a.vault.write("image.png", new Uint8Array([1]));
    await a.sync();
    await b.sync();
    await a.vault.write("image.png", new Uint8Array([2]));
    await a.sync();
    await b.vault.write("image.png", new Uint8Array([3]));
    events.length = 0;
    await b.sync();

    const copies = Object.keys(await b.files()).filter((path) => path !== "image.png");
    expect(copies).toHaveLength(1);
    expect(events).toContainEqual({ kind: "conflict", path: copies[0], time: 1000 });
  });

  it("reports the plaintext path of a change in an encrypted vault, on the device only", async () => {
    const { server, keys } = encryptedServer();
    const events: ActivityEntry[] = [];
    const a = new Device(server, "device-a", { keys, now: () => 1 });
    const b = new Device(server, "device-b", { keys, now: () => 1, onEvent: (event) => events.push(event) });
    await a.write("secret/plan.md", "one");
    await a.sync();
    await b.sync();
    expect(events).toContainEqual({ kind: "downloaded", path: "secret/plan.md", folder: false, time: 1 });
  });
});
