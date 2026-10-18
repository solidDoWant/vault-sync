import { describe, expect, it } from "vitest";

import { isProtocolCompatible, PROTOCOL_VERSION } from "./version";

describe("isProtocolCompatible", () => {
  it("accepts a server at the client's protocol version", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
  });

  it("rejects a server older than the client's protocol version", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION - 1)).toBe(false);
  });

  it("rejects a malformed version", () => {
    expect(isProtocolCompatible(Number.NaN)).toBe(false);
  });
});
