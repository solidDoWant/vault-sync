import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

it("a create whose reply was lost, then moved aside by rule W, does not stop the pull", async () => {
  const server = new InMemoryServer();
  const b = new Device(server, "device-b");
  await b.write("a.md", "B's note\n");
  // Between B's pull and its push, another device creates a.md and renames it to c.md.
  let first = true;
  server.interceptor = (method) => {
    if (method !== "CommitRevision" || !first) return;
    first = false;
    server.commit({ documentId: "other", path: "a.md", content: "A's note\n" });
    server.commit({ documentId: "other", path: "c.md" });
  };
  // B's create of a.md is committed (seq 3), but the reply is lost.
  let lose = true;
  server.responseInterceptor = (method) => {
    if (method === "CommitRevision" && lose) {
      lose = false;
      throw new ConnectError("connection reset", Code.Unavailable);
    }
  };
  await b.sync().catch(() => undefined);
  server.interceptor = undefined;
  server.responseInterceptor = undefined;
  for (let round = 0; round < 3; round++) await b.sync();
  server.commit({ documentId: "other", path: "c.md", content: "A's note, edited\n" });
  for (let round = 0; round < 3; round++) await b.sync();
  expect(b.engine.status).toBe("idle"); // passes: the stall is silent
  expect((await b.journal.load()).cursor.seq).toBe(server.currentHeadSeq); // actual: 2, head 4
  expect((await b.files())["c.md"]).toBe("A's note, edited\n"); // actual: "A's note\n"
});
