import { describe, expect, it, vi } from "vitest";

import { quotedVaultLabel, shownName, vaultLabel, visiblePath } from "./display-text";

/** `text` between FSI (U+2068) and PDI (U+2069), as the views isolate it. */
const iso = (text: string) => `\u2068${text}\u2069`;

describe("display text", () => {
  describe("another member's names (#557)", () => {
    it("isolates a vault name, so right-to-left letters cannot reorder the sentence around it", () => {
      expect(quotedVaultLabel({ id: "0190a5c4-0000", name: "ملاحظات 2" })).toBe(`“${iso("ملاحظات 2")}”`);
      expect(vaultLabel({ id: "0190a5c4-0000", name: "ملاحظات 2" })).toBe(iso("ملاحظات 2"));
    });

    it("keeps a trailing combining mark inside the isolate, away from the closing quote", () => {
      expect(quotedVaultLabel({ id: "v", name: "Notes\u0301" })).toBe(`“${iso("Notes\u0301")}”`);
    });

    it.each([
      ["a right-to-left override", "Notes\u202e sraey", "Notes sraey"],
      ["zero-width characters and a byte order mark", "\ufeffNo\u200bte\u200ds\u2060", "Notes"],
      ["a line separator", "No\u2028tes", "Notes"],
    ])("removes %s from a vault name stored before the server refused it", (_, name, plain) => {
      expect(quotedVaultLabel({ id: "v", name })).toBe(`“${iso(plain)}”`);
      expect(vaultLabel({ id: "v", name })).toBe(iso(plain));
    });

    it("turns a vault name's double quotes into apostrophes, so it cannot end the quotes early", () => {
      expect(quotedVaultLabel({ id: "v", name: "a” on the server, and “b" })).toBe(`“${iso("a' on the server, and 'b")}”`);
    });

    it("names a vault by id when its name shows nothing", () => {
      expect(quotedVaultLabel({ id: "0190a5c4-7e1f", name: "\u202e\u200b " })).toBe("vault 0190a5c4");
      expect(vaultLabel({ id: "0190a5c4-7e1f", name: "" })).toBe("vault 0190a5c4");
    });

    it("shows at most 64 characters of a name, never splitting one", () => {
      expect(shownName("n".repeat(64))).toBe("n".repeat(64));
      expect(shownName("n".repeat(65))).toBe(`${"n".repeat(64)}…`);
      // A family emoji is one character of several code points.
      const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
      expect(shownName(`${"n".repeat(63)}e\u0301${family}`)).toBe(`${"n".repeat(63)}e\u0301…`);
    });
  });

  describe("another member's paths (#555)", () => {
    it.each([
      ["a right-to-left override", "notes/\u202etxt.exe.md", "notes/\\u202Etxt.exe.md"],
      ["bidi embeddings, isolates and marks", "a\u202ab\u2066c\u2069d\u200f.md", "a\\u202Ab\\u2066c\\u2069d\\u200F.md"],
      ["zero-width characters and a byte order mark", "pay\u200bpal\u200c\u200d\ufeff.md", "pay\\u200Bpal\\u200C\\u200D\\uFEFF.md"],
      ["line and paragraph separators", "a\u2028b\u2029.md", "a\\u2028b\\u2029.md"],
      ["control characters", "line\nbreak\u0001.md", "line\\u000Abreak\\u0001.md"],
    ])("shows %s in a path visibly", (_, path, shown) => {
      expect(visiblePath(path)).toBe(shown);
    });

    it("leaves letters of every script, accents and emoji as they are", () => {
      expect(visiblePath("zoë/日本/ملاحظات/\u{1f600} e\u0301.md")).toBe("zoë/日本/ملاحظات/\u{1f600} e\u0301.md");
    });

    it.each([
      ["a family emoji", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}.md"],
      ["a profession emoji with a skin tone", "\u{1f469}\u{1f3fd}\u200d\u{1f4bb}.md"],
      ["a flag joined after a variation selector", "\u{1f3f3}\ufe0f\u200d\u{1f308}/a.md"],
    ])("leaves the zero-width joiners of %s as they are (#605)", (_, path) => {
      expect(visiblePath(path)).toBe(path);
    });

    it.each([
      ["between letters", "pay\u200dpal.md", "pay\\u200Dpal.md"],
      ["after an emoji only", "\u{1f600}\u200dx.md", "\u{1f600}\\u200Dx.md"],
      ["before an emoji only", "x\u200d\u{1f600}.md", "x\\u200D\u{1f600}.md"],
      ["doubled between emoji", "\u{1f468}\u200d\u200d\u{1f469}.md", "\u{1f468}\\u200D\\u200D\u{1f469}.md"],
      ["between an emoji and a bidi override", "\u{1f468}\u200d\u202e.md", "\u{1f468}\\u200D\\u202E.md"],
    ])("shows a zero-width joiner %s visibly (#605)", (_, path, shown) => {
      expect(visiblePath(path)).toBe(shown);
    });

    it("writes a backslash doubled, so a literal escape cannot pass for an escaped character (#605)", () => {
      expect(visiblePath("a\\u202Eb.md")).toBe("a\\\\u202Eb.md");
      expect(visiblePath("a\u202eb.md")).toBe("a\\u202Eb.md");
      expect(visiblePath("a\\u202Eb.md")).not.toBe(visiblePath("a\u202eb.md"));
    });
  });

  it("loads and shortens names on a WebView without Intl.Segmenter (#605)", async () => {
    const intl = Intl as { Segmenter?: unknown };
    const saved = intl.Segmenter;
    delete intl.Segmenter;
    let shown: string;
    try {
      vi.resetModules();
      shown = (await import("./display-text")).shownName(`${"n".repeat(63)}e\u0301\u{1f468}\u200d\u{1f469}`);
    } finally {
      intl.Segmenter = saved;
      vi.resetModules();
    }
    expect(shown).toBe(`${"n".repeat(63)}e\u0301…`);
  });
});
