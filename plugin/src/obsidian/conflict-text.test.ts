import { describe, expect, it } from "vitest";

import type { ConflictReason } from "../core/journal/journal";
import type { UnmaterializableCause } from "../core/vaultpath/platform";
import { conflictReasonText, unmaterializableReasonText } from "./conflict-text";

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
});
