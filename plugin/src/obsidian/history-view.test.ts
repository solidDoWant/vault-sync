import { describe, expect, it } from "vitest";

import type { HistoryEntry } from "../core/engine/history";
import { alternativePath, changeLabel, deviceLabel, entryLabel, maxPreviewBytes, otherPathValue, previewOf, sizeLabel } from "./history-view";

const encoder = new TextEncoder();

/** `text` between FSI (U+2068) and PDI (U+2069), as the labels isolate it. */
const iso = (text: string) => `\u2068${text}\u2069`;

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    revisionId: "r",
    documentId: "d",
    seq: 1n,
    path: "plan.md",
    deleted: false,
    kind: "text",
    contentHash: "aa",
    size: 12n,
    deviceId: "0190a5c4-7e1f-7000-8000-000000000001",
    deviceName: undefined,
    thisDevice: false,
    createdAt: new Date(Date.UTC(2026, 0, 2, 3, 4)),
    ...overrides,
  };
}

describe("history view", () => {
  describe("previews", () => {
    it("shows UTF-8 text as text", () => {
      expect(previewOf(encoder.encode("# Plan\nnaïve\n"))).toEqual({ kind: "text", text: "# Plan\nnaïve\n", truncated: false });
    });

    it("shows content that is not UTF-8, or holds NUL, as binary by size", () => {
      expect(previewOf(new Uint8Array([0x89, 0x50, 0xff]))).toEqual({ kind: "binary", size: 3 });
      expect(previewOf(new Uint8Array([0x61, 0x00, 0x62]))).toEqual({ kind: "binary", size: 3 });
    });

    it("shows only the start of long text, also when the cut falls inside a character", () => {
      const exact = encoder.encode("a".repeat(maxPreviewBytes));
      expect(previewOf(exact)).toEqual({ kind: "text", text: "a".repeat(maxPreviewBytes), truncated: false });

      // "é" is two bytes; the limit cuts the last one in half.
      const long = encoder.encode(`${"a".repeat(maxPreviewBytes - 1)}é and more`);
      const preview = previewOf(long);
      expect(preview).toEqual({ kind: "text", text: "a".repeat(maxPreviewBytes - 1), truncated: true });
    });
  });

  describe("labels", () => {
    it("names this device, another device by id, or an unknown one", () => {
      expect(deviceLabel(entry({ thisDevice: true }))).toBe("this device");
      expect(deviceLabel(entry())).toBe("device 0190a5c4");
      expect(deviceLabel(entry({ deviceId: "" }))).toBe("an unknown device");
    });

    it("names another device by the name the server reports, falling back to its id", () => {
      expect(deviceLabel(entry({ deviceName: "Phone" }))).toBe(`device “${iso("Phone")}”`);
      // A name is another user's text: it cannot pass for this device.
      expect(deviceLabel(entry({ deviceName: "this device" }))).toBe(`device “${iso("this device")}”`);
      expect(deviceLabel(entry({ deviceName: "  " }))).toBe("device 0190a5c4");
      expect(deviceLabel(entry({ thisDevice: true, deviceName: "Laptop" }))).toBe("this device");
    });

    it("sizes bytes for people", () => {
      expect(sizeLabel(1023)).toBe("1023 B");
      expect(sizeLabel(1024)).toBe("1.0 KiB");
      expect(sizeLabel(5n * 1024n * 1024n)).toBe("5.0 MiB");
    });

    it("says what each revision changed", () => {
      const base = entry({ contentHash: "aa" });
      expect(changeLabel(base, undefined)).toBe("earliest kept version of plan.md (12 B)");
      expect(changeLabel(entry({ contentHash: "bb" }), base)).toBe("edited (12 B)");
      expect(changeLabel(entry({ path: "moved.md" }), base)).toBe("moved to moved.md");
      expect(changeLabel(entry({ path: "moved.md", contentHash: "bb" }), base)).toBe("moved to moved.md and edited (12 B)");
      expect(changeLabel(entry({ deleted: true }), base)).toBe("deleted plan.md");
      expect(changeLabel(base, entry({ deleted: true }))).toBe("restored plan.md (12 B)");
    });

    it("puts time, device and change on one line", () => {
      const formatTime = (date: Date) => date.toISOString();
      expect(entryLabel(entry({ thisDevice: true }), undefined, formatTime)).toBe("2026-01-02T03:04:00.000Z · this device · earliest kept version of plan.md (12 B)");
      expect(entryLabel(entry({ createdAt: undefined }), undefined, formatTime)).toMatch(/^unknown time · /);
    });

    // Names registered before the server refused these characters (#548)
    // still reach the history list.
    it.each([
      ["a right-to-left override", "Laptop\u202e ecived siht", `device “${iso("Laptop ecived siht")}”`],
      ["bidi embeddings and isolates", "\u202aA\u202b\u202c\u202dB\u2066C\u2067D\u2068E\u2069", `device “${iso("ABCDE")}”`],
      ["a right-to-left mark", "Phone\u200f", `device “${iso("Phone")}”`],
      ["zero-width characters and a byte order mark", "\ufeffPh\u200bo\u200cn\u200de\u2060", `device “${iso("Phone")}”`],
      ["a line separator", "Phone\u2028this device", `device “${iso("Phonethis device")}”`],
      ["a control character", "Phone\u0085", `device “${iso("Phone")}”`],
      ["quotes that would close the label early", "x” · this device · “y", `device “${iso("x' · this device · 'y")}”`],
      ["straight, low and angle double quotes", "\"a\" „b‟ «c» ＂d＂ 〝e〞〟", `device “${iso("'a' 'b' 'c' 'd' 'e''")}”`],
    ])("removes %s from another device's name", (_, deviceName, label) => {
      expect(deviceLabel(entry({ deviceName }))).toBe(label);
    });

    it("keeps apostrophes and letters of every script in another device's name", () => {
      expect(deviceLabel(entry({ deviceName: "Fred’s iPhone" }))).toBe(`device “${iso("Fred’s iPhone")}”`);
      expect(deviceLabel(entry({ deviceName: "Zoë's 日本 حاسوب 😀" }))).toBe(`device “${iso("Zoë's 日本 حاسوب 😀")}”`);
    });

    it("isolates another device's name, so right-to-left letters cannot reorder the label and a trailing mark stays inside (#557)", () => {
      expect(entryLabel(entry({ deviceName: "حاسوب 2" }), undefined, () => "then")).toBe(`then · device “${iso("حاسوب 2")}” · earliest kept version of plan.md (12 B)`);
      expect(deviceLabel(entry({ deviceName: "Phone\u0301" }))).toBe(`device “${iso("Phone\u0301")}”`);
    });

    it("shows at most 64 characters of another device's name (#557)", () => {
      expect(deviceLabel(entry({ deviceName: "n".repeat(64) }))).toBe(`device “${iso("n".repeat(64))}”`);
      expect(deviceLabel(entry({ deviceName: "n".repeat(65) }))).toBe(`device “${iso(`${"n".repeat(64)}…`)}”`);
    });

    it.each([
      ["a right-to-left override", "notes/\u202etxt.exe.md", "notes/\\u202Etxt.exe.md"],
      ["zero-width characters", "pay\u200bpal\u200d.md", "pay\\u200Bpal\\u200D.md"],
      ["bidi isolates", "a\u2066b\u2069.md", "a\\u2066b\\u2069.md"],
    ])("shows %s in another member's path visibly (#555)", (_, path, shown) => {
      const base = entry({ contentHash: "aa" });
      expect(changeLabel(entry({ path }), base)).toBe(`moved to ${shown}`);
      expect(changeLabel(entry({ path, contentHash: "bb" }), base)).toBe(`moved to ${shown} and edited (12 B)`);
      expect(changeLabel(entry({ path, deleted: true }), base)).toBe(`deleted ${shown}`);
      expect(changeLabel(entry({ path }), entry({ deleted: true }))).toBe(`restored ${shown} (12 B)`);
      expect(changeLabel(entry({ path }), undefined)).toBe(`earliest kept version of ${shown} (12 B)`);
    });

    it("names a device by id when its name is nothing but invisible characters", () => {
      expect(deviceLabel(entry({ deviceName: "\u202e\u200b\u2066\u2069" }))).toBe("device 0190a5c4");
    });
  });

  describe("another path for a restore whose path is taken (#420)", () => {
    it("suggests the same name marked as restored, in the same folder", () => {
      expect(alternativePath("notes/plan.md", () => false)).toBe("notes/plan (restored).md");
      expect(alternativePath("README", () => false)).toBe("README (restored)");
      expect(alternativePath("archive.tar.gz", () => false)).toBe("archive.tar (restored).gz");
      // A dot that starts the name is not an extension.
      expect(alternativePath(".hidden", () => false)).toBe(".hidden (restored)");
    });

    it("numbers the suggestion past every path already taken", () => {
      const taken = new Set(["plan (restored).md", "plan (restored 2).md"]);
      expect(alternativePath("plan.md", (path) => taken.has(path))).toBe("plan (restored 3).md");
    });
  });

  describe("the path field after a failed restore (#420, #548)", () => {
    const free = () => false;

    it("suggests a free path beside the document's own path when that is taken", () => {
      expect(otherPathValue({ reason: "path-taken", path: "notes/plan.md" }, undefined, free)).toBe("notes/plan (restored).md");
    });

    it.each([
      ["a path the server refuses", "plans\\plan.md"],
      ["a path this device cannot hold", "con.md"],
      ["an empty path", ""],
    ])("keeps what the user typed when it is %s, for them to correct", (_, typed) => {
      expect(otherPathValue({ reason: "invalid-path", path: typed }, typed, free)).toBe(typed);
    });

    it("suggests a free path beside the user's path when that is taken too", () => {
      const taken = new Set(["plans/plan 2 (restored).md"]);
      expect(otherPathValue({ reason: "path-taken", path: "plans/plan 2.md" }, "plans/plan 2.md", (path) => taken.has(path))).toBe("plans/plan 2 (restored 2).md");
    });
  });
});
