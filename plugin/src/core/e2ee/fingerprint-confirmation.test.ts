import { describe, expect, it } from "vitest";

import { fingerprintLastGroupMatches } from "./identity";

const displayed = "0123 4567 89AB CDEF GHJK MNPQ RSTV WXYZ";

describe("typing a fingerprint's last group to confirm it", () => {
  it("matches the displayed last group, in any case and with spaces", () => {
    expect(fingerprintLastGroupMatches(displayed, "WXYZ")).toBe(true);
    expect(fingerprintLastGroupMatches(displayed, "wxyz")).toBe(true);
    expect(fingerprintLastGroupMatches(displayed, " WX YZ ")).toBe(true);
  });

  it("reads O as 0 and I and L as 1, as Crockford base32 decodes them", () => {
    const withAmbiguous = "0123 4567 89AB CDEF GHJK MNPQ RSTV 0111";
    expect(fingerprintLastGroupMatches(withAmbiguous, "OIL1")).toBe(true);
    expect(fingerprintLastGroupMatches(withAmbiguous, "oil1")).toBe(true);
  });

  it("does not match another group, a group of the wrong length, or characters outside the alphabet", () => {
    expect(fingerprintLastGroupMatches(displayed, "WXY2")).toBe(false);
    expect(fingerprintLastGroupMatches(displayed, "RSTV")).toBe(false);
    expect(fingerprintLastGroupMatches(displayed, "WXY")).toBe(false);
    expect(fingerprintLastGroupMatches(displayed, "WXYZW")).toBe(false);
    expect(fingerprintLastGroupMatches(displayed, "")).toBe(false);
    expect(fingerprintLastGroupMatches(displayed, "WXYU")).toBe(false);
    expect(fingerprintLastGroupMatches(displayed, "WX-Z")).toBe(false);
  });
});
