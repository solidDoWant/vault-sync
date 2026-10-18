import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { IdentityProviderError } from "../core/auth/oidc";
import { isOffline, statusDescription, statusText, type SyncState } from "./status";

describe("statusText", () => {
  it.each<[SyncState, string]>([
    ["idle", "Vault Sync: idle"],
    ["syncing", "Vault Sync: syncing"],
    ["offline", "Vault Sync: offline"],
    ["error", "Vault Sync: error"],
    ["sign-in-required", "Vault Sync: sign-in needed"],
    ["not-connected", "Vault Sync: no vault connected"],
  ])("names the %s state", (state, text) => {
    expect(statusText({ state, conflicts: 0, pending: 0 })).toBe(text);
  });

  it("adds the pending and conflict counts when there are any", () => {
    expect(statusText({ state: "idle", conflicts: 1, pending: 0 })).toBe("Vault Sync: idle · 1 conflict");
    expect(statusText({ state: "offline", conflicts: 2, pending: 3 })).toBe("Vault Sync: offline · 3 pending · 2 conflicts");
  });
});

describe("statusDescription", () => {
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
});

describe("isOffline", () => {
  it("counts an unreachable server or identity provider as offline, and nothing else", () => {
    expect(isOffline(new ConnectError("down", Code.Unavailable))).toBe(true);
    expect(isOffline(new ConnectError("slow", Code.DeadlineExceeded))).toBe(true);
    expect(isOffline(new IdentityProviderError("unreachable"))).toBe(true);
    expect(isOffline(new ConnectError("no", Code.PermissionDenied))).toBe(false);
    expect(isOffline(new Error("other"))).toBe(false);
  });
});
