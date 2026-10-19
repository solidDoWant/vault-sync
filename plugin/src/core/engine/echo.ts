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
 */
export class EchoSuppressor {
  private readonly expected = new Map<string, Expectation[]>();

  /** Expects a create or modify event at `path` leaving content with `hash`. */
  expectWrite(path: string, hash: string): () => void {
    return this.add(path, { type: "write", hash });
  }

  expectDelete(path: string): () => void {
    return this.add(path, { type: "delete" });
  }

  expectRename(from: string, to: string): () => void {
    return this.add(to, { type: "rename", from });
  }

  /**
   * Whether `event` is an echo of an expected engine change, consuming the
   * expectation. `hashAt` hashes the file currently at a path (null if absent).
   */
  async isEcho(event: VaultEvent, hashAt: (path: string) => Promise<string | null>): Promise<boolean> {
    const list = this.expected.get(event.path);
    if (list === undefined) return false;
    switch (event.type) {
      case "delete":
        return this.consume(event.path, list.find((entry) => entry.type === "delete"), true);
      case "rename":
        return this.consume(
          event.path,
          list.find((entry) => entry.type === "rename" && entry.from === event.oldPath),
          true,
        );
      case "create":
      case "modify": {
        const writes = list.filter((entry) => entry.type === "write");
        if (writes.length === 0) return false;
        // Two engine writes to one path can both be on disk before the first
        // event is handled, so accept any content the engine wrote there.
        const hash = await hashAt(event.path);
        this.consume(event.path, writes[0], true);
        return writes.some((entry) => entry.hash === hash);
      }
    }
  }

  private add(path: string, expectation: Expectation): () => void {
    const list = this.expected.get(path) ?? [];
    list.push(expectation);
    this.expected.set(path, list);
    return () => {
      this.consume(path, expectation);
    };
  }

  /** Removes `expectation`; for one an event matched (`expireEarlier`), also those registered before it at `path`. */
  private consume(path: string, expectation: Expectation | undefined, expireEarlier = false): boolean {
    if (expectation === undefined) return false;
    const list = this.expected.get(path);
    const index = list?.indexOf(expectation) ?? -1;
    if (list === undefined || index < 0) return false;
    if (expireEarlier) list.splice(0, index + 1);
    else list.splice(index, 1);
    if (list.length === 0) this.expected.delete(path);
    return true;
  }
}
