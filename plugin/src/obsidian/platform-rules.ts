// No Obsidian import: main.ts and the vault adapter use these, and their unit
// tests run without Obsidian.

import type { PathRules } from "../core/vaultpath/platform";

/** The fields of Obsidian's `Platform` that decide the path rules. */
export interface PlatformFlags {
  isWin: boolean;
  isMacOS: boolean;
  isIosApp: boolean;
  isAndroidApp: boolean;
}

/**
 * The file-name rules of the device Obsidian runs on (SPEC.md §8), with the
 * vault folder's absolute path where Obsidian exposes it (desktop), so the
 * length limits count it. Android follows the POSIX rules plus its shared
 * storage's character set.
 */
export function pathRulesFor(platform: PlatformFlags, root?: string): PathRules {
  const rules: PathRules = { platform: platform.isWin ? "windows" : platform.isMacOS || platform.isIosApp ? "macos" : "posix" };
  if (platform.isAndroidApp) rules.sharedStorage = true;
  if (root !== undefined) rules.root = root;
  return rules;
}

/**
 * OS error codes that mean the file system cannot hold a name or path:
 * ENAMETOOLONG (a name or path over the limit), EINVAL (Windows refusing a
 * character or a reserved name, Android's FUSE refusing a character) and
 * EILSEQ (a name the file system's encoding cannot represent).
 */
const unmaterializableCodes = new Set(["ENAMETOOLONG", "EINVAL", "EILSEQ"]);

/**
 * Whether `error`, thrown by Obsidian creating a file or folder or renaming
 * one, says the platform cannot hold that path: Node's errors (desktop)
 * carry the code in `code`; Capacitor's (mobile) only in the message.
 */
export function isUnmaterializableOsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && unmaterializableCodes.has(code)) return true;
  if (typeof message !== "string") return false;
  return /\b(ENAMETOOLONG|EINVAL|EILSEQ)\b|file name too long|name too long|invalid argument|illegal byte sequence/i.test(message);
}

/**
 * Whether `error` is the OS saying a file or folder does not exist (ENOENT).
 * Windows also says it for a name it refuses: Node (libuv) maps
 * ERROR_INVALID_NAME, which Windows gives for a name over 255 characters or
 * with a forbidden character, to ENOENT. So the vault adapter takes ENOENT
 * from a create or rename as a refused name when everything it does depend
 * on (the parent folder, a rename's source) exists.
 */
export function isNotFoundOsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "ENOENT") return true;
  return typeof message === "string" && /\bENOENT\b|no such file or directory/i.test(message);
}
