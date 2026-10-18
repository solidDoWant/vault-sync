import { CASE_FOLDING_DATA } from "./casefold-table";

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

/** Applies full, locale-independent case folding (CaseFolding.txt C + F). */
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
 * folding, emitted in NFC. Separators, whitespace and dots are preserved.
 *
 * Must match internal/pathkey (Go) exactly; testdata/paths/vectors.json is the
 * shared conformance suite. The folding table is generated from the same
 * Unicode data as the Go table. Normalization uses the JavaScript engine's
 * String.prototype.normalize, which agrees with Go for every character
 * assigned in the engine's Unicode version.
 */
export function pathKey(path: string): string {
  return fold(path.normalize("NFD")).normalize("NFC");
}
