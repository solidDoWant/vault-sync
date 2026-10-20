import { describe, expect, it } from "vitest";

import type { PathPlatform } from "../vaultpath/platform";
import { InMemoryVault } from "../vault/memory";
import { copyOf, files, harness, type Harness } from "./testing";

// A remote rename that moves a note into a folder whose spelling has the
// same path key as the note's folder (`straße/` to `STRASSE/`) meets a local
// edit of the note. Path keys fold `ß`/`SS`, and NFC/NFD on Windows, which
// NTFS and APFS do not (decision #52), so on such a filesystem the remote
// spelling names no file, and the edited note is still at its synced path.
// The edit is the note's local version and is merged into the note, never
// taken for a delete that leaves it behind as an untracked file (#447,
// SPEC.md §2 principle 1, §7). The simulation's vault cannot hold two such
// spellings as two files (#396), so this is a scripted regression: an exact
// vault (every spelling apart) stands in for the filesystem where the
// platform does not fold the pair, and the platform's own folding vault
// where it does.

const bytes = (value: string) => new TextEncoder().encode(value);
const nfc = (value: string) => value.normalize("NFC");
const nfd = (value: string) => value.normalize("NFD");

interface Respelling {
  platform: PathPlatform;
  from: string;
  to: string;
  /**
   * The vault: "exact" holds every spelling apart, as the platform's
   * filesystem holds this pair; "folding" folds by the full path key, as the
   * filesystem folds a case pair and as the simulation's vault folds every
   * pair (#396), which must keep converging too.
   */
  vault: "exact" | "folding";
}

const respellings: Respelling[] = [
  { platform: "windows", from: "straße/b.md", to: "STRASSE/b.md", vault: "exact" },
  { platform: "windows", from: nfc("café/b.md"), to: nfd("café/b.md"), vault: "exact" },
  { platform: "windows", from: "notes/b.md", to: "NOTES/b.md", vault: "folding" },
  { platform: "windows", from: "straße/b.md", to: "STRASSE/b.md", vault: "folding" },
  { platform: "windows", from: nfc("café/b.md"), to: nfd("café/b.md"), vault: "folding" },
  { platform: "macos", from: "straße/b.md", to: "STRASSE/b.md", vault: "exact" },
  { platform: "macos", from: nfc("café/b.md"), to: nfd("café/b.md"), vault: "folding" },
  { platform: "macos", from: "notes/b.md", to: "NOTES/b.md", vault: "folding" },
  { platform: "macos", from: "straße/b.md", to: "STRASSE/b.md", vault: "folding" },
  { platform: "posix", from: "straße/b.md", to: "STRASSE/b.md", vault: "exact" },
  { platform: "posix", from: "notes/b.md", to: "NOTES/b.md", vault: "exact" },
];

function deviceVault({ platform, vault }: Respelling): Harness {
  return harness({ merge: "default", pathRules: { platform }, vault: vault === "folding" ? new InMemoryVault({ pathRules: { platform } }) : new InMemoryVault() });
}

async function pushRounds(h: Harness): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await h.engine.push();
    await h.engine.settled();
  }
}

describe.each(respellings)("a remote rename of $from to $to on $platform, $vault vault (#447)", (respelling) => {
  const { from, to } = respelling;

  it("merges a local edit of the note into the renamed note and leaves no untracked copy", async () => {
    const h = deviceVault(respelling);
    h.server.commit({ documentId: "note", path: from, content: "a\nb\nc\n" });
    await h.engine.pull();
    await h.vault.write(from, bytes("local\na\nb\nc\n"));
    await h.engine.settled();
    h.server.commit({ documentId: "note", path: to, content: "a\nb\nc\nremote\n" });

    await h.engine.pull();
    expect(await files(h.vault)).toEqual(new Map([[to, "local\na\nb\nc\nremote\n"]]));
    expect(await h.journal.listDeferred()).toEqual([]);
    await pushRounds(h);

    expect(h.server.liveDocuments()).toEqual(new Map([[to, "note"]]));
    expect(h.server.liveFiles()).toEqual(new Map([[to, "local\na\nb\nc\nremote\n"]]));
    expect(h.server.history("note").map((revision) => revision.deleted)).not.toContain(true);
    expect(await files(h.vault)).toEqual(h.server.liveFiles());
    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.listDeferred()).toEqual([]);
  });

  it("moves a note the user did not edit to the remote spelling", async () => {
    const h = deviceVault(respelling);
    h.server.commit({ documentId: "note", path: from, content: "a\n" });
    await h.engine.pull();
    h.server.commit({ documentId: "note", path: to, content: "a\n" });

    await h.engine.pull();
    await pushRounds(h);

    expect(h.server.liveDocuments()).toEqual(new Map([[to, "note"]]));
    expect(h.server.history("note")).toHaveLength(2);
    expect(await files(h.vault)).toEqual(new Map([[to, "a\n"]]));
    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.listDeferred()).toEqual([]);
  });

  it.runIf(respelling.vault === "exact")("never takes another file at the remote spelling for the note's local version", async () => {
    const h = deviceVault(respelling);
    h.server.commit({ documentId: "note", path: from, content: "a\n" });
    await h.engine.pull();
    await h.vault.write(to, bytes("other\n"));
    await h.engine.settled();
    h.server.commit({ documentId: "note", path: to, content: "a\nremote\n" });

    await h.engine.pull();
    // The other file was created concurrently with the note's move to its
    // path, so it is kept as a conflict copy and the note takes the path.
    const copy = copyOf(to.slice(0, -".md".length), ".md");
    const expected = new Map([
      [to, "a\nremote\n"],
      [copy, "other\n"],
    ]);
    expect(await files(h.vault)).toEqual(expected);
    expect(await h.journal.listDeferred()).toEqual([]);
    await pushRounds(h);

    expect(h.server.liveDocuments().get(to)).toBe("note");
    expect(h.server.liveFiles()).toEqual(expected);
    expect(await files(h.vault)).toEqual(expected);
    expect(await h.journal.listPending()).toEqual([]);
    expect(await h.journal.listDeferred()).toEqual([]);
  });
});
