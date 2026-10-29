import { describe, expect, it } from "vitest";

import type { UnmaterializableCause } from "../core/vaultpath/platform";
import { formatBytes, skippedReasonText, tooLargeText, tooLargeUploadText, unmaterializableReasonText } from "./conflict-text";
import { visiblePath } from "./display-text";

describe("conflict view wording", () => {
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

  it.each<[bigint, string]>([
    [0n, "0 B"],
    [1023n, "1023 B"],
    [1024n, "1.0 KiB"],
    [1536n, "1.5 KiB"],
    [256n * 1024n * 1024n + 1n, "256.0 MiB"],
    [1024n * 1024n * 1024n + 1n, "1.0 GiB"],
    [80n * 1024n * 1024n * 1024n, "80.0 GiB"],
    [2048n * 1024n * 1024n * 1024n * 1024n, "2048.0 TiB"],
  ])("writes %s bytes as %s", (size, expected) => {
    expect(formatBytes(size)).toBe(expected);
  });

  it("explains that a document is too large to download, with its size", () => {
    expect(tooLargeText(1024n * 1024n * 1024n + 1n)).toBe("Its newest version is 1.0 GiB, more than the size limit.");
  });

  it("explains a skipped remote document by its reason", () => {
    expect(skippedReasonText("too-large", 2048)).toBe("Its newest version is 2.0 KiB, more than the size limit.");
    expect(skippedReasonText("path-too-long", 10)).toMatch(/path is too long/);
  });

  it("explains that a local file is too large to upload, with its size", () => {
    expect(tooLargeUploadText(1536)).toBe("It is 1.5 KiB, more than the size limit, so it stays on this device only.");
  });

  it("writes out the control characters and lone surrogates of a path, and changes nothing else", () => {
    expect(visiblePath("notes/line\nbreak\u0001\u009f.md")).toBe("notes/line\\u000Abreak\\u0001\\u009F.md");
    expect(visiblePath("a\ud800b.md")).toBe("a\\uD800b.md");
    expect(visiblePath("zoë/日本/\u{1f600} \u{1d160}.md")).toBe("zoë/日本/\u{1f600} \u{1d160}.md");
  });
});
