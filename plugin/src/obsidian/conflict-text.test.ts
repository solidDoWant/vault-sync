import { describe, expect, it } from "vitest";

import type { RejectedReason } from "../core/engine/engine";
import type { ConflictReason } from "../core/journal/journal";
import type { UnmaterializableCause } from "../core/vaultpath/platform";
import { conflictReasonText, rejectedReasonText, unmaterializableReasonText, visiblePath } from "./conflict-text";

describe("conflict view wording", () => {
  it.each<[ConflictReason, RegExp]>([
    ["overlapping-edits", /same lines/],
    ["binary", /cannot be merged/],
    ["concurrent-create", /Created on this device and on another one/],
    ["path-taken", /already had this path/],
    ["base-purged", /no longer kept on the server/],
  ])("explains a %s conflict", (reason, expected) => {
    expect(conflictReasonText(reason)).toMatch(expected);
  });

  it.each<[UnmaterializableCause, RegExp]>([
    ["reserved-name", /reserved/],
    ["forbidden-character", /character/],
    ["trailing-dot-or-space", /ends in a dot or a space/],
    ["name-too-long", /name .* too long/],
    ["path-too-long", /path is too long/],
    ["refused-by-vault", /refused/],
  ])("explains why a %s path cannot be written", (reason, expected) => {
    expect(unmaterializableReasonText(reason)).toMatch(expected);
  });

  it.each<[RejectedReason, RegExp]>([
    ["empty", /empty/],
    ["too-long", /longer than 4096 bytes/],
    ["invalid-character", /control character/],
    ["not-vault-relative", /only of dots and spaces/],
    ["too-long-normalized", /8192 bytes once its letters are normalized/],
    ["backslash", /backslash/],
    ["drive-prefix", /character and a colon/],
    ["path-taken", /Another document has this path/],
    ["refused", /^The server refused it: the server's words$/],
  ])("explains why the server refuses a local file: %s", (reason, expected) => {
    expect(rejectedReasonText(reason, "the server's words")).toMatch(expected);
  });

  it("writes out the control characters and lone surrogates of a path, and changes nothing else", () => {
    expect(visiblePath("notes/line\nbreak\u0001\u009f.md")).toBe("notes/line\\u000Abreak\\u0001\\u009F.md");
    expect(visiblePath("a\ud800b.md")).toBe("a\\uD800b.md");
    expect(visiblePath("zoë/日本/\u{1f600} \u{1d160}.md")).toBe("zoë/日本/\u{1f600} \u{1d160}.md");
  });
});
