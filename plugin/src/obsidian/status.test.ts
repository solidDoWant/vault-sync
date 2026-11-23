import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { discoverOidc, IdentityProviderError, refreshAccessToken, type HttpClient, type OidcEndpoints } from "../core/auth/oidc";
import { createProtocolClient } from "../core/protocol/client";
import { InMemoryServer } from "../core/sync/memory-server";
import type { IncomingChange, PendingChange } from "../core/sync/engine";
import { isOffline, isStoppedState, statusDescription, statusIcon, statusText, type SyncState } from "./status";

describe("statusText", () => {
  it.each<[SyncState, string]>([
    ["idle", "Vault Sync: idle"],
    ["syncing", "Vault Sync: syncing"],
    ["offline", "Vault Sync: offline"],
    ["error", "Vault Sync: error"],
    ["sign-in-required", "Vault Sync: sign-in needed"],
    ["not-connected", "Vault Sync: no vault connected"],
    ["signed-out", "Vault Sync: signed out"],
    ["starting", "Vault Sync: starting"],
    ["waiting-for-journal", "Vault Sync: waiting for another window"],
    ["not-member", "Vault Sync: no longer a member"],
    ["vault-deleted", "Vault Sync: vault deleted"],
    ["verification-failed", "Vault Sync: stopped: key data doesn't verify"],
  ])("names the %s state", (state, text) => {
    expect(statusText({ state, conflicts: 0, pending: 0 })).toBe(text);
  });

  it("adds the pending and conflict counts when there are any", () => {
    expect(statusText({ state: "idle", conflicts: 1, pending: 0 })).toBe("Vault Sync: idle · 1 conflict");
    expect(statusText({ state: "offline", conflicts: 2, pending: 3 })).toBe("Vault Sync: offline · 3 pending · 2 conflicts");
  });
});

describe("statusDescription", () => {
  it("says a verification failure stopped the vault's sync and kept its files, with what failed", () => {
    const text = statusDescription({ state: "verification-failed", conflicts: 0, pending: 1, message: "the membership log forks" });
    expect(text).toContain("The server sent key or membership data that doesn't verify, so sync of this vault is stopped. Your files stay in this vault.");
    expect(text).toContain("the membership log forks");
    expect(isStoppedState("verification-failed")).toBe(true);
  });

  it("includes the error's message", () => {
    expect(
      statusDescription({
        state: "error",
        conflicts: 0,
        pending: 1,
        message: "not a member of this vault",
      }),
    ).toContain("not a member of this vault");
  });

  it("calls open conflicts conflicts, not conflict copies, since some have no copy", () => {
    const one = statusDescription({ state: "idle", conflicts: 1, pending: 0 });
    const two = statusDescription({ state: "idle", conflicts: 2, pending: 0 });
    expect(one).toContain("1 conflict needs your attention.");
    expect(two).toContain("2 conflicts need your attention.");
    expect(one).not.toContain("conflict cop");
    expect(two).not.toContain("conflict cop");
  });
});

describe("isOffline", () => {
  it("counts an unreachable server or identity provider as offline, and nothing else", () => {
    expect(isOffline(new ConnectError("down", Code.Unavailable))).toBe(true);
    expect(isOffline(new ConnectError("slow", Code.DeadlineExceeded))).toBe(true);
    expect(isOffline(new IdentityProviderError("unreachable", { unreachable: true }))).toBe(true);
    expect(isOffline(new ConnectError("no", Code.PermissionDenied))).toBe(false);
    expect(isOffline(new Error("other"))).toBe(false);
  });

  describe("for the identity provider's errors (#413)", () => {
    const endpoints: OidcEndpoints = {
      issuer: "https://idp.example",
      deviceAuthorizationEndpoint: "https://idp.example/device",
      tokenEndpoint: "https://idp.example/token",
    };
    const answering =
      (status: number, text: string): HttpClient =>
      () =>
        Promise.resolve({ status, text });
    const unreachable: HttpClient = () => Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED"));

    /** The error a token refresh over `http` rejects with, alone and as a server call's error (createProtocolClient). */
    async function refreshErrors(http: HttpClient): Promise<unknown[]> {
      const refused = await refreshAccessToken(http, endpoints, "client", "refresh-token").then(
        () => undefined,
        (error: unknown) => error,
      );
      if (!(refused instanceof IdentityProviderError)) throw new Error(`expected an IdentityProviderError, got ${String(refused)}`);
      const server = new InMemoryServer();
      const client = createProtocolClient({ transport: server.transport, auth: { accessToken: () => Promise.reject(refused), invalidate: () => undefined } });
      const call = await client.vaults.listVaults({}).then(
        () => undefined,
        (error: unknown) => error,
      );
      return [refused, call];
    }

    it.each([
      { name: "a malformed response", http: answering(200, "<html>not json</html>") },
      { name: "a response that is not an object", http: answering(200, "[]") },
      { name: "a response missing its access token", http: answering(200, JSON.stringify({ token_type: "Bearer" })) },
      { name: "a 4xx without an OAuth error", http: answering(400, JSON.stringify({})) },
    ])("is an error, not offline, for $name", async ({ http }) => {
      for (const error of await refreshErrors(http)) expect(isOffline(error)).toBe(false);
    });

    it.each([
      { name: "an unreachable provider", http: unreachable },
      { name: "a 500", http: answering(500, "") },
      { name: "a 503 with an HTML page", http: answering(503, "<html>maintenance</html>") },
    ])("is offline for $name", async ({ http }) => {
      for (const error of await refreshErrors(http)) expect(isOffline(error)).toBe(true);
    });

    it("is offline when discovery gets a 5xx, and an error when it gets a 404", async () => {
      const failing = (status: number) =>
        discoverOidc(answering(status, ""), "https://idp.example").then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(isOffline(await failing(502))).toBe(true);
      expect(isOffline(await failing(404))).toBe(false);
    });
  });
});

