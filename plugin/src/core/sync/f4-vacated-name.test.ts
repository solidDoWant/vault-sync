import { expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

async function converge(a: Device, b: Device): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await a.sync();
    await b.sync();
  }
}

it("a rename onto a name this device vacated syncs when the vacating rename is refused first (P1)", async () => {
  const server = new InMemoryServer();
  const a = new Device(server, "device-a");
  const b = new Device(server, "device-b");
  await a.engine.start();
  await b.engine.start();
  await a.write("x.md", "note x\n");
  await a.write("y.md", "note y\n");
  await converge(a, b);
  // On B, offline: x.md moves to z.md, and y.md takes the name x.md. A edits x.md meanwhile.
  await b.vault.rename("x.md", "z.md");
  await b.vault.rename("y.md", "x.md");
  await a.write("x.md", "note x\nedited on A\n");
  await a.sync();
  await converge(a, b);
  expect(await b.engine.refusedNames()).toEqual([]); // actual: [{ path: "x.md", reason: "another live document has this path" }]
  expect(await a.files()).toEqual(await b.files()); // actual: A has y.md, B has x.md
  await b.write("x.md", "note y\nedited on B\n");
  await converge(a, b);
  expect(Object.values(await a.files())).toContain("note y\nedited on B\n"); // actual: B's edit never leaves B
});
