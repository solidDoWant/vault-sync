/**
 * The user's sealed anchor list (docs/design/encryption.md, "Trust
 * anchors"): the genesis hash of every encrypted vault the user created or
 * joined, sealed with a key from the user's secret so the server can neither
 * read nor change it. It is stored as a compare-and-set on its version, so a
 * device that loses the race reads the list again and adds its anchor to
 * the newer one.
 */
import { Code, ConnectError, type Client } from "@connectrpc/connect";

import type { UserKeyService } from "../../gen/vaultsync/v1/user_key_pb";
import { anchorKey, openAnchorList, sealAnchorList, type Anchor } from "../e2ee/identity";
import { equalBytes } from "@noble/ciphers/utils.js";
import type { UserKeyPair } from "./user-key";

/** The UserKeyService calls that read and write the anchor list (ProtocolClient.userKeys). */
export type AnchorListClient = Pick<Client<typeof UserKeyService>, "getAnchorList" | "putAnchorList">;

/** Attempts when other devices keep writing the list first. */
const MAX_PUT_ATTEMPTS = 5;

/** The user's anchors as stored now, with the version they were sealed at (0 for none). */
export async function readAnchorList(client: AnchorListClient, userKey: UserKeyPair): Promise<{ version: number; anchors: Anchor[] }> {
  const response = await client.getAnchorList({});
  const version = Number(response.version);
  if (version === 0) return { version, anchors: [] };
  return { version, anchors: openAnchorList(anchorKey(userKey.privateKey), response.sealedList, userKey.userId, version) };
}

/**
 * Adds `anchor` to the user's anchor list unless it is there already,
 * retrying on top of the newer list when another device wrote first. An
 * anchor naming the vault with another genesis hash is refused: a vault's
 * anchor never changes.
 */
export async function addAnchor(client: AnchorListClient, userKey: UserKeyPair, anchor: Anchor): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const { version, anchors } = await readAnchorList(client, userKey);
    const existing = anchors.find((stored) => stored.vaultId === anchor.vaultId);
    if (existing !== undefined) {
      if (equalBytes(existing.genesisHash, anchor.genesisHash)) return;
      throw new Error("the anchor list already names this vault with another genesis");
    }
    const next = version + 1;
    try {
      await client.putAnchorList({ version: BigInt(next), sealedList: sealAnchorList(anchorKey(userKey.privateKey), userKey.userId, next, [...anchors, anchor]) });
      return;
    } catch (error) {
      if (!(error instanceof ConnectError && error.code === Code.FailedPrecondition) || attempt >= MAX_PUT_ATTEMPTS) throw error;
    }
  }
}
