/**
 * Creating an end-to-end encrypted vault (docs/design/encryption.md,
 * "Creating a vault"): the owner's device creates the vault with CreateVault
 * and then its first key epoch, whose key it wraps itself to the owner and,
 * with escrow, to the deployment's escrow key. The server only ever stores
 * the wrapped keys and the epoch's key commitment.
 *
 * Escrow defaults to what the server publishes in GetServerInfo (on unless
 * the operator configured otherwise), and the owner can turn it off.
 */
import type { Client } from "@connectrpc/connect";

import type { GetServerInfoResponse } from "../../gen/vaultsync/v1/server_info_pb";
import { VaultEncryption, type Vault } from "../../gen/vaultsync/v1/types_pb";
import type { VaultService } from "../../gen/vaultsync/v1/vault_pb";
import { PUBLIC_KEY_SIZE } from "../e2ee/hybrid";
import { bundleOf, escrowKeyId, parseEscrowBundle, type EscrowBundle } from "../e2ee/identity";
import { entryHash, genesisPayload } from "../e2ee/memberlog";
import { sha256Hex } from "../hash";
import { addAnchor, type AnchorListClient } from "./anchor-list";
import { genesisEntry, toLogEntry } from "./member-log";
import type { UserKeyPair } from "./user-key";
import type { VerifiedLogStore } from "./verified-log";
import { VaultKeyManager, vaultKeyStatusMessage, type EpochKeyStore, type EscrowRecipient, type MemberKeyClient, type VaultKeyClient } from "./vault-keys";

/** The VaultService call creating a vault (ProtocolClient.vaults). */
export type VaultCreateClient = Pick<Client<typeof VaultService>, "createVault">;

/** The deployment's escrow key: the hybrid key epoch keys are wrapped to, and the escrow bundle a genesis entry names. */
export interface EscrowKey extends EscrowRecipient {
  bundle: EscrowBundle;
}

/** What the server offers for escrow: its escrow key, if it has one, and whether escrow is on by default. */
export interface EscrowOffer {
  /** The escrow key; undefined when the server has none, and escrow cannot be turned on. */
  recipient: EscrowKey | undefined;
  /** Whether a new encrypted vault has escrow unless its owner turns it off. */
  byDefault: boolean;
}

/**
 * The escrow offer of a GetServerInfo response. A published key must be a
 * hybrid public key named by its id, `sha256:` and the hex SHA-256 of the
 * key, so that an escrow slot always names the key it is wrapped to;
 * anything else is refused rather than escrowed to. The current escrow
 * bundle (the last rotation's, or the root bundle) must name the same key.
 */
export function escrowOffer(
  info: Pick<GetServerInfoResponse, "escrowPublicKey" | "escrowKeyId" | "escrowDefault" | "escrowRootBundle" | "escrowRotations">,
): EscrowOffer {
  if (info.escrowPublicKey.length === 0) return { recipient: undefined, byDefault: false };
  if (info.escrowPublicKey.length !== PUBLIC_KEY_SIZE) throw new Error("the server's escrow key is malformed");
  if (info.escrowKeyId !== `sha256:${sha256Hex(info.escrowPublicKey)}`) throw new Error("the server's escrow key id does not name its escrow key");
  const encoded = info.escrowRotations.at(-1)?.newBundle ?? info.escrowRootBundle;
  let bundle: EscrowBundle;
  try {
    bundle = parseEscrowBundle(encoded);
  } catch (error) {
    throw new Error("the server's escrow bundle is malformed", { cause: error });
  }
  if (escrowKeyId(bundle) !== info.escrowKeyId) throw new Error("the server's escrow bundle does not name its escrow key");
  return { recipient: { keyId: info.escrowKeyId, publicKey: info.escrowPublicKey, bundle }, byDefault: info.escrowDefault };
}

export interface CreateEncryptedVaultOptions {
  name: string;
  /** The escrow key to wrap every epoch key to and name in the genesis entry, or undefined for a vault without escrow. */
  escrow: EscrowKey | undefined;
  /** The signed-in user's unlocked key pair: the owner's slot is wrapped to it, and it signs the genesis entry. */
  userKey: UserKeyPair;
  vaults: VaultCreateClient;
  /** Where the user's sealed anchor list is kept. */
  anchors: AnchorListClient;
  /** What this device has verified: the new vault's genesis is its first verified position. */
  verifiedLogs: VerifiedLogStore;
  keys: VaultKeyClient;
  membership: MemberKeyClient;
  /** Where this device keeps the new vault's epoch keys. */
  store: (vaultId: string) => EpochKeyStore;
}

/**
 * Creates an end-to-end encrypted vault owned by the signed-in user, then its
 * epoch 1: a fresh key, wrapped on this device to the owner and, with
 * escrow, to the escrow key. The device picks the vault's id and signs its
 * genesis entry (the owner's bundle and, with escrow, the escrow bundle),
 * and adds the genesis hash to the user's anchor list before the vault
 * exists, so that no vault of the user's is ever without its anchor.
 * Resolves with the vault once this device holds the key of its current
 * epoch.
 */
export async function createEncryptedVault(options: CreateEncryptedVaultOptions): Promise<Vault> {
  const { escrow, userKey } = options;
  const vaultId = crypto.randomUUID();
  const creator = bundleOf({ kemSeed: userKey.privateKey, signSeed: userKey.signSeed }, userKey.userId);
  const genesis = genesisEntry(vaultId, genesisPayload(creator, escrow?.bundle), userKey.signSeed);
  const genesisHash = entryHash(genesis);
  await addAnchor(options.anchors, userKey, options.verifiedLogs, { vaultId, genesisHash });
  const response = await options.vaults.createVault({
    name: options.name,
    encryption: VaultEncryption.E2EE,
    escrow: escrow !== undefined,
    newVaultId: vaultId,
    genesis: toLogEntry(genesis),
  });
  const vault = response.vault;
  if (vault === undefined) throw new Error("the server created the vault but returned none");
  if (vault.id !== vaultId) throw new Error("the server created the vault under another id");
  await options.verifiedLogs.saveCheckpoint(vaultId, { seq: 1, hash: genesisHash });
  const manager = new VaultKeyManager({
    vaultId: vault.id,
    userKey: options.userKey,
    owner: true,
    keys: options.keys,
    membership: options.membership,
    store: options.store(vault.id),
    escrow,
  });
  // A new encrypted vault is rotation-pending: the owner's sync creates epoch 1.
  const state = await manager.sync();
  const problem = vaultKeyStatusMessage(state);
  if (problem !== undefined) throw new Error(`the vault was created, but its key is not ready: ${problem}`);
  return vault;
}
