import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { ErrorDetailSchema, ErrorReason } from "../../gen/vaultsync/v1/errors_pb";
import { deriveSubkey, pathKey } from "../e2ee/e2ee";
import { createProtocolClient } from "../protocol/client";
import { InMemoryServer } from "./memory-server";
import { reencryptHistory } from "./rekey";
import { RemoteContentError } from "./remote";
import { Device, TestKeyring } from "./testing";

/**
 * A plaintext vault with history (edits, a folder, a rename and a delete) on
 * two devices, then converted in place to encryption at epoch 1.
 */
async function convertedVault() {
  const server = new InMemoryServer({ vaultId: "0190d6e4-8c1e-7a3b-9d2f-5e6a7b8c9d0e" });
  const a = new Device(server, "device-a");
  const b = new Device(server, "device-b");
  await a.vault.createFolder("Projects");
  await a.write("Projects/plan.md", "one\n");
  await a.write("gone.md", "deleted\n");
  await a.write("kept.md", "kept\n");
  await a.sync();
  await b.sync();
  await a.write("Projects/plan.md", "one\ntwo\n");
  await a.vault.delete("gone.md");
  await a.vault.rename("kept.md", "renamed.md");
  await a.sync();
  await b.sync();
  const before = server.liveFiles();
  const keys = new TestKeyring(server);
  keys.rotate();
  const first = keys.epochKey(1);
  if (first === undefined) throw new Error("no epoch 1 key");
  server.convert((path) => pathKey(deriveSubkey(first, "path_key_secret"), path));
  server.reader = (revision, blob) => keys.reveal(revision, blob);
  return { server, keys, a, b, before };
}

function isVaultEncrypted(error: unknown): boolean {
  return (
    error instanceof ConnectError &&
    error.code === Code.FailedPrecondition &&
    error.findDetails(ErrorDetailSchema).some((detail) => detail.reason === ErrorReason.VAULT_ENCRYPTED)
  );
}

describe("reading a converted vault", () => {
  it("[P4-10] reads epoch-0 history as plaintext, refuses plaintext commits, and the re-key job encrypts the history", async () => {
    const { server, keys, b, before } = await convertedVault();
    const conversionSeq = server.conversionSeq;
    expect(conversionSeq).toBeGreaterThan(0n);

    // A device that has not seen the conversion: its plaintext commit is refused.
    await b.write("late.md", "plaintext\n");
    const refused = await b.sync().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isVaultEncrypted(refused)).toBe(true);
    expect(server.currentHeadSeq).toBe(conversionSeq);

    // A new device reads the plaintext history of the converted vault.
    const fresh = new Device(server, "device-c", { keys });
    await fresh.sync();
    expect(await fresh.files()).toEqual({ "Projects/plan.md": "one\ntwo\n", "renamed.md": "kept\n" });
    expect(new Map(Object.entries(await fresh.files()))).toEqual(before);

    // It edits under epoch 1.
    await fresh.write("renamed.md", "kept\nencrypted\n");
    await fresh.sync();
    expect(server.revisionAt(server.currentHeadSeq).epoch).toBe(1);

    // The re-key job moves every epoch-0 revision onto epoch 1.
    await reencryptHistory(createProtocolClient({ transport: server.transport }), server.vaultId, keys);
    for (let seq = 1n; seq <= server.currentHeadSeq; seq++) expect(server.revisionAt(seq).epoch, `seq ${String(seq)}`).toBe(1);
    const after = new Device(server, "device-d", { keys });
    await after.sync();
    expect(await after.files()).toEqual({ "Projects/plan.md": "one\ntwo\n", "renamed.md": "kept\nencrypted\n" });
  });

  it("[P4-10] refuses an epoch-0 revision committed after the conversion", async () => {
    const { server, keys } = await convertedVault();
    // The server claims the conversion happened before the vault's last plaintext revision.
    server.conversionSeq -= 1n;
    const fresh = new Device(server, "device-c", { keys });

    await expect(fresh.sync()).rejects.toBeInstanceOf(RemoteContentError);
  });
});
