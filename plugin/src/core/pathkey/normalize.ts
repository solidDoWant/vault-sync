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
