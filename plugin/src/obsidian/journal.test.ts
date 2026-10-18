import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import type { App } from "obsidian";
import { describe, expect, it } from "vitest";

import { samplePending } from "../core/journal/conformance";
import { journalDatabaseName, openVaultJournal } from "./journal";

/** The part of Obsidian's App the journal reads: the open vault's id. */
const vault = (appId: unknown) => ({ appId }) as unknown as App;

const key = { serverUrl: "https://sync.example.com", vaultId: "vault-1" };

describe("openVaultJournal", () => {
  // One factory is one IndexedDB origin: every vault of an Obsidian install shares it.
  it("gives two vaults in one Obsidian install separate journals, even for the same server vault", async () => {
    const origin = new FakeIDBFactory();
    const first = await openVaultJournal(vault("aaaa1111"), key, origin);
    const second = await openVaultJournal(vault("bbbb2222"), key, origin);

    await first.setCursor(5n);
    await first.addPending(samplePending());

    expect(await second.getCursor()).toBe(0n);
    expect(await second.listPending()).toEqual([]);
    await second.setCursor(2n);
    expect(await first.getCursor()).toBe(5n);
    first.close();
    second.close();
  });

  it("reopens the same journal for the same vault, server and server vault", async () => {
    const origin = new FakeIDBFactory();
    const before = await openVaultJournal(vault("aaaa1111"), key, origin);
    await before.setCursor(5n);
    before.close();

    const after = await openVaultJournal(vault("aaaa1111"), { serverUrl: "https://SYNC.example.com:443/", vaultId: "vault-1" }, origin);
    expect(await after.getCursor()).toBe(5n);
    after.close();
  });

  it.each([
    ["another server vault", { ...key, vaultId: "vault-2" }],
    ["another server", { ...key, serverUrl: "https://other.example.com" }],
    ["another path on the server", { ...key, serverUrl: "https://sync.example.com/b" }],
  ])("keeps a separate journal for %s", async (_name, other) => {
    const origin = new FakeIDBFactory();
    const first = await openVaultJournal(vault("aaaa1111"), key, origin);
    await first.setCursor(5n);
    const second = await openVaultJournal(vault("aaaa1111"), other, origin);
    expect(await second.getCursor()).toBe(0n);
    first.close();
    second.close();
  });

  it.each([undefined, "", 42])("refuses to open a journal when Obsidian gives no vault id (%s)", async (appId) => {
    await expect(openVaultJournal(vault(appId), key, new FakeIDBFactory())).rejects.toThrow(/vault's id/);
  });
});

describe("journalDatabaseName", () => {
  it("cannot be confused by separators inside its parts", () => {
    expect(journalDatabaseName("a/b", { serverUrl: "https://c", vaultId: "d" })).not.toBe(journalDatabaseName("a", { serverUrl: "https://c", vaultId: "b/d" }));
  });
});
