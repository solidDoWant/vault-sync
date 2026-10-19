import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import type { PathProblem } from "../vaultpath/vaultpath";
import type { PushSummary } from "./engine";
import { files, harness, type Harness } from "./testing";

// Local files whose paths the server refuses (#100, SPEC.md §6.2): the
// engine checks every path rule of the server's before it sends anything, so
// such a file is never uploaded or committed, push after push. Its operation
// stays recorded in the journal and every push reports it, with the path and
// the reason, until the user renames or removes the file. Nothing of it is
// lost (SPEC.md §2, principle 1).

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

/** Records the method of every call the engine makes to the server. */
function recordCalls(h: Harness): string[] {
  const calls: string[] = [];
  h.server.interceptor = (method) => {
    calls.push(method);
  };
  return calls;
}

const uploadsOrCommits = (calls: string[]) => calls.filter((method) => method !== "ListChanges" && method !== "GetRevision" && method !== "DownloadBlob");

const reported = (summary: PushSummary) => summary.rejected.map(({ operation, reason }) => ({ path: operation.path, reason }));

/** U+1D160 decomposes into three 4-byte code points, so 63 of them (252 bytes, a legal name) have a 756-byte path key. */
const growingName = "\u{1d160}".repeat(63);
/** 11 such folders and a name: 2,830 bytes on disk (a legal POSIX path), but 8,462 bytes once normalized. */
const normalizedTooLong = `${Array.from({ length: 11 }, () => growingName).join("/")}/${"\u{1d160}".repeat(11)}.md`;

const unsyncable: [string, string, PathProblem][] = [
  ["a control character", "notes/line\nbreak.md", "invalid-character"],
  ["a segment of dots", "notes/.../a.md", "not-vault-relative"],
  ["a normalized path over 8192 bytes", normalizedTooLong, "too-long-normalized"],
];

describe("SyncEngine with local files whose paths the server refuses (#100)", () => {
  it.each(unsyncable)("never uploads or commits a file whose path has %s, and reports it with the reason on every push", async (_, path, reason) => {
    const h = harness({ merge: "default" });
    await h.vault.write(path, bytes("mine\n"));
    const calls = recordCalls(h);

    const first = await h.engine.push();
    const second = await h.engine.push();
    h.restart();
    const third = await h.engine.push();

    expect(uploadsOrCommits(calls)).toEqual([]);
    for (const summary of [first, second, third]) {
      expect(summary.committed).toBe(0);
      expect(reported(summary)).toEqual([{ path, reason }]);
      expect(summary.rejected.map(({ error }) => error.code)).toEqual([Code.InvalidArgument]);
    }
    // Recorded, once: one pending create, never a new one per push.
    expect((await h.journal.listPending()).map((operation) => operation.path)).toEqual([path]);
    expect(h.server.liveFiles()).toEqual(new Map());
    expect(await files(h.vault)).toEqual(new Map([[path, "mine\n"]]));
  });

  it("syncs the file once the user renames it to a valid path", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("notes/line\nbreak.md", bytes("mine\n"));
    expect(reported(await h.engine.push())).toEqual([{ path: "notes/line\nbreak.md", reason: "invalid-character" }]);

    await h.vault.rename("notes/line\nbreak.md", "notes/line break.md");
    const summary = await h.engine.push();

    expect(summary).toMatchObject({ committed: 1, rejected: [], pending: 0 });
    expect(h.server.liveFiles()).toEqual(new Map([["notes/line break.md", "mine\n"]]));
    expect(await h.engine.push()).toMatchObject({ committed: 0, rejected: [], pending: 0 });
  });

  it("syncs the file once the user renames it to a valid path while the app is closed", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write(normalizedTooLong, bytes("mine\n"));
    expect(reported(await h.engine.push())).toEqual([{ path: normalizedTooLong, reason: "too-long-normalized" }]);
    h.engine.dispose();

    await h.vault.rename(normalizedTooLong, "short.md");
    h.restart();
    const summary = await h.engine.push();

    expect(summary).toMatchObject({ committed: 1, rejected: [], pending: 0 });
    expect(h.server.liveFiles()).toEqual(new Map([["short.md", "mine\n"]]));
  });

  it("stops reporting the file once the user removes it, and commits nothing for it", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("notes/.../a.md", bytes("mine\n"));
    expect(reported(await h.engine.push())).toHaveLength(1);
    const calls = recordCalls(h);

    await h.vault.delete("notes/.../a.md");
    const summary = await h.engine.push();

    expect(summary).toMatchObject({ committed: 0, rejected: [], pending: 0 });
    expect(uploadsOrCommits(calls)).toEqual([]);
    expect(h.server.liveFiles()).toEqual(new Map());
  });

  it("keeps a synced document the user moved to a refused path on the server, and syncs the file once moved on to a valid path", async () => {
    const h = harness({ merge: "default" });
    h.server.commit({ documentId: "doc", path: "a.md", content: "kept\n" });
    await h.engine.pull();
    await h.vault.write("a.md", bytes("edited\n"));
    await h.vault.rename("a.md", "tab\there.md");
    const calls = recordCalls(h);

    const refused = await h.engine.push();

    expect(uploadsOrCommits(calls)).toEqual([]);
    expect(reported(refused)).toEqual([{ path: "tab\there.md", reason: "invalid-character" }]);
    // Never a delete of the document for having left a.md.
    expect(h.server.liveDocuments()).toEqual(new Map([["a.md", "doc"]]));

    await h.vault.rename("tab\there.md", "tab here.md");
    const summary = await h.engine.push();

    expect(summary).toMatchObject({ rejected: [], pending: 0 });
    expect(await h.engine.push()).toMatchObject({ committed: 0, rejected: [], pending: 0 });
    expect(h.server.liveFiles()).toEqual(new Map([["tab here.md", "edited\n"]]));
    expect(await files(h.vault)).toEqual(new Map([["tab here.md", "edited\n"]]));
  });

  it("reports a commit the server refuses as invalid for a reason the engine did not foresee, with the server's refusal", async () => {
    const h = harness({ merge: "default" });
    await h.vault.write("a.md", bytes("mine\n"));
    h.server.interceptor = (method) => {
      if (method === "CommitRevision") throw new ConnectError("refused for another reason", Code.InvalidArgument);
    };

    const summary = await h.engine.push();

    expect(summary.rejected.map(({ operation, reason, error }) => ({ path: operation.path, reason, message: error.rawMessage }))).toEqual([
      { path: "a.md", reason: "refused", message: "refused for another reason" },
    ]);
    expect(await h.journal.listPending()).toHaveLength(1);
  });
});
