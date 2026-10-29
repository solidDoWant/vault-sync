import { CASE_FOLDING_DATA } from "./casefold-table";
import { nfc, nfd } from "./normalize";

let foldTable: Map<number, string> | undefined;

function getFoldTable(): Map<number, string> {
  if (foldTable === undefined) {
    foldTable = new Map();
    for (const entry of CASE_FOLDING_DATA.split(",")) {
      const [from, ...to] = entry.split(" ").map((hex) => Number.parseInt(hex, 16));
      if (from === undefined || to.length === 0) throw new Error(`malformed case-folding entry ${JSON.stringify(entry)}`);
      foldTable.set(from, String.fromCodePoint(...to));
    }
  }
  return foldTable;
}

/** Applies full, locale-independent case folding (CaseFolding.txt C + F) with the NTFS upcase merges. */
function fold(text: string): string {
  const table = getFoldTable();
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    out += (codePoint === undefined ? undefined : table.get(codePoint)) ?? char;
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
 * shared conformance suite. The folding and normalization tables are
 * generated from the same pinned Unicode data (17.0.0) as the Go tables.
 * Normalization deliberately does not use String.prototype.normalize: its
 * tables depend on the Electron or WebView release, and a client with older
 * tables would compute a different key for characters added since.
 */
export function pathKey(path: string): string {
  return nfc(fold(nfd(path)));
}
