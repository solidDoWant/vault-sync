import { withoutInvisibleCharacters } from "./device-name";

// How names and paths that other members chose are shown (#548, #557). In a
// shared vault, device names, vault names and file paths are another user's
// text, so none of it may reorder, hide or pass for the label around it.
// No Obsidian import, so it is unit-tested.

/** Starts a first-strong isolate: the text up to PDI is laid out on its own. */
const firstStrongIsolate = "\u2068";
/** Ends the isolate firstStrongIsolate started. */
const popDirectionalIsolate = "\u2069";

/** Names longer than this many characters (graphemes) show only their start. */
export const maxShownNameCharacters = 64;

/** Double quotation marks, which could close a label's quotes early. */
const doubleQuotes = /["«»“”„‟″‶〝〞〟＂]/gu;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `text` laid out on its own (Unicode bidi isolate), so right-to-left letters
 * in it cannot reorder the label around it and a combining mark at its end
 * cannot attach to what follows.
 */
export function isolated(text: string): string {
  return `${firstStrongIsolate}${text}${popDirectionalIsolate}`;
}

/**
 * Another user's name for a device or vault, as it is shown: without the
 * invisible characters that could reorder or hide parts of a label, its
 * double quotes made `'` (so it cannot end the quotes around it early), and
 * at most maxShownNameCharacters long. Empty when nothing visible is left.
 */
export function shownName(name: string): string {
  const cleaned = withoutInvisibleCharacters(name).replace(doubleQuotes, "'").trim();
  const characters = Array.from(segmenter.segment(cleaned), (segment) => segment.segment);
  if (characters.length <= maxShownNameCharacters) return cleaned;
  return `${characters.slice(0, maxShownNameCharacters).join("").trimEnd()}…`;
}

/** A shownName, isolated and in quotes, for use inside a sentence. */
export function quotedName(name: string): string {
  return `“${isolated(name)}”`;
}

/** A remote vault, by name for a list: its shownName, isolated, or its id when the name shows nothing. */
export function vaultLabel(vault: { id: string; name: string }): string {
  const name = shownName(vault.name);
  return name === "" ? `vault ${vault.id.slice(0, 8)}` : isolated(name);
}

/** A remote vault, by name inside a sentence: its shownName, isolated and quoted, or its id when the name shows nothing. */
export function quotedVaultLabel(vault: { id: string; name: string }): string {
  const name = shownName(vault.name);
  return name === "" ? `vault ${vault.id.slice(0, 8)}` : quotedName(name);
}

/**
 * `path` as it is shown: every character that would not show (control and
 * format characters such as bidi controls and zero-width characters, line and
 * paragraph separators, and UTF-16 surrogates without their pair) written as
 * `\uXXXX`, so the user can see which name to fix and another member cannot
 * make a path read as another one (#555). Only for display: the vault and the
 * server keep the path as it is.
 */
export function visiblePath(path: string): string {
  return path.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[\ud800-\udfff]/gu, (character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);
}
