import { graphemes } from "../graphemes";

/** Most UTF-8 bytes of one path part (docs/design/engine.md §6). */
export const maxPartBytes = 255;
/** Most UTF-8 bytes of a whole vault-relative path (§6). */
export const maxPathBytes = 1024;

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).length;

/**
 * The name of a conflict copy of `path` (docs/design/engine.md §5, rule C):
 * `<name> (Conflicted copy <user> <device> <YYYYMMDDHHMM>).<ext>` in the
 * same folder, named after the local user and device
 * (docs/design/sharing.md, Attribution), with ` 2`, ` 3`, … appended to the name while `taken` says the
 * name is in use. `<name>` is shortened until the copy fits the path limits
 * (§6); the copy is never dropped, so the result is null only when not even
 * an empty `<name>` fits (the folder alone is too long).
 *
 * `folder` names a folder instead of a file: no extension is split off.
 */
export function conflictCopyName(path: string, user: string, device: string, date: Date, taken: (path: string) => boolean, folder = false): string | null {
  const separator = path.lastIndexOf("/");
  const parent = path.slice(0, separator + 1);
  const name = path.slice(separator + 1);
  const dot = folder ? -1 : name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const characters = graphemes(stem);
  const label = `${nameLabel(user, "user")} ${nameLabel(device, "device")}`;
  for (let attempt = 1; ; attempt++) {
    const suffix = ` (Conflicted copy ${label} ${timestamp(date)})${attempt > 1 ? ` ${String(attempt)}` : ""}${extension}`;
    const candidate = (length: number) => `${parent}${characters.slice(0, length).join("")}${suffix}`;
    const fits = (length: number) => {
      const copy = candidate(length);
      return utf8Length(copy.slice(parent.length)) <= maxPartBytes && utf8Length(copy) <= maxPathBytes;
    };
    if (!fits(0)) return null;
    let length = characters.length;
    if (!fits(length)) {
      // The longest prefix of the name that fits; the length only grows with it.
      let low = 0;
      let high = length;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (fits(middle)) low = middle;
        else high = middle;
      }
      length = low;
    }
    const copy = candidate(length);
    if (!taken(copy)) return copy;
  }
}

/** A user or device name, reduced to characters a portable name may hold (§6); `fallback` if nothing is left. */
function nameLabel(name: string, fallback: string): string {
  // Controls, the separator and the characters §6 forbids.
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/\s+/gu, " ").replace(/[\u0000-\u001f\u007f<>:"/\\|?*()]/gu, "-").trim();
  const label = graphemes(cleaned).slice(0, 40).join("").trim();
  return label === "" ? fallback : label;
}

/** `YYYYMMDDHHMM` in UTC, so every device names a copy made at one moment alike. */
function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getUTCFullYear())}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}
