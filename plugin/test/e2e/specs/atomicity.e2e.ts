import { expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

import type { OpenIn } from "../harness/main";
import { callHarness } from "../obsidian";

// The Obsidian adapter's write is atomic with respect to the user's editor
// writing the same file (#543, SPEC.md §8). The engine writes a remote
// revision naming the content it checked (its precondition), and the adapter
// checks and writes inside one Vault.process, which on desktop holds the file
// adapter's queue from its read to its write. An editor's save that lands
// meanwhile must be queued behind the write, not overwritten by it.
//
// The harness (writeRemoteWithEditorWriteAtRead) makes the editor's write
// when the adapter reads the file the k-th time, for k = 1, 2, ... until the
// adapter reads it fewer than k times, so every read the adapter makes is a
// window the editor writes in, however many there are. After each, the
// editor's write must be on disk, and written last. Either the sync write
// went first and both are applied in that order, or the editor's write went
// first and the sync write was refused with "changed" (the engine then finds
// the editor's text as a local edit). A write that read the file, let the
// editor's write land, and then wrote over it fails.

const note = (...lines: string[]) => lines.map((line) => `${line}\n`).join("");
const canvas = (...texts: string[]) =>
  JSON.stringify({
    nodes: texts.map((text, index) => ({ id: `node${String(index)}`, type: "text", text, x: 0, y: index * 100, width: 200, height: 60 })),
    edges: [],
  });

const routes: { openIn: OpenIn; extension: string; base: string; remote: string; editor: string }[] = [
  { openIn: "nothing", extension: "md", base: note("# Note", "base"), remote: note("# Note", "remote"), editor: note("# Note", "editor") },
  { openIn: "markdown", extension: "md", base: note("# Note", "base"), remote: note("# Note", "remote"), editor: note("# Note", "editor") },
  { openIn: "canvas", extension: "canvas", base: canvas("base"), remote: canvas("base", "remote"), editor: canvas("base", "editor") },
];

describe("A sync write with the editor writing the same file during it", function () {
  before(async function () {
    // Not on Android: the harness counts the adapter's reads through
    // desktop's FileSystemAdapter (its internal fsPromises), and the order
    // it relies on is that adapter's single read/write queue. The Android
    // app's Capacitor adapter has neither, so this spec cannot interleave
    // the editor's write there; it needs an Android counterpart of its own.
    if ((await obsidianPage.getPlatform()).isAndroidApp) this.skip();
  });

  for (const route of routes) {
    it(`applies both in order and loses neither, with the file open in ${route.openIn} (#543)`, async function () {
      const outcomes: string[] = [];
      for (let read = 1; ; read++) {
        if (read > 8) throw new Error("the adapter read the file more than 8 times for one write");
        const path = `Atomic ${route.openIn} ${String(read)}.${route.extension}`;
        const result = await callHarness("writeRemoteWithEditorWriteAtRead", path, route.base, route.openIn, route.remote, route.editor, read);
        if (!result.interleaved) {
          // The adapter read the file fewer than `read` times: nothing was written meanwhile.
          expect({ outcome: result.outcome, writes: result.writes, disk: result.disk }).toEqual({ outcome: "ok", writes: [route.remote], disk: route.remote });
          break;
        }
        expect(result.editorOutcome).toBe("ok");
        if (result.outcome === "ok") {
          // The sync write first, then the editor's, queued behind it.
          expect({ read, writes: result.writes, disk: result.disk }).toEqual({ read, writes: [route.remote, route.editor], disk: route.editor });
        } else {
          // The editor's write first; the sync write found it and wrote nothing.
          expect({ read, outcome: result.outcome, writes: result.writes, disk: result.disk }).toEqual({ read, outcome: `VaultError: changed: ${path}`, writes: [route.editor], disk: route.editor });
        }
        outcomes.push(result.outcome);
      }
      // The editor wrote during at least one read, and at least once the
      // sync write still went through: the window between its check and its
      // write was exercised, not only the refusal before it.
      expect(outcomes).toContain("ok");
    });
  }
});
