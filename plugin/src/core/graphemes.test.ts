import { afterEach, describe, expect, it, vi } from "vitest";

import { graphemes } from "./graphemes";

const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
const flag = "\u{1f3f3}\ufe0f\u200d\u{1f308}";
const waveDark = "\u{1f44b}\u{1f3ff}";

/** Runs `run` with fresh module imports, as on a WebView without Intl.Segmenter (pre-Chromium 87, pre-Safari 14.1). */
async function withoutSegmenter<T>(run: () => Promise<T>): Promise<T> {
  const intl = Intl as { Segmenter?: unknown };
  const saved = intl.Segmenter;
  delete intl.Segmenter;
  try {
    vi.resetModules();
    return await run();
  } finally {
    intl.Segmenter = saved;
    vi.resetModules();
  }
}

describe("graphemes (#605)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("splits text into user-perceived characters", () => {
    expect(graphemes(`ae\u0301${family}b`)).toEqual(["a", "e\u0301", family, "b"]);
  });

  it("splits without Intl.Segmenter, keeping accents and emoji sequences whole", async () => {
    const split = await withoutSegmenter(async () => (await import("./graphemes")).graphemes(`ae\u0301\u0302${family}${flag}${waveDark}日本\u{1f600}`));
    expect(split).toEqual(["a", "e\u0301\u0302", family, flag, waveDark, "日", "本", "\u{1f600}"]);
  });

  it("never loses text without Intl.Segmenter", async () => {
    const text = `\u0301x\u200d\u200dy\u200d${family}\ud800z\u200d`;
    const split = await withoutSegmenter(async () => (await import("./graphemes")).graphemes(text));
    expect(split.join("")).toBe(text);
  });

  it("lets conflict copies be named without Intl.Segmenter", async () => {
    const copy = await withoutSegmenter(async () => (await import("./merge/conflict-name")).conflictCopyPath("a.md", `${"d".repeat(39)}e\u0301x`, new Date(Date.UTC(2026, 9, 18, 4, 5, 6))));
    expect(copy).toBe(`a (conflict ${"d".repeat(39)}e\u0301 2026-10-18 040506).md`);
  });
});
