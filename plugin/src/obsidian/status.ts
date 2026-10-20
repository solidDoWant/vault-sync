import { Code, ConnectError } from "@connectrpc/connect";

import { IdentityProviderError } from "../core/auth/oidc";

// The plugin's sync status (docs/plugin.md, "Status"), shown in the status
// bar and the settings. No Obsidian import, so it is unit-tested directly.

/**
 * - `signed-out`, `sign-in-required`: no session; sync is paused.
 * - `not-connected`: signed in, but this vault is connected to no server vault.
 * - `starting`: registering the device and opening the journal.
 * - `waiting-for-journal`: the journal's upgrade waits for another Obsidian window to close it.
 * - `syncing`: a pull or push is running.
 * - `idle`: the last pull or push succeeded.
 * - `offline`: the last one could not reach the server.
 * - `error`: the last one failed for another reason (`message` says why).
 */
export type SyncState = "signed-out" | "sign-in-required" | "not-connected" | "starting" | "waiting-for-journal" | "syncing" | "idle" | "offline" | "error";

export interface SyncStatus {
  state: SyncState;
  /** Conflicts not yet resolved: conflict copies that still exist, and conflicts left without a copy whose remote revision still waits. */
  conflicts: number;
  /** Local changes recorded in the journal and not yet acknowledged by the server. */
  pending: number;
  /** Why, for `error` (and `offline`). Never contains tokens or note content. */
  message?: string;
}

export const initialStatus: SyncStatus = {
  state: "signed-out",
  conflicts: 0,
  pending: 0,
};

/** Whether `error` means the server or the identity provider could not be reached (no network, DNS, a proxy's 502/503/504, a timeout). */
export function isOffline(error: unknown): boolean {
  if (error instanceof IdentityProviderError) return true;
  return error instanceof ConnectError && (error.code === Code.Unavailable || error.code === Code.DeadlineExceeded);
}

/** A message for `error` that is safe to show and log: errors in this plugin never carry tokens or note content. */
export function errorMessage(error: unknown): string {
  if (error instanceof ConnectError) return error.rawMessage === "" ? Code[error.code] : error.rawMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}

const labels: Record<SyncState, string> = {
  "signed-out": "signed out",
  "sign-in-required": "sign-in needed",
  "not-connected": "no vault connected",
  starting: "starting",
  "waiting-for-journal": "waiting for another window",
  syncing: "syncing",
  idle: "idle",
  offline: "offline",
  error: "error",
};

/** The status bar's text, e.g. `Vault Sync: idle · 2 conflicts`. */
export function statusText(status: SyncStatus): string {
  const parts = [`Vault Sync: ${labels[status.state]}`];
  if (status.pending > 0) parts.push(`${String(status.pending)} pending`);
  if (status.conflicts > 0) parts.push(`${String(status.conflicts)} ${status.conflicts === 1 ? "conflict" : "conflicts"}`);
  return parts.join(" · ");
}

/** A longer description, for the status bar's tooltip and the settings. */
export function statusDescription(status: SyncStatus): string {
  const detail: Record<SyncState, string> = {
    "signed-out": "Not signed in. Sign in to sync this vault.",
    "sign-in-required": "Your session ended. Sync is paused until you sign in again; local changes are kept and pushed afterwards.",
    "not-connected": "Signed in. Connect this vault to a remote vault to start syncing.",
    starting: "Starting sync.",
    "waiting-for-journal":
      "Sync is waiting for another Obsidian window with this vault open, which runs an older Vault Sync, to close its sync journal. Close that window or update Vault Sync there.",
    syncing: "Syncing.",
    idle: "Up to date with the server.",
    offline: "Cannot reach the server. Local changes are kept and pushed once it is reachable again.",
    error: "Sync failed. Local changes are kept and pushed by a later sync.",
  };
  const lines = [detail[status.state]];
  if (status.message !== undefined && status.message !== "") lines.push(status.message);
  if (status.pending > 0) lines.push(`${String(status.pending)} local ${status.pending === 1 ? "change is" : "changes are"} waiting to be pushed.`);
  if (status.conflicts > 0) lines.push(`${String(status.conflicts)} ${status.conflicts === 1 ? "conflict needs" : "conflicts need"} your attention.`);
  return lines.join(" ");
}
