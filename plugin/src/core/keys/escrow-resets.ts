/**
 * The escrow reset entries of a vault's verified membership log
 * (docs/design/encryption.md, "Adoption in a vault"): each one moved the
 * vault's escrow to a bundle that no signed rotation leads to, after an
 * owner accepted it. A member's device shows a notice once for each, with
 * both fingerprints and the owner who signed it.
 */
import { verifySignature, type EscrowBundle } from "../e2ee/identity";
import { entryBody, EntryType, Role, type Entry, type LogState } from "../e2ee/memberlog";

/** One escrow reset entry of a verified log. */
export interface EscrowReset {
  /** The entry's position in the log. */
  seq: number;
  /** The owner who signed it. */
  ownerId: string;
  /** The escrow bundle the log named before it. */
  previous: EscrowBundle;
  /** The escrow bundle it moved the vault to. */
  adopted: EscrowBundle;
}

/** The escrow reset entries of `log`, verified, with `states` the membership after each of its entries. */
export function escrowResets(log: readonly Entry[], states: readonly LogState[]): EscrowReset[] {
  const resets: EscrowReset[] = [];
  log.forEach((entry, index) => {
    if (entry.type !== EntryType.escrowReset) return;
    const before = states[index - 1];
    const after = states[index];
    const previous = before?.lastEscrow;
    const adopted = after?.lastEscrow;
    if (before === undefined || previous === undefined || adopted === undefined) return;
    const body = entryBody(entry);
    const signature = entry.signatures[0] ?? new Uint8Array();
    const owner = [...before.members].find(([, member]) => member.role === Role.owner && verifySignature(member.bundle.signPub, body, signature));
    if (owner === undefined) return;
    resets.push({ seq: entry.seq, ownerId: owner[0], previous, adopted });
  });
  return resets;
}
