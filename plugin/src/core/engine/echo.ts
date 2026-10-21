import type { VaultEvent } from "../vault/adapter";

type Expectation = { type: "write"; hash: string } | { type: "delete" } | { type: "rename"; from: string };

/**
 * Remembers the engine's own vault changes (path + content hash, SPEC.md §8)
 * so that the vault events they cause are not mistaken for user edits.
 *
 * An expectation is registered before the change is made and cancelled if the
 * change fails. A write event is an echo only if the file then holds content
 * the engine wrote (by hash), so a user edit that lands on top of an engine
 * write is still reported. Reporting a change twice is harmless; missing one
 * is not, so every doubt resolves to "user edit".
 *
 * Events at a path arrive in the order of the changes, so an event that
 * matches an expectation also expires every expectation registered before it
 * at that path: their events were lost (or folded into this one). A lost event
 * therefore leaves its expectation only until the engine's next change at the
 * path is seen, not forever, where it could swallow a later user change.
 *
 * Paths match under the filesystem's name equivalence `F` (design §3.1,
 * PO-10, INV-10), never by path key: the spellings `F` takes for one file
 * are one file here, as on the device, so an engine write at `Notes/a.md`
 * that the filesystem lands in its `notes/` folder is still the engine's
 * (#737). Two files whose spellings merely share a path key (`Straße.md`,
 * `STRASSE.md`) stay two files (#380).
 */
export class EchoSuppressor {
  /** Expectations by `F` of the path the event will name. */
  private readonly expected = new Map<string, Expectation[]>();

  /** `filesystemKey` is `F`: identity on a case-sensitive platform. */
  constructor(private readonly filesystemKey: (path: string) => string = (path) => path) {}

  /** Expects a create or modify event at `path` leaving content with `hash`. */
  expectWrite(path: string, hash: string): () => void {
    return this.add(path, { type: "write", hash });
  }

  expectDelete(path: string): () => void {
    return this.add(path, { type: "delete" });
  }

  expectRename(from: string, to: string): () => void {
    return this.add(to, { type: "rename", from: this.filesystemKey(from) });
  }

  /**
   * Whether `event` is an echo of an expected engine change, consuming the
   * expectation. `hashAt` hashes the file currently at a path (null if absent).
   */
  async isEcho(event: VaultEvent, hashAt: (path: string) => Promise<string | null>): Promise<boolean> {
    const key = this.filesystemKey(event.path);
    const list = this.expected.get(key);
    if (list === undefined) return false;
    switch (event.type) {
      case "delete":
        return this.consume(key, list.find((entry) => entry.type === "delete"), true);
      case "rename":
        return this.consume(
          key,
          list.find((entry) => entry.type === "rename" && entry.from === this.filesystemKey(event.oldPath)),
          true,
        );
      case "create":
      case "modify": {
        const writes = list.filter((entry) => entry.type === "write");
        if (writes.length === 0) return false;
        // Two engine writes to one path can both be on disk before the first
        // event is handled, so accept any content the engine wrote there.
        const hash = await hashAt(event.path);
        this.consume(key, writes[0], true);
        return writes.some((entry) => entry.hash === hash);
      }
    }
  }

  private add(path: string, expectation: Expectation): () => void {
    const key = this.filesystemKey(path);
    const list = this.expected.get(key) ?? [];
    list.push(expectation);
    this.expected.set(key, list);
    return () => {
      this.consume(key, expectation);
    };
  }

  /** Removes `expectation`; for one an event matched (`expireEarlier`), also those registered before it at `key`. */
  private consume(key: string, expectation: Expectation | undefined, expireEarlier = false): boolean {
    if (expectation === undefined) return false;
    const list = this.expected.get(key);
    const index = list?.indexOf(expectation) ?? -1;
    if (list === undefined || index < 0) return false;
    if (expireEarlier) list.splice(0, index + 1);
    else list.splice(index, 1);
    if (list.length === 0) this.expected.delete(key);
    return true;
  }
}
