// User-perceived characters (grapheme clusters), so shortening a name never
// splits an accent from its letter or an emoji sequence.
//
// Intl.Segmenter needs Chromium 87 or Safari 14.1. Obsidian's minimum version
// (manifest.json minAppVersion) does not guarantee it on mobile, where the
// plugin runs in the system WebView, so it is looked up on first use rather
// than at import time, and without it the text is split into code points that
// keep combining marks and emoji joins with their base (#605): the plugin
// still loads, and only rare clusters (such as flags) may be cut.

let segmenter: Intl.Segmenter | null | undefined;

/** The grapheme segmenter, or null where this WebView has none. */
function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  }
  return segmenter;
}

/**
 * Code points, with each combining mark (variation selectors included) and
 * emoji skin-tone modifier kept with what precedes it, and a zero-width
 * joiner with the characters on both sides. Matches all of any text.
 */
const approximateCluster = /(?:[^\p{M}\u{1F3FB}-\u{1F3FF}\u200d][\p{M}\u{1F3FB}-\u{1F3FF}]*|[\p{M}\u{1F3FB}-\u{1F3FF}]+)(?:\u200d+(?:[^\p{M}\u{1F3FB}-\u{1F3FF}\u200d][\p{M}\u{1F3FB}-\u{1F3FF}]*)?)*|\u200d+/gsu;

/** The user-perceived characters of `text`, in order; joined they are `text`. */
export function graphemes(text: string): string[] {
  const segments = graphemeSegmenter();
  if (segments !== null) return Array.from(segments.segment(text), (segment) => segment.segment);
  return text.match(approximateCluster) ?? [];
}
