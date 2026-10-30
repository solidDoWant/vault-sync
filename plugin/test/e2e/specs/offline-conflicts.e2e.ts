import { browser, expect } from "@wdio/globals";

import {
  conflictCopies,
  contentOf,
  converged,
  currentDevice,
  goOffline,
  goOnline,
  openSecondDevice,
  renamePath,
  deletePath,
  setUpDevice,
  use,
  waitForIdle,
  waitForServer,
  waitForText,
  writeBinary,
  writeNote,
  type Device,
} from "../devices";
import { e2eEnvironment } from "../environment";

// Offline edits and conflicts between two devices (docs/acceptance/phase-2.md,
// AC-10 to AC-16; docs/design/engine.md §5). A and B are two vaults open in
// one Obsidian (devices.ts). A concurrent change is made by taking B offline,
// changing the note on A (which reaches the server), changing it on B, and
// bringing B back: B's commit is the one refused, so B resolves the conflict.

const subject = "plugin-e2e-conflicts-user";
const remoteVaultName = "e2e conflicts";

describe("offline edits and conflicts between two devices", function () {
  let a: Device;
  let b: Device;

  before(async function () {
    // The second device is a second vault on disk opened in the same desktop
    // Obsidian (devices.ts), which needs the vault's file-system path: the
    // Android app has none. Desktop and emulated mobile run this spec.
    if (e2eEnvironment.android) this.skip();
    a = await currentDevice("A");
    await setUpDevice(a, subject, remoteVaultName, true);
    await waitForIdle(a);
    b = await openSecondDevice("B", "./test/e2e/vaults/second");
    await setUpDevice(b, subject, remoteVaultName, false);
    await converged(a, b);
  });

  /** Writes `text` at `path` on A and waits until B has it too. */
  async function shared(path: string, text: string): Promise<void> {
    await use(a);
    await writeNote(path, text);
    await waitForText(b, path, text);
    await converged(a, b);
  }

  it("[AC-10] edits made on A while it is offline upload when it reconnects", async function () {
    await shared("Offline.md", "before\n");
    await goOffline(a);
    await writeNote("Offline.md", "before\nwritten offline\n");
    await writeNote("Created offline.md", "new while offline\n");
    await goOnline(a, remoteVaultName);
    await waitForText(b, "Offline.md", "before\nwritten offline\n");
    await waitForText(b, "Created offline.md", "new while offline\n");
    await converged(a, b);
  });

  it("[AC-11] edits to different parts of one note are merged on both devices, with no conflict copy", async function () {
    await shared("Merge.md", "one\ntwo\nthree\nfour\nfive\n");
    await goOffline(b);
    await use(a);
    await writeNote("Merge.md", "one from A\ntwo\nthree\nfour\nfive\n");
    await waitForServer(a, (heads) => heads["Merge.md"] === contentOf("one from A\ntwo\nthree\nfour\nfive\n"), "A's edit");
    await use(b);
    await writeNote("Merge.md", "one\ntwo\nthree\nfour\nfive from B\n");
    await goOnline(b, remoteVaultName);

    const merged = "one from A\ntwo\nthree\nfour\nfive from B\n";
    await waitForText(a, "Merge.md", merged);
    const files = await converged(a, b);
    expect(files["Merge.md"]).toBe(merged);
    expect(conflictCopies(files)).toEqual([]);
  });

  it("edits to different views of one Bases file are merged on both devices, with no conflict copy", async function () {
    const base = "views:\n  - type: table\n    name: Books\n    limit: 10\n  - type: cards\n    name: Gallery\n";
    await shared("Library.base", base);
    await goOffline(b);
    await use(a);
    const fromA = base.replace("limit: 10", "limit: 200");
    await writeNote("Library.base", fromA);
    await waitForServer(a, (heads) => heads["Library.base"] === contentOf(fromA), "A's edit");
    await use(b);
    await writeNote("Library.base", `${base}    order:\n      - file.name\n`);
    await goOnline(b, remoteVaultName);

    const merged = "views:\n  - type: table\n    name: Books\n    limit: 200\n  - type: cards\n    name: Gallery\n    order:\n      - file.name\n";
    await waitForText(a, "Library.base", merged);
    const files = await converged(a, b);
    expect(files["Library.base"]).toBe(contentOf(merged));
    expect(conflictCopies(files)).toEqual([]);
  });

  it("canvas edits from two devices (one moves a node, the other recolours it) are merged on both devices, with no conflict copy", async function () {
    const base = '{"nodes":[{"id":"a","type":"text","text":"A","x":0,"y":0,"width":250,"height":60},{"id":"b","type":"text","text":"B","x":0,"y":100,"width":250,"height":60}],"edges":[]}';
    await shared("Board.canvas", base);
    await goOffline(b);
    await use(a);
    const fromA = base.replace('"x":0,"y":0', '"x":40,"y":0');
    await writeNote("Board.canvas", fromA);
    await waitForServer(a, (heads) => heads["Board.canvas"] === contentOf(fromA), "A's edit");
    await use(b);
    await writeNote("Board.canvas", base.replace('"text":"A",', '"text":"A","color":"4",'));
    await goOnline(b, remoteVaultName);

    const merged = '{"nodes":[{"id":"a","type":"text","text":"A","x":40,"y":0,"width":250,"height":60,"color":"4"},{"id":"b","type":"text","text":"B","x":0,"y":100,"width":250,"height":60}],"edges":[]}';
    await waitForText(a, "Board.canvas", merged);
    const files = await converged(a, b);
    expect(files["Board.canvas"]).toBe(contentOf(merged));
    expect(conflictCopies(files)).toEqual([]);
  });

  it("[AC-12] edits to the same lines keep the server's version at the path and exactly one conflict copy of the other", async function () {
    await shared("Clash.md", "intro\nthe same line\noutro\n");
    await goOffline(b);
    await use(a);
    await writeNote("Clash.md", "intro\nthe line as A wrote it\noutro\n");
    await waitForServer(a, (heads) => heads["Clash.md"] === contentOf("intro\nthe line as A wrote it\noutro\n"), "A's edit");
    await use(b);
    await writeNote("Clash.md", "intro\nthe line as B wrote it\noutro\n");
    await goOnline(b, remoteVaultName);

    const files = await waitForCopies(1);
    expect(files["Clash.md"]).toBe("intro\nthe line as A wrote it\noutro\n");
    const copies = conflictCopies(files);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^Clash \(Conflicted copy .+\)\.md$/);
    expect(files[copies[0] ?? ""]).toBe("intro\nthe line as B wrote it\noutro\n");
  });

  it("[AC-13] changes to one attachment keep the newest at the path and the other as a conflict copy", async function () {
    await use(a);
    await writeBinary("Picture.png", 200_000, 0x1111);
    await converged(a, b);
    await goOffline(b);
    await use(a);
    const fromA = await writeBinary("Picture.png", 210_000, 0x2222);
    await waitForServer(a, (heads) => heads["Picture.png"] === fromA, "A's change");
    // B's change is made after A's reached the server, so B's is the newest.
    await use(b);
    const fromB = await writeBinary("Picture.png", 220_000, 0x3333);
    await goOnline(b, remoteVaultName);

    const files = await waitForCopies(2);
    expect(files["Picture.png"]).toBe(fromB);
    const copies = conflictCopies(files).filter((path) => path.startsWith("Picture ("));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^Picture \(Conflicted copy .+\)\.png$/);
    expect(files[copies[0] ?? ""]).toBe(fromA);
  });

  it("[AC-14] a delete on A while B edits the note: the edit wins on both devices", async function () {
    await shared("Doomed.md", "keep me?\n");
    await goOffline(b);
    await use(a);
    await deletePath("Doomed.md");
    await waitForServer(a, (heads) => !("Doomed.md" in heads), "A's delete");
    await use(b);
    await writeNote("Doomed.md", "keep me?\nB's edit\n");
    await goOnline(b, remoteVaultName);

    await waitForText(a, "Doomed.md", "keep me?\nB's edit\n");
    const files = await converged(a, b);
    expect(files["Doomed.md"]).toBe("keep me?\nB's edit\n");
  });

  it("[AC-15] a rename on A while B edits the note: the note is at the new name with B's edit on both devices", async function () {
    await shared("Old name.md", "the note\n");
    await goOffline(b);
    await use(a);
    await renamePath("Old name.md", "New name.md");
    await waitForServer(a, (heads) => "New name.md" in heads && !("Old name.md" in heads), "A's rename");
    await use(b);
    await writeNote("Old name.md", "the note\nB's edit\n");
    await goOnline(b, remoteVaultName);

    await waitForText(a, "New name.md", "the note\nB's edit\n");
    const files = await converged(a, b);
    expect(files["New name.md"]).toBe("the note\nB's edit\n");
    expect(files["Old name.md"]).toBeUndefined();
  });

  it("[AC-16] a note created at the same path on both devices: one note for the same content, one note plus one conflict copy otherwise", async function () {
    const copiesBefore = conflictCopies(await converged(a, b)).length;
    await goOffline(b);
    await use(a);
    await writeNote("Same.md", "the same text\n");
    await writeNote("Different.md", "A's text\n");
    await waitForServer(a, (heads) => heads["Same.md"] === contentOf("the same text\n") && heads["Different.md"] === contentOf("A's text\n"), "A's notes");
    await use(b);
    await writeNote("Same.md", "the same text\n");
    await writeNote("Different.md", "B's text\n");
    await goOnline(b, remoteVaultName);

    const files = await waitForCopies(copiesBefore + 1);
    expect(files["Same.md"]).toBe("the same text\n");
    expect(conflictCopies(files).filter((path) => path.startsWith("Same ("))).toEqual([]);
    expect(files["Different.md"]).toBe("A's text\n");
    const copies = conflictCopies(files).filter((path) => path.startsWith("Different ("));
    expect(copies).toHaveLength(1);
    expect(files[copies[0] ?? ""]).toBe("B's text\n");
  });

  /** Waits until both devices converged with `count` conflict copies in all, and returns their files. */
  async function waitForCopies(count: number): Promise<Record<string, string>> {
    let files: Record<string, string> = {};
    await browser.waitUntil(
      async () => {
        files = await converged(a, b);
        return conflictCopies(files).length >= count;
      },
      { timeoutMsg: `the devices never held ${String(count)} conflict copies` },
    );
    return files;
  }
});
