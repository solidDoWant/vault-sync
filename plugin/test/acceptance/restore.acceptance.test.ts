/// <reference types="node" />
import { describe, expect, it } from "vitest";

import { configured, createVault, RealDevice, serverFiles } from "./real-server";

// AC-22 (docs/acceptance/phase-2.md): the operator stops the server,
// restores an earlier PostgreSQL and S3 snapshot, and starts it again. The
// `integration`-tagged Go test TestAC22OfflineRestore does the operator's
// part when this suite asks through VAULT_SYNC_IT_CONTROL_URL; the device
// reaches the server through a proxy at a fixed address.
const controlUrl = process.env.VAULT_SYNC_IT_CONTROL_URL ?? "";

async function operator(action: "snapshot" | "restore"): Promise<void> {
  const response = await fetch(`${controlUrl}/${action}`, { method: "POST" });
  if (!response.ok) throw new Error(`${action} failed: ${String(response.status)} ${await response.text()}`);
}

describe.skipIf(!configured || controlUrl === "")("offline restore against a real server", () => {
  it("[AC-22] a connected device resyncs after an offline restore and re-uploads every file only it held", async () => {
    const vaultId = await createVault("restored");
    const a = await RealDevice.register(vaultId, "device-a");
    await a.write("kept.md", "in the snapshot");
    await a.write("edited.md", "before the snapshot");
    await a.write("Folder/picture.png", "picture in the snapshot");
    await a.sync();
    await operator("snapshot");

    // After the snapshot: changes the restore loses on the server, but the device still holds.
    await a.write("new.md", "created after the snapshot");
    await a.write("Folder/later.png", "attachment after the snapshot");
    await a.write("edited.md", "edited after the snapshot");
    await a.sync();
    const before = await a.files();
    expect((await serverFiles(vaultId)).files).toEqual(before);

    await operator("restore");
    expect((await serverFiles(vaultId)).files).toEqual({
      "Folder/picture.png": "picture in the snapshot",
      "edited.md": "before the snapshot",
      "kept.md": "in the snapshot",
    });

    await a.sync();
    await a.sync();
    const after = await a.files();
    const { files: heads } = await serverFiles(vaultId);
    expect(after).toEqual(heads);
    expect((await a.journal.load()).pending).toEqual([]);

    // Every file only the device held is back on the server.
    expect(heads["new.md"]).toBe("created after the snapshot");
    expect(heads["Folder/later.png"]).toBe("attachment after the snapshot");
    expect(heads["kept.md"]).toBe("in the snapshot");
    // Nothing is lost: the edit the restore dropped is at the path or in a conflict copy (engine.md §9).
    const contents = Object.values(heads);
    expect(contents).toContain("edited after the snapshot");
    expect(contents).toContain("before the snapshot");

    // A second device sees the same files.
    const b = await RealDevice.register(vaultId, "device-b");
    await b.sync();
    expect(await b.files()).toEqual(heads);
  });
});
