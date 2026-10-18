import { pathKey } from "../pathkey/pathkey";
import { isVaultRelativePath } from "../vaultpath/vaultpath";

/** Most UTF-8 bytes of a plaintext path the server accepts (SPEC.md §6.2). */
export const maxPathBytes = 4096;
/** Most UTF-8 bytes of a normalized path (`path_key`) the server accepts (SPEC.md §6.2). */
export const maxPathKeyBytes = 8192;
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
 * the local version where it is rather than drop it.
 */
export function conflictCopyPath(path: string, device: string, date: Date, attempt = 1): string | null {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const folder = path.slice(0, separator + 1);
  const name = path.slice(separator + 1);
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const counter = attempt > 1 ? ` ${String(attempt)}` : "";
  const suffix = ` (conflict ${deviceLabel(device)} ${timestamp(date)}${counter})${extension}`;
  const characters = graphemes(stem);
  const candidate = (length: number) => `${folder}${characters.slice(0, length).join("")}${suffix}`;
  const fits = (length: number) => {
    const copy = candidate(length);
    const segment = copy.slice(folder.length);
    return utf8Length(segment) <= maxSegmentBytes && utf8Length(copy) <= maxPathBytes && utf8Length(pathKey(copy)) <= maxPathKeyBytes && isVaultRelativePath(copy);
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
