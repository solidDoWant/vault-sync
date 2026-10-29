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
import { sha256Hex } from "../hash";
import type { UserKeyPair } from "./user-key";
import { VaultKeyManager, vaultKeyStatusMessage, type EpochKeyStore, type EscrowRecipient, type MemberKeyClient, type VaultKeyClient } from "./vault-keys";

/** The VaultService call creating a vault (ProtocolClient.vaults). */
export type VaultCreateClient = Pick<Client<typeof VaultService>, "createVault">;

/** What the server offers for escrow: its escrow key, if it has one, and whether escrow is on by default. */
export interface EscrowOffer {
  /** The escrow key; undefined when the server has none, and escrow cannot be turned on. */
  recipient: EscrowRecipient | undefined;
  /** Whether a new encrypted vault has escrow unless its owner turns it off. */
  byDefault: boolean;
}

/**
 * The escrow offer of a GetServerInfo response. A published key must be a
 * hybrid public key named by its id, `sha256:` and the hex SHA-256 of the
 * key, so that an escrow slot always names the key it is wrapped to;
 * anything else is refused rather than escrowed to.
 */
export function escrowOffer(info: Pick<GetServerInfoResponse, "escrowPublicKey" | "escrowKeyId" | "escrowDefault">): EscrowOffer {
  if (info.escrowPublicKey.length === 0) return { recipient: undefined, byDefault: false };
  if (info.escrowPublicKey.length !== PUBLIC_KEY_SIZE) throw new Error("the server's escrow key is malformed");
  if (info.escrowKeyId !== `sha256:${sha256Hex(info.escrowPublicKey)}`) throw new Error("the server's escrow key id does not name its escrow key");
  return { recipient: { keyId: info.escrowKeyId, publicKey: info.escrowPublicKey }, byDefault: info.escrowDefault };
}

export interface CreateEncryptedVaultOptions {
  name: string;
  /** The escrow key to wrap every epoch key to, or undefined for a vault without escrow. */
  escrow: EscrowRecipient | undefined;
  /** The signed-in user's unlocked key pair: the owner's slot is wrapped to it. */
  userKey: UserKeyPair;
  vaults: VaultCreateClient;
  keys: VaultKeyClient;
  membership: MemberKeyClient;
  /** Where this device keeps the new vault's epoch keys. */
  store: (vaultId: string) => EpochKeyStore;
}

/**
 * Creates an end-to-end encrypted vault owned by the signed-in user, then its
 * epoch 1: a fresh key, wrapped on this device to the owner and, with
 * escrow, to the escrow key. Resolves with the vault once this device holds
 * the key of its current epoch.
 */
export async function createEncryptedVault(options: CreateEncryptedVaultOptions): Promise<Vault> {
  const { escrow } = options;
  const response = await options.vaults.createVault({ name: options.name, encryption: VaultEncryption.E2EE, escrow: escrow !== undefined });
  const vault = response.vault;
  if (vault === undefined) throw new Error("the server created the vault but returned none");
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
