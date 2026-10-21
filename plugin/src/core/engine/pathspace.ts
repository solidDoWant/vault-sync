import { pathKey } from "../pathkey/pathkey";
import { filesystemKey, posixPathRules, type PathRules } from "../vaultpath/platform";

/** Which equivalence `PathSpace.collides` compares paths by. */
export type PathEquivalence = "server" | "file";

/**
 * The one owner of how the engine compares paths
 * (docs/design/engine-path-ownership.md §3, §9.1). Three relations:
 *
 * - spelling: the exact string.
 * - `serverKey` (`K`): the path key (SPEC.md §5), NFC and full case folding.
 *   What the server keeps unique, so what conflict-copy names stay clear of.
 * - `filesystemKey` (`F`): the platform filesystem's name equivalence
 *   (identity on `posix`, simple upper case per UTF-16 unit on `windows` and
 *   `android`, NFD plus that on `macos`). Which spellings name one file on
 *   the device.
 *
 * `K` and `F` are not ordered: `Straße.md` and `STRASSE.md` share a `K` but
 * are two NTFS, APFS or FAT files, and `ı.md` and `I.md` are one file with
 * two `K`s (`ı` folds to itself, but its upper case is `I`). The engine's
 * `fileKey` on a case-insensitive platform is `K` of `F`. Two spellings with
 * one `F` always have one file key, so a document at `I.md` is never taken
 * for a stranger to the file at `ı.md` (§6.4 item 4). Two spellings with one
 * `K` almost always do too, but not always: it is not the exact join of the
 * two. On `windows` and `android`, which do not normalize first, `F` upper-
 * cases U+0345 COMBINING GREEK YPOGEGRAMMENI (combining class 240) to U+0399
 * (class 0), which canonical reordering no longer moves. So `α` U+0345 U+0301
 * and `α` U+0301 U+0345, canonically equivalent (one `K`), get two file
 * keys, and are two names on the device too (#585); the first also shares
 * an `F`, and so a file key, with `α` `ι` U+0301, whose `K` differs. Where
 * one file key holds two files (`ß`/`SS`), `oneFile` tells them apart.
 */
export class PathSpace {
  readonly rules: PathRules;
  /** The engine's file key: identity on `posix`, `K` of `F` elsewhere. */
  readonly fileKey: (path: string) => string;

  constructor(rules: PathRules = posixPathRules) {
    this.rules = rules;
    const { platform } = rules;
    this.fileKey = platform === "posix" ? (path) => path : (path) => pathKey(filesystemKey(path, platform));
  }

  /** `K(path)`: the server's path key (SPEC.md §5). */
  serverKey(path: string): string {
    return pathKey(path);
  }

  /** `F(path)`: the name the platform filesystem takes `path` for. */
  filesystemKey(path: string): string {
    return filesystemKey(path, this.rules.platform);
  }

  /** Whether the filesystem takes `a` and `b` for one file: `F(a) = F(b)`. */
  oneFile(a: string, b: string): boolean {
    return a === b || this.filesystemKey(a) === this.filesystemKey(b);
  }

  /** The folders `path` is in, outermost first: its proper "/"-separated prefixes. */
  ancestors(path: string): string[] {
    return ancestors(path);
  }

  /**
   * Whether `a` and `b` collide under `equivalence` (§3.2): one key, or the
   * key of one is a folder of the other's (folders are implicit, SPEC.md §5).
   */
  collides(a: string, b: string, equivalence: PathEquivalence): boolean {
    const key = equivalence === "server" ? (path: string) => this.serverKey(path) : this.fileKey;
    const left = key(a);
    const right = key(b);
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }
}

/** The folders `path` is in, outermost first. */
function ancestors(path: string): string[] {
  const segments = path.split("/");
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/"));
}
