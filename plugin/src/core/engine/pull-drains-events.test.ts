import { describe, expect, it } from "vitest";

import type { DocumentState } from "../journal/journal";
import { InMemoryJournal } from "../journal/memory";
import { InMemoryServer } from "./memory-server";
import { files, harness } from "./testing";

// A pull must not run ahead of a vault event the engine has already received
// (#325, #409 item 8; design PO-2). The user moves or deletes an untracked
// file at `e.md` while another device creates document R at `e.md`. If this
// device's pull applied R at `e.md` before it handled the user's event, the
// late event would be attributed to R: R moved to the user's path with the
// user's content, or deleted. Every binding transition and every read of the
// bindings a pull makes go through one queue (Bindings.serialize), and rule W
// waits for the queued events (heldByAnother), so the pull decides after the
// user's event. Here the user's event waits behind an earlier transition the
// test holds. The window left is an event the vault has not emitted yet.

const bytes = (content: string) => new TextEncoder().encode(content);

/**
 * A journal that holds its first `documentsByFileKey` read once armed: the
 * first journal read of a rename or delete transition (Bindings.renamed and
 * deleted), so the engine's handling of that event stalls before it moves a
 * binding, until the test opens it.
 */
class GatedJournal extends InMemoryJournal {
  private release: (() => void) | undefined;
  private held: Promise<void> | undefined;
  stalled = 0;

  arm(): void {
    this.held = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  open(): void {
    this.release?.();
  }

  override async documentsByFileKey(fileKey: string): Promise<DocumentState[]> {
    const held = this.held;
    this.held = undefined;
    if (held !== undefined) {
      this.stalled++;
      await held;
    }
    return super.documentsByFileKey(fileKey);
  }
}

/** Two devices over one server; `a` keeps its journal in `gate`. */
function devices(gate: GatedJournal) {
  const server = new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 5 });
  const a = harness({
    merge: "default",
    server,
    idPrefix: "a",
    deviceName: "device-a",
    journal: gate,
  });
  const b = harness({
    merge: "default",
    server,
    idPrefix: "b",
    deviceName: "device-b",
  });
  return { server, a, b };
}

/** Lets every queued in-memory step that does not wait on the gate run to its end. */
async function drain(): Promise<void> {
  for (let tick = 0; tick < 50; tick++)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a pull with a vault event still being handled (#325, #409 item 8)", () => {
  it("does not make another device's new document take the user's rename from its path", async () => {
    const gate = new GatedJournal();
    const { a, b, server } = devices(gate);
    await a.vault.write("e.md", bytes("mine\n"));
    await a.vault.write("z.md", bytes("other\n"));
    await a.engine.settled();
    await b.vault.write("e.md", bytes("remote\n"));
    await b.engine.push();
    const remote = server.liveDocuments().get("e.md");
    expect(remote).toBeDefined();

    gate.arm();
    await a.vault.rename("z.md", "y.md");
    await a.vault.rename("e.md", "notes/f.md");
    const pulled = a.engine.pull();
    await drain();
    expect(gate.stalled).toBeGreaterThan(0);
    gate.open();
    await pulled;
    await a.engine.settled();
    for (let round = 0; round < 3; round++) {
      await a.engine.push();
      await b.engine.push();
    }

    const live = server.liveDocuments();
    expect(live.get("e.md")).toBe(remote);
    expect(live.get("notes/f.md")).toBeDefined();
    expect(live.get("notes/f.md")).not.toBe(remote);
    expect(server.liveFiles()).toEqual(
      new Map([
        ["e.md", "remote\n"],
        ["notes/f.md", "mine\n"],
        ["y.md", "other\n"],
      ]),
    );
    expect(
      server
        .history(remote ?? "")
        .map((revision) => new TextDecoder().decode(revision.path)),
    ).toEqual(["e.md"]);
    expect(await files(a.vault)).toEqual(server.liveFiles());
    expect(await files(b.vault)).toEqual(server.liveFiles());
  });

  it("does not make the user's delete of a file at the path delete another device's new document there", async () => {
    const gate = new GatedJournal();
    const { a, b, server } = devices(gate);
    await a.vault.write("e.md", bytes("mine\n"));
    await a.vault.write("z.md", bytes("other\n"));
    await a.engine.settled();
    await b.vault.write("e.md", bytes("remote\n"));
    await b.engine.push();
    const remote = server.liveDocuments().get("e.md");
    expect(remote).toBeDefined();

    gate.arm();
    await a.vault.rename("z.md", "y.md");
    await a.vault.delete("e.md");
    const pulled = a.engine.pull();
    await drain();
    expect(gate.stalled).toBeGreaterThan(0);
    gate.open();
    await pulled;
    await a.engine.settled();
    for (let round = 0; round < 3; round++) {
      await a.engine.push();
      await b.engine.push();
    }

    expect(server.liveDocuments().get("e.md")).toBe(remote);
    expect(server.liveFiles()).toEqual(
      new Map([
        ["e.md", "remote\n"],
        ["y.md", "other\n"],
      ]),
    );
    expect(server.deletedDocuments()).toEqual([]);
    expect(await files(a.vault)).toEqual(server.liveFiles());
    expect(await files(b.vault)).toEqual(server.liveFiles());
  });
});
