import { describe, expect, it } from "vitest";

import type { DocumentState, PendingOperation } from "../journal/journal";
import { InMemoryVault } from "../vault/memory";
import { InMemoryServer } from "./memory-server";
import { files, harness, text, type Harness } from "./testing";

// #810 (follow-up to #800; INV-9, PO-12, design §4.6): the acknowledgement of
// a live revision of a `released` document forgets the document only when
// nothing else is left of it here. These pin when it must not: another
// outbox operation still to send, or a tombstone. Each runs at both places
// an acknowledgement happens: the commit's response, and a pull that finds
// the commit whose response was lost. A deferral of the document does not
// keep it: the only one that can exist then is stale (design §4.6).

const encoder = new TextEncoder();

function windows(): Harness {
  const server = new InMemoryServer({ maxPageSize: 2, maxDownloadBytes: 64 });
  return harness({
    merge: "default",
    server,
    vault: new InMemoryVault({ pathRules: { platform: "windows" } }),
    pathRules: { platform: "windows" },
  });
}

/**
 * A `released` document a, with `operations` in its outbox and no deferral:
 * the device released a's file for a rename it cannot hold, then a restore
 * kept a's base and lost the rename, dropping its deferral (as in #788, #800).
 */
async function releasedWithOutbox(
  operations: (state: DocumentState) => PendingOperation[],
): Promise<Harness> {
  const h = windows();
  h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
  await h.engine.pull();
  h.server.commit({ documentId: "a", path: "no:te.md" }); // 2: the device releases a's file
  await h.engine.pull();
  await h.engine.settled();
  const state = await h.journal.getDocument("a");
  if (state === undefined) throw new Error("a is not in the journal");
  expect(state).toMatchObject({ binding: null, absence: "released" });
  h.engine.dispose();
  for (const operation of operations(state))
    await h.journal.addPending(operation);
  h.restart();
  h.server.restoreTo(1n);
  await h.engine.pull();
  expect(await h.journal.getDeferred("a")).toBeUndefined();
  expect(await h.journal.getDocument("a")).toMatchObject({
    revisionId: state.revisionId,
    binding: null,
    absence: "released",
  });
  return h;
}

function operation(
  state: DocumentState,
  revisionId: string,
  baseRevisionId: string,
  path: string,
  deleted = false,
): PendingOperation {
  return {
    revisionId,
    documentId: "a",
    baseRevisionId,
    path,
    contentHash: state.baseHash,
    size: state.size,
    kind: "text",
    deleted,
  };
}

type Site = "commit response" | "pull after a lost response";
const sites: Site[] = ["commit response", "pull after a lost response"];

/** Pushes the outbox; at the pull site the first commit's response is lost and a pull finds it. */
async function acknowledge(h: Harness, site: Site): Promise<void> {
  if (site === "commit response") {
    await h.engine.push();
    await h.engine.settled();
  } else {
    let lose = true;
    h.server.responseInterceptor = (method) => {
      if (method !== "CommitRevision" || !lose) return;
      lose = false;
      throw new Error("response lost");
    };
    await h.engine.push().catch(() => undefined);
    await h.engine.settled();
    expect(lose).toBe(false);
    await h.engine.pull();
    await h.engine.settled();
  }
  // Whatever is left syncs on.
  await h.engine.push();
  await h.engine.pull();
  await h.engine.settled();
}

describe("acknowledging an operation of a released document", () => {
  it.each(sites)(
    "keeps the document while another operation is queued on top, so that one is sent and materialized too (%s)",
    async (site) => {
      const h = await releasedWithOutbox((state) => [
        operation(state, "rename-a", state.revisionId, "b.md"),
        operation(state, "rename-a-again", "rename-a", "c.md"),
      ]);

      await acknowledge(h, site);

      expect(await h.journal.listPending()).toEqual([]);
      expect(h.server.history("a").map((revision) => revision.id)).toEqual([
        "a@1",
        "rename-a",
        "rename-a-again",
      ]);
      expect(text(h.server.head("a")?.path ?? null)).toBe("c.md");
      expect(await files(h.vault)).toEqual(new Map([["c.md", "a1\n"]]));
      expect(await h.journal.getDocument("a")).toMatchObject({
        revisionId: "rename-a-again",
        binding: { spelling: "c.md" },
        absence: null,
      });
    },
  );

  it.each(sites)(
    "keeps the tombstone it acknowledges, so a file the user then creates at its path is a new document (%s)",
    async (site) => {
      const h = await releasedWithOutbox((state) => [
        operation(state, "delete-a", state.revisionId, "a.md", true),
      ]);

      await acknowledge(h, site);

      expect(await h.journal.listPending()).toEqual([]);
      expect(h.server.head("a")?.deleted).toBe(true);
      expect(await files(h.vault)).toEqual(new Map());
      // The user's delete stays theirs: the same content at the same path is a new file, not a's revival.
      await h.vault.write("a.md", encoder.encode("a1\n"));
      await h.engine.settled();
      await h.engine.push();
      expect(h.server.head("a")?.deleted).toBe(true);
      const live = [...h.server.liveDocuments()];
      expect(live.map(([path]) => path)).toEqual(["a.md"]);
      expect(live[0]?.[1]).not.toBe("a");
    },
  );

  // An injected state: no engine path records an operation on a revision it
  // deferred (operations are on the journal's base), and every other way to a
  // deferral at an acknowledgement is closed (design §4.6). It is the one
  // state in which a deferral meets an acknowledgement: a stale one, at or
  // before the acknowledged revision.
  it.each(sites)(
    "forgets the document past a stale deferral, so the acknowledged rename is materialized and nothing is left deferred (%s)",
    async (site) => {
      const h = harness({ merge: "default" });
      h.server.commit({ documentId: "a", path: "a.md", content: "a1\n" }); // 1
      await h.engine.pull();
      const invalid = h.server.commitRawPath(
        "a",
        new Uint8Array([0x61, 0xff, 0x2e, 0x6d, 0x64]),
        "a1\n",
      ); // 2
      await h.engine.pull();
      await h.engine.settled();
      expect(
        (await h.journal.listDeferred()).map((deferred) => [
          deferred.revision.revisionId,
          deferred.reason,
        ]),
      ).toEqual([[invalid.id, "invalid-path"]]);
      const state = await h.journal.getDocument("a");
      if (state === undefined) throw new Error("a is not in the journal");
      h.engine.dispose();
      await h.vault.delete("a.md");
      await h.journal.putDocument({
        ...state,
        binding: null,
        absence: "released",
      });
      await h.journal.addPending(
        operation(state, "rename-a", invalid.id, "b.md"),
      );
      h.restart();

      await acknowledge(h, site);

      expect(await h.journal.listPending()).toEqual([]);
      expect(text(h.server.head("a")?.path ?? null)).toBe("b.md");
      expect(await files(h.vault)).toEqual(new Map([["b.md", "a1\n"]]));
      expect(await h.journal.getDocument("a")).toMatchObject({
        revisionId: "rename-a",
        binding: { spelling: "b.md" },
        absence: null,
      });
      expect(await h.journal.listDeferred()).toEqual([]);
    },
  );
});
