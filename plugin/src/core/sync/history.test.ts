import { describe, expect, it } from "vitest";

import { createProtocolClient } from "../protocol/client";
import { documentHistory } from "./history";
import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

describe("document history", () => {
  it("names the user and the device of each version, for edits by two users", async () => {
    const server = new InMemoryServer();
    server.deviceUsers.set("laptop", "user-alice");
    server.deviceUsers.set("phone", "user-bob");
    server.userNames.set("user-alice", "Alice Example");
    server.userNames.set("user-bob", "bob");
    server.deviceNames.set("laptop", "Alice's laptop");
    server.deviceNames.set("phone", "Bob's phone");
    const alice = new Device(server, "laptop");
    const bob = new Device(server, "phone");

    await alice.write("plan.md", "one\n");
    await alice.sync();
    await bob.sync();
    await bob.write("plan.md", "one\ntwo\n");
    await bob.sync();

    const documentId = server.liveDocuments().get("plan.md") ?? "";
    const page = await documentHistory(createProtocolClient({ transport: server.transport }), server.vaultId, "laptop", documentId);
    expect(page.entries.map(({ userId, userName, deviceId, deviceName }) => ({ userId, userName, deviceId, deviceName }))).toEqual([
      { userId: "user-bob", userName: "bob", deviceId: "phone", deviceName: "Bob's phone" },
      { userId: "user-alice", userName: "Alice Example", deviceId: "laptop", deviceName: "Alice's laptop" },
    ]);
  });
});
