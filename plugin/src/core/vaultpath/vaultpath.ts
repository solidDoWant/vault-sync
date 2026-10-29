import unassignedInUnicode15 from "@unicode/unicode-15.0.0/General_Category/Unassigned/regex.mjs";
import { nfc } from "../pathkey/normalize";
import { pathKey } from "../pathkey/pathkey";

/**
 * Reports whether `path` is vault-relative on every supported platform
 * (SPEC.md §6.2): "/" and "\" are both separators; the path must not start
 * with a separator (which also rules out UNC, `\\?\` and `\\.\` prefixes) or
 * with a drive letter and colon (`C:`, `C:x`, `C:\x`, `C:/x`); and no segment
 * may be empty or made only of dots and spaces (`.`, `..`, and forms such as
 * `.. ` or `...` that Windows reduces to them). Names that are merely
 * unmaterializable on Windows (`CON.md`, `ab:c.md`, trailing dots or spaces)
 * are accepted. Length and character-set limits are checked separately, by
 * {@link isPathText}.
 *
 * Must match internal/vaultpath (Go) exactly; testdata/paths/validity.json is
 * the shared conformance suite. Every path received from the server, including
 * E2EE paths after decryption, must pass this before it touches the disk.
 */
export function isVaultRelativePath(path: string): boolean {
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split(/[/\\]/).every((segment) => !/^[. ]*$/.test(segment));
}

/** The most UTF-8 bytes of each part of a new path (MaxNameBytes in internal/vaultpath). */
export const maxNameBytes = 255;

/** The most UTF-8 bytes of a new path (MaxNewBytes in internal/vaultpath). */
export const maxNewPathBytes = 1024;

