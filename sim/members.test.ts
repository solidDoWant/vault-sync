import { describe, expect, it } from "vitest";

import { Code, ConnectError } from "@connectrpc/connect";

import { authorizationViolations, type MemberRole } from "./members";
import type { Outcome } from "./network";

const ok: Outcome = { ok: true, value: {} };
const refused = (code: Code): Outcome => ({ ok: false, error: new ConnectError("refused", code) });

function invariants(role: MemberRole, method: string, outcome: Outcome): string[] {
  return authorizationViolations(role, "c1 (u1)", method, outcome).map((violation) => violation.invariant);
}

describe("authorizationViolations", () => {
  it.each(["BeginBlob", "PutBlobChunk", "CommitBlob", "CommitRevision"])("reports a viewer's accepted %s as a revoked write", (method) => {
    expect(invariants("viewer", method, ok)).toEqual(["revoked-write"]);
    expect(invariants("viewer", method, refused(Code.PermissionDenied))).toEqual([]);
  });

  it.each(["ListChanges", "GetRevision", "DownloadBlob"])("lets a viewer read with %s", (method) => {
    expect(invariants("viewer", method, ok)).toEqual([]);
  });

  it("reports a viewer's write refused with another code than PERMISSION_DENIED", () => {
    expect(invariants("viewer", "CommitRevision", refused(Code.NotFound))).toEqual(["authorization"]);
  });

  it("reports every answered call of a removed member: a write as revoked, a read as received after removal", () => {
    expect(invariants("removed", "CommitRevision", ok)).toEqual(["revoked-write"]);
    expect(invariants("removed", "BeginBlob", ok)).toEqual(["revoked-write"]);
    expect(invariants("removed", "ListChanges", ok)).toEqual(["removed-read"]);
    expect(invariants("removed", "DownloadBlob", ok)).toEqual(["removed-read"]);
  });

  it("requires NOT_FOUND for a removed member, so the refusal tells a non-member nothing about the vault", () => {
    expect(invariants("removed", "ListChanges", refused(Code.NotFound))).toEqual([]);
    expect(invariants("removed", "CommitRevision", refused(Code.NotFound))).toEqual([]);
    expect(invariants("removed", "CommitRevision", refused(Code.PermissionDenied))).toEqual(["authorization"]);
    expect(invariants("removed", "ListChanges", refused(Code.PermissionDenied))).toEqual(["authorization"]);
  });

  it.each<MemberRole>(["owner", "editor"])("reports a(n) %s refused what its role allows", (role) => {
    expect(invariants(role, "CommitRevision", ok)).toEqual([]);
    expect(invariants(role, "CommitRevision", refused(Code.PermissionDenied))).toEqual(["authorization"]);
    expect(invariants(role, "ListChanges", refused(Code.NotFound))).toEqual(["authorization"]);
    // Other refusals are the protocol's, not authorization's.
    expect(invariants(role, "CommitRevision", refused(Code.FailedPrecondition))).toEqual([]);
    expect(invariants(role, "PutBlobChunk", refused(Code.NotFound))).toEqual([]);
  });

  it("reports a viewer's read refused as PERMISSION_DENIED or its feed as NOT_FOUND", () => {
    expect(invariants("viewer", "ListChanges", refused(Code.PermissionDenied))).toEqual(["authorization"]);
    expect(invariants("viewer", "ListChanges", refused(Code.NotFound))).toEqual(["authorization"]);
  });
});
