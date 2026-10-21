/**
 * The local platform's file-name rules (SPEC.md §8, platform path rules). A
 * path the server accepts (§6.2) may still be impossible to create on the
 * device: the engine tracks such a document as unmaterializable instead of
 * writing it, and never renames it on the server.
 *
 * - `posix` (Linux): names of at most 255 UTF-8 bytes, absolute paths below
 *   PATH_MAX (4096 bytes), no NUL.
 * - `android` (Android's shared storage, `/storage/emulated`, where Obsidian
 *   keeps a vault): the `posix` limits, and its FUSE layer also refuses
 *   names with any of `"*:<>?\|`. The filesystem is case-insensitive, as
 *   FAT and sdcardfs are.
 * - `macos` (macOS, iOS): names of at most 255 UTF-8 bytes, absolute paths
 *   below PATH_MAX (1024 bytes), no NUL. The filesystem is case- and
 *   normalization-insensitive.
 * - `windows`: no `<>:"|?*`, `\` or control characters; no reserved device
 *   names (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9` and their
 *   superscript forms, `CONIN$`, `CONOUT$`; with or without an extension, in
 *   any case); no name ending in a dot or a space; names of at most 255
 *   UTF-16 code units; absolute paths below MAX_PATH (260 UTF-16 code units).
 *   The filesystem is case-insensitive.
 */
export type PathPlatform = "posix" | "android" | "windows" | "macos";

export interface PathRules {
  platform: PathPlatform;
  /**
   * The vault folder's absolute path, if known, so the length limits count
   * it (with the separator before the vault-relative path). Without it only
   * the vault-relative path is counted.
   */
  root?: string;
}

/** Why a path cannot be created on the local platform. */
export type UnmaterializableReason = "reserved-name" | "forbidden-character" | "trailing-dot-or-space" | "name-too-long" | "path-too-long";

/**
 * Why the engine tracks a document as unmaterializable: a reason the rules
 * found, or `refused-by-vault` when the rules allow the path but the vault
 * refused it anyway (VaultError "unmaterializable").
 */
export type UnmaterializableCause = UnmaterializableReason | "refused-by-vault";

/** The rules of a platform where every path the server accepts can be created (up to the length limits). */
export const posixPathRules: PathRules = { platform: "posix" };

/**
 * The name the platform's filesystem takes `path` (vault-relative) for, `F`
 * in docs/design/engine-path-ownership.md §3.1: two spellings name one file
 * exactly when their keys are equal. The path itself on `posix`; on
 * `windows` each UTF-16 code unit by its simple upper-case mapping, as NTFS
 * compares names (never `ß` to `SS`); on `android` the same, as FAT and
 * sdcardfs fold case (decision 7, #544); on `macos` that after NFD, as APFS
 * and HFS+ ignore case and Unicode normalization. It is not ordered with the
 * path key (§5): it folds neither `ß`/`SS` nor, on Windows and Android,
 * NFC/NFD, so two spellings with one path key can be two files on the
 * device (decision #52); and it takes `ı` for `I`, which the path key keeps
 * apart. Compare paths through the engine's PathSpace, not with this
 * directly.
 */
export function filesystemKey(path: string, platform: PathPlatform): string {
  if (platform === "posix") return path;
  const decomposed = platform === "macos" ? path.normalize("NFD") : path;
  let folded = "";
  for (let index = 0; index < decomposed.length; index++) {
    const unit = decomposed.charAt(index);
    const upper = unit.toUpperCase();
    // A mapping to more than one unit (ß to SS, say) is full case folding, which none of these filesystems does.
    folded += upper.length === 1 ? upper : unit;
  }
  return platform === "macos" ? folded.normalize("NFD") : folded;
}

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).length;

const maxNameLength = 255;
/** Longest absolute path, terminator excluded, in the platform's units: UTF-16 code units on Windows, UTF-8 bytes elsewhere. */
const maxPathLength: Record<PathPlatform, number> = { posix: 4095, android: 4095, macos: 1023, windows: 259 };

// Control characters, the characters Win32 forbids in names, and "\", which
// Windows would take as a separator (a different file than the one named).
// eslint-disable-next-line no-control-regex
const windowsForbidden = /[\u0000-\u001f<>:"|?*\\]/;
// The characters Android's shared storage refuses in a name, and NUL.
// eslint-disable-next-line no-control-regex
const sharedStorageForbidden = /[\u0000"*:<>?\\|]/;
// eslint-disable-next-line no-control-regex
const posixForbidden = /\u0000/;
const windowsReserved =/^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9¹²³])$/i;

/**
 * Why `path` (vault-relative, "/"-separated) cannot be created on the
 * platform `rules` describe, or undefined if it can.
 */
export function unmaterializableReason(path: string, rules: PathRules): UnmaterializableReason | undefined {
  const windows = rules.platform === "windows";
  const segments = path.split("/");
  const forbidden = windows ? windowsForbidden : rules.platform === "android" ? sharedStorageForbidden : posixForbidden;
  if (segments.some((segment) => forbidden.test(segment))) return "forbidden-character";
  if (windows) {
    for (const segment of segments) {
      // NUL.txt and NUL .txt are NUL too: Windows ignores what follows the first dot, and trailing spaces before it.
      const stem = segment.split(".")[0]?.trimEnd() ?? "";
      if (windowsReserved.test(stem)) return "reserved-name";
    }
    if (segments.some((segment) => segment.endsWith(".") || segment.endsWith(" "))) return "trailing-dot-or-space";
  }
  const length = windows ? (text: string) => text.length : utf8Length;
  if (segments.some((segment) => length(segment) > maxNameLength)) return "name-too-long";
  const root = rules.root ?? "";
  const separator = root === "" || /[/\\]$/.test(root) ? 0 : 1;
  if (length(root) + separator + length(path) > maxPathLength[rules.platform]) return "path-too-long";
  return undefined;
}
