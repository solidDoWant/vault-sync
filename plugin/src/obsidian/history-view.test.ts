import { describe, expect, it } from "vitest";

import type { HistoryEntry } from "../core/engine/history";
import { alternativePath, changeLabel, deviceLabel, entryLabel, maxPreviewBytes, previewOf, sizeLabel } from "./history-view";

const encoder = new TextEncoder();

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
      expect(deviceLabel(entry({ deviceName: "Phone" }))).toBe("device “Phone”");
      // A name is another user's text: it cannot pass for this device.
      expect(deviceLabel(entry({ deviceName: "this device" }))).toBe("device “this device”");
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
});
