import unassignedInUnicode15 from "@unicode/unicode-15.0.0/General_Category/Unassigned/regex.mjs";

// Canonical normalization through the runtime's String.prototype.normalize.
// New names may only use code points assigned in Unicode 15.0
// (docs/design/engine.md §6), whose normalization Unicode keeps stable, so
// every runtime with Unicode 15.0 or later and internal/pathkey (Go,
// golang.org/x/text/unicode/norm) agree on it.

/** Canonical decomposition (NFD). */
export function nfd(text: string): string {
  return text.normalize("NFD");
}

/** Canonical composition (NFC). */
export function nfc(text: string): string {
  return text.normalize("NFC");
}

/**
 * Reports whether every code point of `text` is assigned in Unicode 15.0, the
 * only ones new names and passphrases may use (docs/design/engine.md §6,
 * docs/design/crypto.md). Private-use code points are assigned;
 * noncharacters and code points added in a later version are not.
 * `Assigned` in internal/pathkey (Go) is the same rule.
 */
export function isAssignedInUnicode15(text: string): boolean {
  return !unassignedInUnicode15.test(text);
}
