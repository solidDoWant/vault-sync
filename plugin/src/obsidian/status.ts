import { Code, ConnectError } from "@connectrpc/connect";

import { IdentityProviderError } from "../core/auth/oidc";
import type { ChangeKind, IncomingChange, PendingChange, SyncProgress } from "../core/sync/engine";
import { visiblePath } from "./display-text";

// The plugin's sync status (docs/plugin.md, "Status"), shown in the status
// bar and the settings. No Obsidian import, so it is unit-tested directly.

/**
 * - `signed-out`, `sign-in-required`: no session; sync is paused.
 * - `not-connected`: signed in, but this vault is connected to no server vault.
 * - `starting`: registering the device and opening the journal.
 * - `waiting-for-journal`: the journal's upgrade waits for another Obsidian window to close it.
 * - `syncing`: a pull or push is running.
 * - `idle`: the last pull or push succeeded.
 * - `reconnecting`: a pull or push is running after the last one could not reach the server.
 * - `offline`: the last one could not reach the server (`nextAttemptAt` says when sync tries again).
 * - `error`: the last one failed for another reason (`message` says why).
 * - `device-removed`: this device was removed from the account; sync waits until the user registers it again.
 * - `not-member`: the user is no longer a member of the connected vault (removed or left); sync is stopped and the files are kept.
 * - `vault-deleted`: an owner deleted the connected vault; sync is stopped and the files are kept.
 * - `verification-failed`: the server sent key or membership data of the end-to-end encrypted vault that doesn't verify; sync of the vault is stopped and the files are kept (docs/design/encryption.md, "Hard stop").
 */
export type SyncState =
  | "signed-out"
  | "sign-in-required"
  | "not-connected"
  | "starting"
  | "waiting-for-journal"
  | "syncing"
  | "reconnecting"
  | "idle"
  | "offline"
  | "error"
  | "device-removed"
  | "not-member"
  | "vault-deleted"
  | "verification-failed";

/** The states in which sync stopped for good until the user acts: they get a notice that stays. */
export function isStoppedState(state: SyncState): boolean {
  return state === "device-removed" || state === "not-member" || state === "vault-deleted" || state === "verification-failed";
}

export interface SyncStatus {
  state: SyncState;
  /** Conflicts not yet resolved: conflict copies that still exist, and conflicts left without a copy whose remote revision still waits. */
  conflicts: number;
  /** Local changes recorded in the journal and not yet acknowledged by the server. */
  pending: number;
  /** Why, for `error` (and `offline`). Never contains tokens or note content. */
  message?: string;
  /** The local changes waiting to be pushed, one per file; absent when there are none. */
  pendingFiles?: readonly PendingChange[];
  /** The remote changes the current pull learned and has not applied yet; absent when there are none. */
  incoming?: readonly IncomingChange[];
  /** How far the current pull or push is; absent when neither runs. */
  progress?: SyncProgress;
  /** While `offline`: when sync next tries to reach the server by itself, in milliseconds since the epoch. */
  nextAttemptAt?: number;
}

export const initialStatus: SyncStatus = {
  state: "signed-out",
  conflicts: 0,
  pending: 0,
};

/**
 * Whether `error` means the server or the identity provider could not be
 * reached (no network, DNS, a proxy's 502/503/504, a timeout, the provider's
 * 5xx). An identity provider's invalid answer is not offline but an error.
 */
export function isOffline(error: unknown): boolean {
  if (error instanceof IdentityProviderError) return error.unreachable;
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
  reconnecting: "reconnecting",
  idle: "idle",
  offline: "offline",
  error: "error",
  "device-removed": "device removed",
  "not-member": "no longer a member",
  "vault-deleted": "vault deleted",
  "verification-failed": "stopped: key data doesn't verify",
};

/** The status bar's text, e.g. `Vault Sync: syncing 40/312 · 12 incoming · 2 conflicts`. */
export function statusText(status: SyncStatus): string {
  const progress = status.state === "syncing" && status.progress !== undefined ? ` ${String(status.progress.done)}/${String(status.progress.total)}` : "";
  const parts = [`Vault Sync: ${labels[status.state]}${progress}`];
  if (status.pending > 0) parts.push(`${String(status.pending)} pending`);
  const incoming = status.incoming?.length ?? 0;
  if (incoming > 0) parts.push(`${String(incoming)} incoming`);
  if (status.conflicts > 0) parts.push(`${String(status.conflicts)} ${status.conflicts === 1 ? "conflict" : "conflicts"}`);
  return parts.join(" · ");
}

