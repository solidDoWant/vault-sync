import { graphemes } from "../core/graphemes";
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
  const characters = graphemes(cleaned);
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
 * The characters visiblePath writes out: a backslash (so a literal `\u202e`
 * in a name cannot pass for an escaped one), and control and format
 * characters, line and paragraph separators and lone UTF-16 surrogates. A
 * zero-width joiner between two emoji (after an optional variation selector
 * or skin tone) is left: it joins a family or profession emoji, and reorders
 * or hides nothing. Accepted limitation (#605 item 3, #615): where the font
 * has no glyph for the joined sequence, the emoji show side by side, as they
 * would without the joiner, so two such paths can look the same.
 */
const hiddenCharacter = /\\|(?<!\p{Extended_Pictographic}(?:\u{FE0F}|[\u{1F3FB}-\u{1F3FF}])?)\u200d|\u200d(?!\p{Extended_Pictographic})|(?!\u200d)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[\ud800-\udfff]/gu;

/**
 * `path` as it is shown: every character that would not show (control and
 * format characters such as bidi controls and zero-width characters, line and
 * paragraph separators, and UTF-16 surrogates without their pair) written as
 * `\uXXXX`, so the user can see which name to fix and another member cannot
 * make a path read as another one (#555), and a backslash written as `\\`, so
 * the notation is unambiguous (#605). The zero-width joiners of an emoji
 * sequence stay, so the emoji shows (#605). Only for display: the vault and
 * the server keep the path as it is.
 */
export function visiblePath(path: string): string {
  return path.replace(hiddenCharacter, (character) => (character === "\\" ? "\\\\" : `\\u${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`));
}

/** Another member's path inside a label, as visiblePath shows it; the view lays it out on its own (#605). */
export interface ShownPath {
  readonly path: string;
}

/**
 * A label that holds paths, in parts: text, and paths a view renders each in
 * its own element with `dir="auto"` (renderShown in shown-dom.ts). Isolated
 * that way, right-to-left letters in a path cannot reorder the label around
 * it, and the label's text stays exactly shownText (#605).
 */
export type Shown = readonly (string | ShownPath)[];

/** `path` as a part of a Shown label: visiblePath of it. */
export function shownPath(path: string): ShownPath {
  return { path: visiblePath(path) };
}

/** A Shown label as plain text: what the rendered label's text reads. */
export function shownText(parts: Shown): string {
  return parts.map((part) => (typeof part === "string" ? part : part.path)).join("");
}
