import { describe, expect, it } from "vitest";

import type { RejectedReason } from "../core/engine/engine";
import type { ConflictReason } from "../core/journal/journal";
import type { UnmaterializableCause } from "../core/vaultpath/platform";
import { conflictReasonText, deferredReasonText, formatBytes, openViewText, pathConflictCause, rejectedReasonText, tooLargeText, unmaterializableReasonText } from "./conflict-text";
import { shownText, visiblePath } from "./display-text";

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
    ["forbidden-character", /contains one of/],
    ["edge-space", /starts or ends with a space/],
    ["trailing-dot", /ends in a dot/],
    ["reserved-name", /reserved on Windows/],
    ["name-too-long", /longer than 255 bytes/],
    ["path-too-long", /longer than 1024 bytes/],
    ["path-taken", /Another document has this path/],
    ["refused", /^The server refused it: the server's words$/],
  ])("explains why the server refuses a local file: %s", (reason, expected) => {
    expect(rejectedReasonText(reason, "the server's words")).toMatch(expected);
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
    expect(tooLargeText(1024n * 1024n * 1024n + 1n)).toBe("Its newest version is 1.0 GiB, more than this device downloads.");
  });

  it("writes out the control characters and lone surrogates of a path, and changes nothing else", () => {
    expect(visiblePath("notes/line\nbreak\u0001\u009f.md")).toBe("notes/line\\u000Abreak\\u0001\\u009F.md");
    expect(visiblePath("a\ud800b.md")).toBe("a\\uD800b.md");
    expect(visiblePath("zoë/日本/\u{1f600} \u{1d160}.md")).toBe("zoë/日本/\u{1f600} \u{1d160}.md");
  });
});

/** Obsidian's normalizePath (1.14) as documented: slashes collapsed and trimmed, non-breaking spaces made plain, NFC. */
const obsidianNormalize = (path: string) =>
  path
    .replace(/([\\/])+/g, "/")
    .replace(/(^\/+|\/+$)/g, "")
    .replace(/[\u00a0\u202f]/g, " ")
    .normalize("NFC") || "/";

describe("deferred remote revisions wording (#417)", () => {
  it.each([
    ["an accent typed as a separate character (NFD)", "cafe\u0301.md"],
    ["a non-breaking space", "a\u00a0b.md"],
    ["a narrow non-breaking space", "a\u202fb.md"],
  ])("says Obsidian would store a path with %s under another name", (_name, path) => {
    const cause = pathConflictCause(path, obsidianNormalize);
    expect(cause).toBe("renamed-by-obsidian");
    expect(deferredReasonText("path-conflict", cause)).toMatch(/Obsidian would store its path under another name/);
  });

  it("says a path with a hidden name is not synced", () => {
    const cause = pathConflictCause("notes/.hidden/a.md", obsidianNormalize);
    expect(cause).toBe("hidden");
    expect(deferredReasonText("path-conflict", cause)).toMatch(/starts with a dot/);
  });

  it("says something is in the way of a path Obsidian keeps as it is", () => {
    const cause = pathConflictCause("café/notes.md", obsidianNormalize);
    expect(cause).toBe("occupied");
    expect(deferredReasonText("path-conflict", cause)).toMatch(/in the way/);
  });

  it("explains an invalid path and a move out of scope", () => {
    expect(deferredReasonText("invalid-path", "occupied")).toMatch(/not a valid path/);
    expect(deferredReasonText("out-of-scope", "occupied")).toMatch(/does not sync/);
  });

  it("names the file an open view holds back, readably", () => {
    expect(shownText(openViewText("a\u0007.canvas"))).toMatch(/^"a\\u0007\.canvas" is open in a view/);
    expect(openViewText("ملاحظات.canvas").slice(0, 3)).toEqual(['"', { path: "ملاحظات.canvas" }, expect.stringMatching(/^" is open in a view/)]);
  });
});