describe("statusIcon", () => {
  // The mobile ribbon shows the status as an icon (#420): each state that
  // needs the user, or in which sync is not running, looks different from idle.
  it.each<[SyncState, string]>([
    ["idle", "check-circle"],
    ["syncing", "refresh-cw"],
    ["offline", "wifi-off"],
    ["error", "alert-circle"],
    ["sign-in-required", "log-in"],
    ["signed-out", "log-in"],
    ["not-connected", "unlink"],
    ["starting", "loader"],
    ["waiting-for-journal", "loader"],
  ])("shows the %s state as %s", (state, icon) => {
    expect(statusIcon({ state, conflicts: 0, pending: 0 })).toBe(icon);
  });

  it("shows unresolved conflicts over an idle or syncing state, but not over a problem", () => {
    expect(statusIcon({ state: "idle", conflicts: 1, pending: 0 })).toBe("alert-triangle");
    expect(statusIcon({ state: "syncing", conflicts: 2, pending: 0 })).toBe("alert-triangle");
    expect(statusIcon({ state: "offline", conflicts: 1, pending: 0 })).toBe("wifi-off");
    expect(statusIcon({ state: "error", conflicts: 1, pending: 0 })).toBe("alert-circle");
  });

  it("shows changes waiting to be pushed while idle", () => {
    expect(statusIcon({ state: "idle", conflicts: 0, pending: 3 })).toBe("upload-cloud");
  });
});

describe("sync activity in the status", () => {
  const incoming: IncomingChange[] = [
    { documentId: "d1", path: "notes/a.md", kind: "edited", folder: false, conflict: true },
    { documentId: "d2", path: "new", kind: "created", folder: true, conflict: false },
    { documentId: "d3", path: undefined, kind: "created", folder: false, conflict: false },
  ];

  it("shows the progress as files done out of the total while syncing", () => {
    expect(statusText({ state: "syncing", conflicts: 0, pending: 0, progress: { phase: "pull", done: 40, total: 312, path: "a.md" } })).toBe("Vault Sync: syncing 40/312");
    expect(statusText({ state: "syncing", conflicts: 0, pending: 5, progress: { phase: "push", done: 0, total: 5, path: undefined } })).toBe("Vault Sync: syncing 0/5 · 5 pending");
  });

  it("shows no progress once sync no longer runs", () => {
    expect(statusText({ state: "offline", conflicts: 0, pending: 0, progress: { phase: "pull", done: 1, total: 2, path: undefined } })).toBe("Vault Sync: offline");
  });

  it("counts the incoming files in the status bar and shows them on the icon while syncing", () => {
    const status = { state: "syncing" as const, conflicts: 1, pending: 1, incoming, progress: { phase: "pull" as const, done: 0, total: 3, path: undefined } };
    expect(statusText(status)).toBe("Vault Sync: syncing 0/3 · 1 pending · 3 incoming · 1 conflict");
    expect(statusIcon({ ...status, conflicts: 0 })).toBe("download-cloud");
    expect(statusIcon({ state: "syncing", conflicts: 0, pending: 0, incoming: [] })).toBe("refresh-cw");
  });

  it("names the file being worked on in the details", () => {
    expect(statusDescription({ state: "syncing", conflicts: 0, pending: 0, progress: { phase: "pull", done: 40, total: 312, path: "notes/a.md" } })).toBe(
      'Syncing. Receiving 40 of 312 changes: notes/a.md.',
    );
    expect(statusDescription({ state: "syncing", conflicts: 0, pending: 1, progress: { phase: "push", done: 0, total: 1, path: undefined } })).toBe(
      "Syncing. 1 local change is waiting to be pushed. Sending 0 of 1 change.",
    );
  });

  it("lists the pending files and the incoming files with their kinds, and marks likely conflicts", () => {
    const pendingFiles: PendingChange[] = [
      { documentId: "d1", path: "notes/a.md", kind: "edited", folder: false },
      { documentId: "d4", path: "old.md", kind: "deleted", folder: false },
    ];
    expect(statusDescription({ state: "syncing", conflicts: 0, pending: 2, pendingFiles, incoming })).toBe(
      "Syncing. 2 local changes are waiting to be pushed." +
        ' Waiting to be sent: "notes/a.md" (edited); "old.md" (deleted).' +
        ' Incoming: "notes/a.md" (edited, also changed here: likely conflict); "new/" (created); a file not yet decrypted (created).',
    );
  });

  it("lists at most ten files and says how many more there are", () => {
    const changes = (count: number): PendingChange[] => Array.from({ length: count }, (_, index) => ({ documentId: `d${String(index)}`, path: `${String(index)}.md`, kind: "created", folder: false }));
    const ten = statusDescription({ state: "idle", conflicts: 0, pending: 10, pendingFiles: changes(10) });
    expect(ten).toContain('"9.md" (created).');
    expect(ten).not.toContain("more");
    const eleven = statusDescription({ state: "idle", conflicts: 0, pending: 11, pendingFiles: changes(11) });
    expect(eleven).toContain('"9.md" (created); and 1 more.');
    expect(eleven).not.toContain('"10.md"');
  });
});
