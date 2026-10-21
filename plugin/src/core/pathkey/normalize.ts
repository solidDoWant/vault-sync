import { COMBINING_CLASS_DATA, COMPOSITION_DATA, DECOMPOSITION_DATA } from "./normalization-table";

// Canonical normalization (Unicode §3.11, UAX #15) from the generated
// Unicode 17.0.0 tables in normalization-table.ts, rather than the engine's
// String.prototype.normalize, whose Unicode version depends on the Electron
// or WebView release. internal/pathkey/normalize.go (Go) implements the same
// algorithm over tables generated from the same data, so path_key never
// depends on either runtime's Unicode version.

// Hangul syllable constants (Unicode §3.12).
const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;

interface Tables {
  combiningClasses: Map<number, number>;
  decompositions: Map<number, number[]>;
  /** Keyed by first * 0x110000 + second; exact in a double. */
  compositions: Map<number, number>;
}

let tables: Tables | undefined;

function parseHex(hex: string, entry: string): number {
  const value = Number.parseInt(hex, 16);
  if (!Number.isInteger(value)) throw new Error(`malformed normalization entry ${JSON.stringify(entry)}`);
  return value;
}

function getTables(): Tables {
  if (tables === undefined) {
    const combiningClasses = new Map<number, number>();
    for (const entry of COMBINING_CLASS_DATA.split(",")) {
      const [range = "", classHex = ""] = entry.split(" ");
      const [firstHex = "", lastHex = firstHex] = range.split("-");
      const last = parseHex(lastHex, entry);
      const combiningClass = parseHex(classHex, entry);
      for (let codePoint = parseHex(firstHex, entry); codePoint <= last; codePoint++) combiningClasses.set(codePoint, combiningClass);
    }
    const decompositions = new Map<number, number[]>();
    for (const entry of DECOMPOSITION_DATA.split(",")) {
      const [from, ...to] = entry.split(" ").map((hex) => parseHex(hex, entry));
      if (from === undefined || to.length === 0) throw new Error(`malformed decomposition entry ${JSON.stringify(entry)}`);
      decompositions.set(from, to);
    }
    const compositions = new Map<number, number>();
    for (const entry of COMPOSITION_DATA.split(",")) {
      const [first, second, composite, ...rest] = entry.split(" ").map((hex) => parseHex(hex, entry));
      if (first === undefined || second === undefined || composite === undefined || rest.length > 0) {
        throw new Error(`malformed composition entry ${JSON.stringify(entry)}`);
      }
      compositions.set(first * 0x110000 + second, composite);
    }
    tables = { combiningClasses, decompositions, compositions };
  }
  return tables;
}

/** Full canonical decomposition followed by the canonical ordering algorithm. */
function decompose(text: string): number[] {
  const { combiningClasses, decompositions } = getTables();
  const codePoints: number[] = [];
  for (const char of text) {
    // A lone surrogate is kept as it is, like String.prototype.normalize
    // does (vault paths cannot hold one: vaultpath rejects it).
    const codePoint = char.codePointAt(0) ?? 0;
    const decomposition = decompositions.get(codePoint);
    if (decomposition !== undefined) {
      codePoints.push(...decomposition);
    } else if (codePoint >= S_BASE && codePoint < S_BASE + S_COUNT) {
      const index = codePoint - S_BASE;
      codePoints.push(L_BASE + Math.floor(index / N_COUNT), V_BASE + Math.floor((index % N_COUNT) / T_COUNT));
      const trailing = index % T_COUNT;
      if (trailing !== 0) codePoints.push(T_BASE + trailing);
    } else {
      codePoints.push(codePoint);
    }
  }

  const classOf = (codePoint: number): number => combiningClasses.get(codePoint) ?? 0;
  // Canonical ordering: stably sort every run of non-starters by combining class.
  for (let start = 0; start < codePoints.length; ) {
    if (classOf(codePoints[start] ?? 0) === 0) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < codePoints.length && classOf(codePoints[end] ?? 0) !== 0) end++;
    // Array.prototype.sort is stable (ES2019).
    const run = codePoints.slice(start, end).sort((left, right) => classOf(left) - classOf(right));
    // Write back with a loop: spreading the run into splice passes it on the
    // stack and overflows on a long run of combining marks.
    for (let index = 0; index < run.length; index++) codePoints[start + index] = run[index] ?? 0;
    start = end;
  }
  return codePoints;
}

function composePair(first: number, second: number): number | undefined {
  if (first >= L_BASE && first < L_BASE + L_COUNT && second >= V_BASE && second < V_BASE + V_COUNT) {
    return S_BASE + ((first - L_BASE) * V_COUNT + (second - V_BASE)) * T_COUNT;
  }
  if (first >= S_BASE && first < S_BASE + S_COUNT && (first - S_BASE) % T_COUNT === 0 && second > T_BASE && second < T_BASE + T_COUNT) {
    return first + second - T_BASE;
  }
  return getTables().compositions.get(first * 0x110000 + second);
}

/** The canonical composition algorithm over a decomposed, ordered sequence. */
function compose(codePoints: number[]): number[] {
  const { combiningClasses } = getTables();
  const classOf = (codePoint: number): number => combiningClasses.get(codePoint) ?? 0;
  const out: number[] = [];
  let starter = -1; // index in out of the last starter
  // Combining class of the last code point in out; 0 means it is the starter itself.
  let lastClass = 0;
  for (const codePoint of codePoints) {
    const combiningClass = classOf(codePoint);
    if (out.length === 0) {
      if (combiningClass === 0) starter = 0;
      lastClass = combiningClass === 0 ? 0 : 256; // nothing before the first starter composes
      out.push(codePoint);
      continue;
    }
    if (starter >= 0 && (lastClass < combiningClass || lastClass === 0)) {
      const composite = composePair(out[starter] ?? 0, codePoint);
      if (composite !== undefined) {
        out[starter] = composite;
        continue;
      }
    }
    if (combiningClass === 0) starter = out.length;
    lastClass = combiningClass;
    out.push(codePoint);
  }
  return out;
}

function fromCodePoints(codePoints: number[]): string {
  let out = "";
  // String.fromCodePoint takes its arguments on the stack; chunk long paths.
  for (let start = 0; start < codePoints.length; start += 4096) out += String.fromCodePoint(...codePoints.slice(start, start + 4096));
  return out;
}

/** Canonical decomposition (NFD) under the pinned Unicode version. */
export function nfd(text: string): string {
  return fromCodePoints(decompose(text));
}

/** Canonical composition (NFC) under the pinned Unicode version. */
export function nfc(text: string): string {
  return fromCodePoints(compose(decompose(text)));
}