/** The first portable-name rule (docs/design/engine.md §6) a part of a new path breaks, or undefined. */
function nameProblem(name: string): PathProblem | undefined {
  if (/[<>:"|?*]/.test(name)) return "forbidden-character";
  if (name.startsWith(" ") || name.endsWith(" ")) return "edge-space";
  if (name.endsWith(".")) return "trailing-dot";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(name)) return "reserved-name";
  if (encoder.encode(name).length > maxNameBytes) return "name-too-long";
  return undefined;
}

/**
 * The first new-path rule a vault-relative `path` breaks, or undefined: a
 * `backslash`, a `drive-prefix` (one code point and a colon), then the
 * portable-name rules of docs/design/engine.md §6 on each part (`<>:"|?*`, a
 * leading or trailing space, a trailing dot, a Windows reserved name in any
 * case with or without an extension, more than {@link maxNameBytes} bytes),
 * then more than {@link maxNewPathBytes} bytes in all, then `unassigned` (a
 * code point not assigned in Unicode 15.0), then `not-nfc` (not in Unicode
 * NFC). The order is
 * `CheckNew`'s in internal/vaultpath (Go).
 */
function newPathProblem(path: string): PathProblem | undefined {
  if (path.includes("\\")) return "backslash";
  // With the u flag, [^] is one code point, including a surrogate pair.
  if (/^[^]:/u.test(path)) return "drive-prefix";
  for (const name of path.split("/")) {
    const problem = nameProblem(name);
    if (problem !== undefined) return problem;
  }
  if (encoder.encode(path).length > maxNewPathBytes) return "path-too-long";
  if (unassignedInUnicode15.test(path)) return "unassigned";
  if (nfc(path) !== path) return "not-nfc";
  return undefined;
}

/**
 * Reports whether a commit may create or rename a document into `path`
 * (SPEC.md §6.2): it is vault-relative, contains no "\" (decision #191),
 * does not start with one code point and a colon (decision #148), and is
 * portable, uses only code points assigned in Unicode 15.0 and is in
 * Unicode NFC (docs/design/engine.md §6; see
 * {@link newPathProblem}). Windows
 * reads "\" as a separator and other platforms as part of a name, so `a/b`
 * and `a\b` would otherwise be two live documents naming one file on
 * Windows; and Win32 reads any first character followed by ":" (`1:x.md`,
 * `é:x.md`) as a drive. A document committed before these rules keeps its
 * path, which still passes {@link isVaultRelativePath}; the server accepts it
 * only as the unchanged path of a live document (an edit or a delete in
 * place).
 *
 * Must match `CheckNew` in internal/vaultpath (Go) exactly, on the `new`
 * field of testdata/paths/validity.json.
 */
export function isNewVaultPath(path: string): boolean {
  return isVaultRelativePath(path) && newPathProblem(path) === undefined;
}

/** The most UTF-8 bytes a plaintext path may have (SPEC.md §6.2; MaxBytes in internal/vaultpath). */
export const maxPathBytes = 4096;

const encoder = new TextEncoder();

/** A UTF-16 surrogate that is not half of a pair: it has no UTF-8 form. */
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Reports whether `path` is 1 to {@link maxPathBytes} bytes of UTF-8 with no
 * control character (Unicode category Cc: U+0000 to U+001F and U+007F to
 * U+009F), the server's length and character-set rule for a plaintext path
 * (SPEC.md §6.2, #148). A string with a lone surrogate, which has no UTF-8
 * form, is refused. A client applies this, with
 * {@link isVaultRelativePath}, to every path it receives before it touches
 * the disk, including E2EE paths after decryption, which the server cannot
 * check.
 *
 * Must match `CheckText` in internal/vaultpath (Go) exactly;
 * testdata/paths/text.json is the shared conformance suite.
 */
export function isPathText(path: string): boolean {
  if (path === "" || loneSurrogate.test(path) || /\p{Cc}/u.test(path)) return false;
  return encoder.encode(path).length <= maxPathBytes;
}

/** The most UTF-8 bytes of a normalized path (`path_key`, SPEC.md §5) the server accepts (SPEC.md §6.2; MaxPathKeyBytes in internal/api). */
export const maxPathKeyBytes = 8192;

/**
 * Reports whether `path`'s `path_key` (SPEC.md §5) is at most
 * {@link maxPathKeyBytes} bytes of UTF-8, the server's limit on a normalized
 * plaintext path (SPEC.md §6.2). Normalization can grow a path: U+1D160
 * decomposes into three code points that NFC does not recompose.
 *
 * Must match CommitRevision exactly; testdata/paths/key.json is the shared
 * conformance suite.
 */
export function fitsPathKeyLimit(path: string): boolean {
  return encoder.encode(pathKey(path)).length <= maxPathKeyBytes;
}

/**
 * Why the server would refuse a commit at a path (SPEC.md §6.2), one rule at
 * a time: `empty` and `too-long` (more than {@link maxPathBytes} bytes) and
 * `invalid-character` (a control character, or no UTF-8 form) are
 * {@link isPathText}; `not-vault-relative` is {@link isVaultRelativePath};
 * `too-long-normalized` is {@link fitsPathKeyLimit}; `backslash`,
 * `drive-prefix`, `forbidden-character`, `edge-space`, `trailing-dot`,
 * `reserved-name`, `name-too-long`, `path-too-long`, `unassigned` and `not-nfc` are
 * {@link isNewVaultPath}'s further rules.
 */
export type PathProblem =
  | "empty"
  | "too-long"
  | "invalid-character"
  | "not-vault-relative"
  | "too-long-normalized"
  | "backslash"
  | "drive-prefix"
  | "forbidden-character"
  | "edge-space"
  | "trailing-dot"
  | "reserved-name"
  | "name-too-long"
  | "path-too-long"
  | "unassigned"
  | "not-nfc";

/**
 * The first rule of the server's (SPEC.md §6.2) that a commit giving a
 * document `path` breaks, or undefined if it would accept the path. With
 * `kept`, the path is the document's unchanged live path, which only the
 * new-path rules ({@link isNewVaultPath}) spare: a document committed before
 * them stays editable and deletable in place.
 */
export function pathProblem(path: string, kept = false): PathProblem | undefined {
  if (path === "") return "empty";
  if (loneSurrogate.test(path) || /\p{Cc}/u.test(path)) return "invalid-character";
  if (encoder.encode(path).length > maxPathBytes) return "too-long";
  if (!isVaultRelativePath(path)) return "not-vault-relative";
  if (!fitsPathKeyLimit(path)) return "too-long-normalized";
  if (kept) return undefined;
  return newPathProblem(path);
}
