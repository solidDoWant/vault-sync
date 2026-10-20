import { unmaterializableReason, type PathRules } from "../vaultpath/platform";
import { fitsPathKeyLimit, isVaultRelativePath, maxPathBytes } from "../vaultpath/vaultpath";

/** Most UTF-8 bytes of one path segment: the file-name limit of every supported platform's filesystems. */
export const maxSegmentBytes = 255;
/** Most characters of the device name in a conflict copy's name. */
const maxDeviceNameLength = 40;

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).length;

/**
 * The path of a conflict copy of `path` (SPEC.md §6.3, §7):
 * `<name> (conflict <device> <date>).<ext>` next to it, where the date is the
 * UTC time `YYYY-MM-DD HHmmss` and `attempt` > 1 adds a counter before the
 * closing parenthesis, for when that name is taken. The device name is
 * reduced to characters that are legal in a file name on every supported
 * platform.
 *
 * The copy must be committable, so the name is shortened, from the end of
 * `<name>`, until the path fits the server's limits (4096 bytes, 8192 bytes
 * normalized) and its file name fits 255 bytes. Returns null if no name fits
 * (the folder part or extension alone is too long); the caller must then keep
 * the local version where it is rather than drop it. With `rules`, the copy
 * must also be one the local platform can hold (SPEC.md §8), e.g. within
 * Windows' MAX_PATH.
 */
export function conflictCopyPath(path: string, device: string, date: Date, attempt = 1, rules?: PathRules): string | null {
  return conflictName(path, device, date, attempt, true, "", rules);
}

/**
 * The path `rest` (a path inside the folder `folder`) takes when the folder
 * itself is renamed as a conflict copy: `<folder> (conflict <device>
 * <date>)/<rest>`, as conflictCopyPath names a file but with no extension
 * split off the folder's name. Used when a local file cannot be committed
 * because another document's path is one of its folders (SPEC.md §6.3).
 * Returns null if no name fits the limits (and, with `rules`, the platform).
 */
export function conflictFolderPath(folder: string, rest: string, device: string, date: Date, attempt = 1, rules?: PathRules): string | null {
  return conflictName(folder, device, date, attempt, false, `/${rest}`, rules);
}

/**
 * The end of a file or folder name that conflictCopyPath or conflictFolderPath
 * produced: ` (conflict <device> <date>[ <counter>])`, then the extension, if
 * any. The device label holds no parenthesis or separator (deviceLabel).
 */
const conflictSuffix = / \(conflict [^()/\\]+ \d{4}-\d{2}-\d{2} \d{6}(?: \d+)?\)(?:\.[^/]*)?$/u;

/**
 * Whether `path` is a conflict copy's or lies in a folder renamed as a
 * conflict copy: one of its segments has the name conflictCopyPath or
 * conflictFolderPath gives. Config sync keeps such copies on the device
 * (SPEC.md §8).
 */
export function isConflictCopyPath(path: string): boolean {
  return path.split("/").some((segment) => conflictSuffix.test(segment));
}

function conflictName(path: string, device: string, date: Date, attempt: number, splitExtension: boolean, tail: string, rules: PathRules | undefined): string | null {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const folder = path.slice(0, separator + 1);
  const name = path.slice(separator + 1);
  const dot = splitExtension ? name.lastIndexOf(".") : -1;
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const counter = attempt > 1 ? ` ${String(attempt)}` : "";
  const suffix = ` (conflict ${deviceLabel(device)} ${timestamp(date)}${counter})${extension}`;
  const characters = graphemes(stem);
  const candidate = (length: number) => `${folder}${characters.slice(0, length).join("")}${suffix}${tail}`;
  const fits = (length: number) => {
    const copy = candidate(length);
    const segment = copy.slice(folder.length, copy.length - tail.length);
    return (
      utf8Length(segment) <= maxSegmentBytes &&
      utf8Length(copy) <= maxPathBytes &&
      fitsPathKeyLimit(copy) &&
      isVaultRelativePath(copy) &&
      (rules === undefined || unmaterializableReason(copy, rules) === undefined)
    );
  };
  if (fits(characters.length)) return candidate(characters.length);
  if (!fits(0)) return null;
  // The longest prefix of the name that fits; every limit only grows with it.
  let low = 0;
  let high = characters.length;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return candidate(low);
}

/** The device name, reduced to characters legal in a file name everywhere; "device" if nothing is left. */
function deviceLabel(device: string): string {
  // Controls, separators and the characters Windows forbids in a name.
  // eslint-disable-next-line no-control-regex
  const cleaned = device.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f/\\:*?"<>|()]/g, "-").trim();
  const label = graphemes(cleaned).slice(0, maxDeviceNameLength).join("").trim();
  return label === "" ? "device" : label;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The user-perceived characters of `text`, so shortening never splits one (an accent from its letter, or an emoji). */
function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (segment) => segment.segment);
}

function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return `${day} ${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}
