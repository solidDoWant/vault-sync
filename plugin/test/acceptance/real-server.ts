/// <reference types="node" />
import { DocumentKind, VaultEncryption } from "../../src/gen/vaultsync/v1/types_pb";
import { createHttpTransport, createProtocolClient, type ProtocolClient } from "../../src/core/protocol/client";
import { downloadContent } from "../../src/core/sync/remote";
import { SyncEngine } from "../../src/core/sync/engine";
import { MemorySyncJournal } from "../../src/core/sync/journal";
import { InMemoryVault } from "../../src/core/vault/memory";

// Shared by the acceptance suites that run the sync engine against a real
// vault-sync-server. The `integration`-tagged Go tests in
// cmd/vault-sync-server/acceptance_integration_test.go start the server on
// PostgreSQL and S3, mint a token, and pass them through these variables;
// without them the suites are skipped.
export const serverUrl = process.env.VAULT_SYNC_IT_SERVER_URL ?? "";
export const token = process.env.VAULT_SYNC_IT_TOKEN ?? "";
export const configured = serverUrl !== "" && token !== "";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function client(): ProtocolClient {
  return createProtocolClient({
    transport: createHttpTransport(serverUrl),
    token: () => token,
  });
}

/** Creates a plaintext vault and returns its id. */
export async function createVault(name: string): Promise<string> {
  const response = await client().vaults.createVault({
    name,
    encryption: VaultEncryption.NONE,
  });
  if (response.vault === undefined) throw new Error("CreateVault returned no vault");
  return response.vault.id;
}

/** A device: an in-memory vault and journal, and the real engine on the real server. */
export class RealDevice {
  readonly vault: InMemoryVault;
  readonly journal = new MemorySyncJournal();
  engine: SyncEngine;

  private constructor(
    readonly vaultId: string,
    readonly deviceId: string,
    readonly name: string,
    private readonly now: () => number,
  ) {
    this.vault = new InMemoryVault({ now });
    this.engine = this.newEngine();
  }

  static async register(vaultId: string, name: string, now: () => number = Date.now): Promise<RealDevice> {
    const response = await client().devices.registerDevice({ name });
    if (response.device === undefined) throw new Error("RegisterDevice returned no device");
    return new RealDevice(vaultId, response.device.id, name, now);
  }

  sync(): Promise<void> {
    return this.engine.sync();
  }

  async files(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const path of (await this.vault.list()).sort()) result[path] = decoder.decode(await this.vault.read(path));
    return result;
  }

  write(path: string, text: string): Promise<void> {
    return this.vault.write(path, encoder.encode(text));
  }

  private newEngine(): SyncEngine {
    return new SyncEngine({
      api: client(),
      vaultId: this.vaultId,
      deviceId: this.deviceId,
      deviceName: this.name,
      vault: this.vault,
      journal: this.journal,
      now: this.now,
      debounceMs: null,
      intervalMs: null,
    });
  }
}

/** The server's live files: the head of every live document, read from the change list, by path. */
export async function serverFiles(vaultId: string): Promise<{ files: Record<string, string>; headSeq: bigint }> {
  const api = client();
  const heads = new Map<
    string,
    {
      path: string;
      deleted: boolean;
      kind: DocumentKind;
      hash: Uint8Array;
      size: bigint;
    }
  >();
  let since = 0n;
  let headSeq: bigint;
  for (;;) {
    const response = await api.sync.listChanges({ vaultId, sinceSeq: since });
    for (const revision of response.revisions) {
      heads.set(revision.documentId, {
        path: decoder.decode(revision.path),
        deleted: revision.deleted,
        kind: revision.kind,
        hash: revision.contentRef?.blobId ?? new Uint8Array(),
        size: revision.contentRef?.size ?? 0n,
      });
      since = revision.seq;
    }
    if (!response.hasMore) {
      headSeq = response.headSeq;
      break;
    }
  }
  const files: Record<string, string> = {};
  for (const head of [...heads.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    if (head.deleted || head.kind === DocumentKind.FOLDER) continue;
    const hex = Buffer.from(head.hash).toString("hex");
    files[head.path] = decoder.decode(await downloadContent(api, vaultId, hex, head.size));
  }
  return { files, headSeq };
}
