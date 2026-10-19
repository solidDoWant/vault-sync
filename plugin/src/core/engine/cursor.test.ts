import { describe, expect, it } from "vitest";

import { InMemoryJournal } from "../journal/memory";
import { Crash, files, harness, moveHeadBeforeCommit } from "./testing";

// The durable cursor after this device's own commits (SPEC.md §6.1, §6.4):
// an acknowledged commit that is the next seq after the cursor moves the
// cursor onto it, so the device's own vault_changed starts no pull; any other
// device's commit still below it keeps the cursor where a pull must resume.

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

/** A journal whose next cursor move fails while armed: the engine "dies" just before it. */
class CursorCrashJournal extends InMemoryJournal {
  armed = false;
  override setCursor(seq: bigint): Promise<void> {
    if (this.armed) {
      this.armed = false;
      return Promise.reject(new Crash("crash before the cursor moved"));
    }
    return super.setCursor(seq);
  }
}

/** Counts the ListChanges calls the server receives from now on. */
function countPulls(h: ReturnType<typeof harness>): () => number {
  let pulls = 0;
  const previous = h.server.interceptor;
  h.server.interceptor = (method, request) => {
    previous?.(method, request);
    if (method === "ListChanges") pulls++;
  };
  return () => pulls;
}

describe("SyncEngine cursor after its own commits", () => {
  it("moves the cursor onto each of its own commits when nothing else was committed in between", async () => {
    const h = harness();
    h.server.commit({ documentId: "remote", path: "remote.md", content: "from another device" });
    await h.engine.pull();
    await h.vault.write("one.md", bytes("1"));
    await h.vault.write("two.md", bytes("2"));
    await h.vault.write("three.md", bytes("3"));

    const summary = await h.engine.push();

    expect(summary.committed).toBe(3);
    expect(h.server.currentHeadSeq).toBe(4n);
    expect(await h.journal.getCursor()).toBe(4n);
  });

  it("does not call the server for a notification at or below the cursor", async () => {
    const h = harness();
    await h.vault.write("mine.md", bytes("mine"));
    await h.engine.push();
    const own = h.server.currentHeadSeq;
    const pulls = countPulls(h);

    expect(await h.engine.pullIfBehind(own)).toBeUndefined();
    expect(await h.engine.pullIfBehind(own - 1n)).toBeUndefined();

    expect(pulls()).toBe(0);
  });

  it("keeps the cursor below another device's commit that landed just before its own, and pulls that commit on its own notification", async () => {
    const h = harness();
    await h.engine.pull();
    moveHeadBeforeCommit(h, () => {
      h.server.commit({ documentId: "theirs", path: "theirs.md", content: "committed in between" });
    });
    await h.vault.write("mine.md", bytes("mine"));

    await h.engine.push();

    // Theirs is seq 1, mine seq 2: the cursor must not pass theirs unapplied.
    expect(h.server.currentHeadSeq).toBe(2n);
    expect(await h.journal.getCursor()).toBe(0n);
    expect(await h.engine.pullIfBehind(2n)).toMatchObject({ cursor: 2n, applied: 1 });
    expect(await files(h.vault)).toEqual(
      new Map([
        ["mine.md", "mine"],
        ["theirs.md", "committed in between"],
      ]),
    );
  });

  it("pulls on a notification above the cursor", async () => {
    const h = harness();
    await h.vault.write("mine.md", bytes("mine"));
    await h.engine.push();
    const theirs = h.server.commit({ documentId: "theirs", path: "theirs.md", content: "later" });

    expect(await h.engine.pullIfBehind(theirs.seq)).toMatchObject({ cursor: theirs.seq, applied: 1 });
    expect((await files(h.vault)).get("theirs.md")).toBe("later");
  });

  it("resumes from the cursor below its own commit when interrupted before the cursor moved", async () => {
    const journal = new CursorCrashJournal();
    const h = harness({ journal });
    await h.engine.pull();
    await h.vault.write("mine.md", bytes("mine"));
    // The commit is acknowledged and recorded; the cursor move is what fails.
    journal.armed = true;
    await expect(h.engine.push()).rejects.toBeInstanceOf(Crash);
    expect(h.server.currentHeadSeq).toBe(1n);
    expect(await journal.getCursor()).toBe(0n);
    const theirs = h.server.commit({ documentId: "theirs", path: "theirs.md", content: "after the crash" });

    h.restart();
    expect(await h.engine.pullIfBehind(theirs.seq)).toMatchObject({ cursor: theirs.seq, applied: 1 });
    expect(await files(h.vault)).toEqual(
      new Map([
        ["mine.md", "mine"],
        ["theirs.md", "after the crash"],
      ]),
    );
    expect(await journal.listPending()).toEqual([]);
  });
});
