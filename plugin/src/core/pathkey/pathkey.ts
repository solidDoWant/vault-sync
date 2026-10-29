import { caseFold } from "unicode-case-folding";
import { nfc, nfd } from "./normalize";

/**
 * Applies full, locale-independent case folding (CaseFolding.txt C + F) with
 * the NTFS upcase merges: a Basic Multilingual Plane code point whose simple
 * uppercase is one BMP code point and folds differently from it folds as
 * that uppercase does.
 */
function fold(text: string): string {
  let out = "";
  for (const char of text) {
    let folded = caseFold(char);
    const upper = char.toUpperCase();
    if (char.length === 1 && upper.length === 1 && upper !== char) {
      const upperFolded = caseFold(upper);
      if (upperFolded !== folded) folded = upperFolded;
    }
    out += folded;
  }
  return out;
}

/**
 * Returns the path_key for a vault path (SPEC.md §5): NFC(toCasefold(NFD(path))),
 * i.e. Unicode canonical caseless matching with full, locale-independent case
 * folding, emitted in NFC, with the NTFS upcase mapping on top
 * (docs/design/engine.md §6): a code point whose simple uppercase folds
 * differently from it folds as that uppercase does, so `ı.md` and `I.md`
 * share a key. Separators, whitespace and dots are preserved.
 *
 * Must match internal/pathkey (Go) exactly; testdata/paths/vectors.json is the
 * shared conformance suite. New names may only use code points assigned in
 * Unicode 15.0 (docs/design/engine.md §6), whose normalization and case
 * folding Unicode keeps stable, so the runtime's normalization and the
 * case-folding package agree with Go's golang.org/x/text.
 */
export function pathKey(path: string): string {
  return nfc(fold(nfd(path)));
}
