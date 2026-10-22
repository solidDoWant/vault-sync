import { describe, expect, it } from "vitest";

import { files, harness } from "./testing";

// #795 (sim seed-5-retention): a document whose file the user moved before
// another device deleted it is brought back on its tombstone at the moved
// spelling, bound to that file (PO-7, PO-9). When another device brings it
// back too, the pulled revision meets that file as a local change (design
// §4.5 step 4, boundLocalChange, #798): the merge keeps the bound file the
// document's (PO-1, INV-3) at the user's spelling, since the user's rename
// wins over the re-create as over any remote revision (PO-9; amended ruling
// on decision #52, #802), and a local edit is kept in a conflict copy
// written as a new file; a file only moved has no edit to keep. The seed's
// shape: the file was moved into a folder (`Notes/C.md`) that the path it
// comes back at (`NOTES`) collides with under the server's key; the user's
// path wins, so the folder stays and nothing lands at `NOTES`.

const bytes = (content: string) => new TextEncoder().encode(content);
const quiet = { committed: 0, conflicts: 0, pending: 0, rejected: [] };

describe("SyncEngine, given a moved note another device deleted and then brought back elsewhere", () => {
  it.each([
    [
      "into a folder of the path it comes back at",
      "Notes/C.md",
      "NOTES",
      false,
    ],
    [
      "into a folder of the path it comes back at, edited",
      "Notes/C.md",
      "NOTES",
      true,
    ],
    [
      "to a path clear of the one it comes back at",
      "moved.md",
      "back.md",
      false,
    ],
    [
      "to a path clear of the one it comes back at, edited",
      "moved.md",
      "back.md",
      true,
    ],
  ] as const)(
    "keeps the moved file the document's, at the user's path with the server's content, with any local edit in a new copy (%s)",
    async (_variant, moved, back, edited) => {
      const h = harness({ merge: "default", maxDownloadBytes: 1000 });
      h.server.commit({ documentId: "d", path: "ab.md", content: "c\n" });
      await h.engine.pull();
      await h.vault.rename("ab.md", moved);
      const mine = edited ? "c\nmine\n" : "c\n";
      if (edited) await h.vault.write(moved, bytes(mine));
      await h.engine.settled();
      const inode = h.vault.inodeOf(moved);
      expect(inode).toBeDefined();
      h.server.commit({ documentId: "d", path: "ab.md", deleted: true });
      h.server.commit({ documentId: "d", path: back, content: "other\n" });

      for (let round = 0; round < 3; round++) {
        await h.engine.pull();
        await h.engine.push();
      }

      // The document keeps its file at the user's path (#802), with the
      // server's content; nothing is left at the path it came back at.
      expect(h.server.liveDocuments().get(moved)).toBe("d");
      expect(h.server.liveFiles().get(moved)).toBe("other\n");
      expect(h.vault.inodeOf(moved)).toBe(inode);
      expect(h.server.liveDocuments().has(back)).toBe(false);
      const copies = [...h.server.liveFiles()].filter(
        ([path]) => path !== moved,
      );
      if (edited) {
        // The local edit survives in a conflict copy, a new file and a new document.
        expect(copies.map(([, content]) => content)).toEqual([mine]);
        const [copyPath] = copies[0] ?? [""];
        expect(h.server.liveDocuments().get(copyPath)).not.toBe("d");
        expect(h.vault.inodeOf(copyPath)).not.toBe(inode);
        expect(
          h.server
            .history("d")
            .every(
              (revision) =>
                new TextDecoder().decode(revision.path) !== copyPath,
            ),
        ).toBe(true);
      } else {
        // Only moved: the content the tombstone deleted is in the document's
        // history, and no copy duplicates it as a new document.
        expect(copies).toEqual([]);
      }
      expect(await files(h.vault)).toEqual(h.server.liveFiles());
      expect(await h.engine.push()).toEqual(quiet);
    },
  );
});
