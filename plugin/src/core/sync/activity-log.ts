/**
 * What happened, in one entry of the activity log:
 * - `uploaded`: this device pushed a file or folder (created, edited or renamed);
 * - `downloaded`: a change from the server was applied here;
 * - `deleted-on-server`: this device pushed a deletion;
 * - `deleted-here`: a deletion from the server removed the file here;
 * - `conflict`: a conflict copy was made (rule C); its path is the copy's;
 * - `connection-problem`: the server could not be reached.
 */
export type ActivityKind = "uploaded" | "downloaded" | "deleted-on-server" | "deleted-here" | "conflict" | "connection-problem";

export interface ActivityEntry {
  kind: ActivityKind;
  /** The file or folder, where there is one. Absent for a connection problem. */
  path?: string;
  folder?: boolean;
  /** Milliseconds since the epoch. */
  time: number;
}

/** How many entries a log keeps unless told otherwise. */
export const defaultActivityCapacity = 500;

/**
 * The recent sync events of one vault, newest first. It holds at most
 * `capacity` entries: adding one more drops the oldest, so a device that
 * runs for a long time does not grow it without limit.
 *
 * It lives only in memory. Nothing writes it to disk, sends it to the server
 * or logs it, so in an end-to-end encrypted vault its plaintext paths never
 * leave the device.
 */
export class ActivityLog {
  /** Oldest first. */
  private readonly items: ActivityEntry[] = [];

  constructor(readonly capacity = defaultActivityCapacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`activity log capacity must be a positive integer, got ${String(capacity)}`);
  }

  add(entry: ActivityEntry): void {
    this.items.push({ ...entry });
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  /** The entries, newest first. */
  entries(): ActivityEntry[] {
    return this.items.map((entry) => ({ ...entry })).reverse();
  }

  get size(): number {
    return this.items.length;
  }
}
