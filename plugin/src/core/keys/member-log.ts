/**
 * Signing the next entry of an end-to-end encrypted vault's membership log
 * (docs/design/crypto.md, "Identity keys, the membership log and signed
 * epochs"): every membership change of such a vault carries its entry, which
 * the device builds on top of the log head it read and signs itself. When
 * another change took that position first, the server answers ABORTED and
 * the device rebuilds the entry on top of the new head.
 *
 * Verifying the log a device reads is not done here; this only places and
 * signs the entry the change needs.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

import type { LogEntry, LogEntrySchema } from "../../gen/vaultsync/v1/types_pb";
import type { VaultKeyService } from "../../gen/vaultsync/v1/vault_key_pb";
import { HASH_SIZE } from "../e2ee/identity";
import { EntryType, entryHash, signEntry, type Entry } from "../e2ee/memberlog";

/** The VaultKeyService call that reads the log (ProtocolClient.vaultKeys). */
export type LogReadClient = Pick<Client<typeof VaultKeyService>, "listLogEntries">;

/** A log entry as a request carries it. */
export type LogEntryInit = MessageInitShape<typeof LogEntrySchema>;

/** What one change appends: its type, payload and the seeds that sign it, in order. */
export interface UnsignedEntry {
  type: number;
  payload: Uint8Array;
  signSeeds: Uint8Array[];
}

/** Upper bound on pages read from the log, against a server that never ends it. */
const MAX_PAGES = 10_000;
/** Attempts when other changes keep taking the log's next position. */
const MAX_APPEND_ATTEMPTS = 3;

/** The entry as the device-side log functions take it. */
export function fromLogEntry(vaultId: string, entry: LogEntry): Entry {
  return { vaultId, seq: Number(entry.seq), prevHash: entry.prevHash, type: entry.type, payload: entry.payload, signatures: entry.signatures };
}

/** The entry as a request carries it. */
export function toLogEntry(entry: Entry): LogEntryInit {
  return { seq: BigInt(entry.seq), prevHash: entry.prevHash, type: entry.type, payload: entry.payload, signatures: entry.signatures };
}

/**
 * The vault's whole membership log as the server lists it, from genesis. A
 * newcomer, not yet a member, reads it with the `<id>` of its invite code.
 */
export async function readLog(client: LogReadClient, vaultId: string, invitationId = ""): Promise<Entry[]> {
  const entries: Entry[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.listLogEntries({ vaultId, pageToken, invitationId });
    for (const entry of response.entries) entries.push(fromLogEntry(vaultId, entry));
    if (response.nextPageToken === "") return entries;
    pageToken = response.nextPageToken;
  }
  throw new Error("the server's membership log does not end");
}

/** The genesis entry (seq 1) of a new vault, signed by its creator. */
export function genesisEntry(vaultId: string, payload: Uint8Array, signSeed: Uint8Array): Entry {
  return signEntry({ vaultId, seq: 1, prevHash: new Uint8Array(HASH_SIZE), type: EntryType.genesis, payload }, signSeed);
}

/** The entry `unsigned` places after the last of `log`, signed. */
export function nextEntry(vaultId: string, log: readonly Entry[], unsigned: UnsignedEntry): Entry {
  const head = log.at(-1);
  if (head === undefined) throw new Error("the vault's membership log is empty");
  return signEntry({ vaultId, seq: head.seq + 1, prevHash: entryHash(head), type: unsigned.type, payload: unsigned.payload }, ...unsigned.signSeeds);
}

/**
 * Sends one membership change with its entry: reads the log, builds the
 * entry with `build` on top of its head, and sends it with `send`. When the
 * server answers ABORTED (another change took that position), reads the
 * new head and tries again.
 */
export async function appendLogEntry<Result>(
  client: LogReadClient,
  vaultId: string,
  build: (log: readonly Entry[]) => UnsignedEntry,
  send: (entry: LogEntryInit) => Promise<Result>,
): Promise<Result> {
  for (let attempt = 1; ; attempt++) {
    const log = await readLog(client, vaultId);
    try {
      return await send(toLogEntry(nextEntry(vaultId, log, build(log))));
    } catch (error) {
      if (!(error instanceof ConnectError && error.code === Code.Aborted) || attempt >= MAX_APPEND_ATTEMPTS) throw error;
    }
  }
}