const icons: Record<SyncState, string> = {
  "signed-out": "log-in",
  "sign-in-required": "log-in",
  "not-connected": "unlink",
  starting: "loader",
  "waiting-for-journal": "loader",
  syncing: "refresh-cw",
  reconnecting: "wifi",
  idle: "check-circle",
  offline: "wifi-off",
  error: "alert-circle",
  "device-removed": "smartphone",
  "not-member": "user-x",
  "vault-deleted": "trash-2",
  "verification-failed": "shield-alert",
};

/**
 * The status as an icon (a Lucide icon id), for the ribbon on mobile, which
 * has no status bar. Unresolved conflicts show over `idle` and `syncing`,
 * incoming changes over `syncing`, and local changes waiting to be pushed
 * over `idle`.
 */
export function statusIcon(status: SyncStatus): string {
  const running = status.state === "idle" || status.state === "syncing";
  if (running && status.conflicts > 0) return "alert-triangle";
  if (status.state === "syncing" && (status.incoming?.length ?? 0) > 0) return "download-cloud";
  if (status.state === "idle" && status.pending > 0) return "upload-cloud";
  return icons[status.state];
}

/** A time of day in the user's locale, e.g. `10:15:30 PM`. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

/** A longer description, for the status bar's tooltip and the settings. `formatTime` writes the next attempt's time. */
export function statusDescription(status: SyncStatus, formatTime: (at: number) => string = clockTime): string {
  const detail: Record<SyncState, string> = {
    "signed-out": "Not signed in. Sign in to sync this vault.",
    "sign-in-required": "Your session ended. Sync is paused until you sign in again; local changes are kept and pushed afterwards.",
    "not-connected": "Signed in. Connect this vault to a remote vault to start syncing.",
    starting: "Starting sync.",
    "waiting-for-journal":
      "Sync is waiting for another Obsidian window with this vault open, which runs an older Vault Sync, to close its sync journal. Close that window or update Vault Sync there.",
    syncing: "Syncing.",
    reconnecting: "Trying to reach the server again.",
    idle: "Up to date with the server.",
    offline: "Cannot reach the server. Local changes are kept and pushed once it is reachable again.",
    error: "Sync failed. Local changes are kept and pushed by a later sync.",
    "device-removed": "Sync is stopped.",
    "not-member": "You are no longer a member of this vault, so sync is stopped. Your files stay in this vault.",
    "vault-deleted": "An owner deleted this vault on the server, so sync is stopped. Your files stay in this vault.",
    "verification-failed": "The server sent key or membership data that doesn't verify, so sync of this vault is stopped. Your files stay in this vault.",
  };
  const lines = [detail[status.state]];
  if (status.message !== undefined && status.message !== "") lines.push(status.message);
  if (status.state === "offline") {
    const next = status.nextAttemptAt === undefined ? "" : `Next try at ${formatTime(status.nextAttemptAt)}. `;
    lines.push(`${next}Use "Sync now" to try again at once.`);
  }
  if (status.pending > 0) lines.push(`${String(status.pending)} local ${status.pending === 1 ? "change is" : "changes are"} waiting to be pushed.`);
  if (status.conflicts > 0) lines.push(`${String(status.conflicts)} ${status.conflicts === 1 ? "conflict needs" : "conflicts need"} your attention.`);
  const progress = status.state === "syncing" ? status.progress : undefined;
  if (progress !== undefined) {
    const what = progress.phase === "pull" ? "Receiving" : "Sending";
    const file = progress.path === undefined ? "" : `: ${visiblePath(progress.path)}`;
    lines.push(`${what} ${String(progress.done)} of ${String(progress.total)} ${progress.total === 1 ? "change" : "changes"}${file}.`);
  }
  if (status.pendingFiles !== undefined && status.pendingFiles.length > 0) {
    lines.push(`Waiting to be sent: ${fileList(status.pendingFiles.map((change) => changeText(change.path, change.folder, change.kind)))}.`);
  }
  if (status.incoming !== undefined && status.incoming.length > 0) {
    const entries = status.incoming.map((change) => changeText(change.path, change.folder, change.kind, change.conflict));
    lines.push(`Incoming: ${fileList(entries)}.`);
  }
  return lines.join(" ");
}

/** How many files a list in the status details names before it says how many more there are. */
export const listedFiles = 10;

function fileList(entries: readonly string[]): string {
  const shown = entries.slice(0, listedFiles).join("; ");
  const more = entries.length - listedFiles;
  return more > 0 ? `${shown}; and ${String(more)} more` : shown;
}

/** A changed file with its kind, e.g. `"notes/a.md" (edited)`; a folder's path ends in a slash. */
function changeText(path: string | undefined, folder: boolean, kind: ChangeKind, conflict = false): string {
  const name = path === undefined ? "a file not yet decrypted" : `"${visiblePath(path)}${folder ? "/" : ""}"`;
  return `${name} (${kind}${conflict ? ", also changed here: likely conflict" : ""})`;
}
