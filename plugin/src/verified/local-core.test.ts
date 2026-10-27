// The engine's local-event and start-up-scan tests, run against the verified
// core compiled to JavaScript (#965, docs/design/verified-core.md §3.4). Each
// `describe` names the engine test file a scenario comes from and each `it`
// keeps that test's name. A scenario is replayed as user actions on a
// `CoreDevice` and asserted on the journal and the effects directly; what an
// engine test checks through a push or a pull is left to #949. The tests left
// out, and why, are listed in docs/design/verified-core.md §3.4.
import { describe, expect, it } from "vitest";

import { CoreDevice, type Document, synced } from "./local-core";

const sameFile = (path: string, seen: string) => ({
  spelling: path,
  seen,
  displaced: false,
  userSpelling: null,
});

/** Every answer of a local event or the scan only persists its journal (§3.3: no disk effect). */
function expectOnlyPersists(device: CoreDevice): void {
  expect(device.answers.length).toBeGreaterThan(0);
  for (const answer of device.answers)
    expect(answer.effects).toEqual([
      { kind: "persist-journal", journal: answer.journal },
    ]);
}

function userDeleted(
  device: CoreDevice,
  id: string,
  path: string,
  content: string,
): void {
  const row: Document = device.row(id);
  expect(row.binding).toBeNull();
  expect(row.absence).toBe("user-deleted");
  expect(row.outbox).toMatchObject({
    path,
    content,
    deleted: true,
    sealed: false,
  });
}

function synchedA(platform: "posix" | "windows" = "posix"): CoreDevice {
  return new CoreDevice(platform, { A: synced("A", "a.md", "a1") });
}

describe("bindings.test.ts: Bindings", () => {
  it("moves the binding with a user's rename before any push (E1)", () => {
    const device = synchedA();

    device.rename("a.md", "b.md");

    expect(device.row("A").binding).toEqual(sameFile("b.md", "a1"));
    expect(device.row("A").outbox).toMatchObject({
      baseRev: "A@1",
      path: "b.md",
      content: "a1",
      deleted: false,
    });
    expectOnlyPersists(device);
  });

  // Ported without its last step: the acknowledgement needs a push (#949).
  it("follows a rename chain and keeps the binding when the commit is acknowledged", () => {
    const device = synchedA();

    device.rename("a.md", "b.md");
    device.rename("b.md", "c.md");

    expect(device.row("A").binding?.spelling).toBe("c.md");
    expect(device.row("A").outbox).toMatchObject({
      path: "c.md",
      content: "a1",
      deleted: false,
    });
  });

  it("moves the binding with a case-only rename on Windows, where the file key decides (E1)", () => {
    const device = synchedA("windows");

    device.rename("a.md", "A.md");

    expect(device.row("A").binding?.spelling).toBe("A.md");
    expect(device.row("A").absence).not.toBe("user-deleted");
  });

  it("leaves the document user-deleted when the user deletes its file (E3)", () => {
    const device = synchedA();

    device.delete("a.md");

    userDeleted(device, "A", "a.md", "a1");
    expectOnlyPersists(device);
  });

  it("binds no document to a file created where a deleted one was (E3 then E5)", () => {
    const device = synchedA();

    device.delete("a.md");
    device.write("a.md", "new");

    userDeleted(device, "A", "a.md", "a1");
  });

  it("changes no binding for the rename of an untracked file (E2)", () => {
    const device = synchedA();
    const before = structuredClone(device.journal);

    device.write("x.md", "x");
    device.rename("x.md", "y.md");

    expect(device.journal).toEqual(before);
    expectOnlyPersists(device);
  });

  it("finds a file deleted while the app was not running at start-up (E7)", () => {
    const device = synchedA();

    device.delete("a.md", { lost: true });
    device.scan();

    userDeleted(device, "A", "a.md", "a1");
    expectOnlyPersists(device);
  });

  // Adapted (#802's rule replaced): the engine test expects the binding to
  // take the new spelling and drop `displaced`. The core's scan compares
  // names under the platform's file key (§3.3), so on Windows the listed
  // A.md is the bound file itself: nothing changed, nothing to send.
  it("finds at start-up a user's case-only rename of a file the engine moved aside, which is the user's move then (#802)", () => {
    const row = synced("A", "a.md", "a1");
    const device = new CoreDevice("windows", {
      A: {
        ...row,
        binding: row.binding && { ...row.binding, displaced: true },
      },
    });

    device.rename("a.md", "A.md", { lost: true });
    device.scan();

    expect(device.row("A").binding).toEqual({
      spelling: "a.md",
      seen: "a1",
      displaced: true,
      userSpelling: null,
    });
    expect(device.row("A").outbox).toBeNull();
  });

  it("keeps at start-up the record that the engine moved a file it finds where it left it (#802)", () => {
    const row = synced("A", "a.md", "a1");
    const device = new CoreDevice("windows", {
      A: {
        ...row,
        binding: row.binding && { ...row.binding, displaced: true },
      },
    });

    device.scan();

    expect(device.row("A").binding?.displaced).toBe(true);
    expect(device.row("A").outbox).toBeNull();
  });
});

describe("bindings.test.ts: Bindings rules", () => {
  it("unbinds a stale binding at a rename's target, whose file the rename could not have moved onto", () => {
    const device = new CoreDevice("posix", {
      A: synced("A", "a.md", "a1"),
      Z: synced("Z", "b.md", "z1"),
    });

    device.rename("a.md", "b.md");

    expect(device.row("A").binding?.spelling).toBe("b.md");
    userDeleted(device, "Z", "b.md", "z1");
  });

  it("writes every row the start-up scan changes in one journal transaction (E7, §4.3)", () => {
    const device = new CoreDevice("posix", {
      A: synced("A", "a.md", "a1"),
      B: synced("B", "b.md", "b1"),
    });

    device.delete("a.md", { lost: true });
    device.delete("b.md", { lost: true });
    device.scan();

    // One answer, one PersistJournal effect carrying both rows.
    expect(device.answers).toHaveLength(1);
    expectOnlyPersists(device);
    userDeleted(device, "A", "a.md", "a1");
    userDeleted(device, "B", "b.md", "b1");
  });
});

describe("bindings.test.ts: the start-up content match (E7, decision 4)", () => {
  it("transfers the binding of a missing file to the one untracked file with its content, and pushes a rename", () => {
    const device = synchedA();

    device.rename("a.md", "b.md", { lost: true });
    device.scan();

    expect(device.row("A").binding).toEqual(sameFile("b.md", "a1"));
    expect(device.row("A").outbox).toMatchObject({
      path: "b.md",
      content: "a1",
      deleted: false,
    });
  });

  it("transfers no binding when two untracked files hold the missing file's content (delete plus create)", () => {
    const device = synchedA();

    device.rename("a.md", "b.md", { lost: true });
    device.write("c.md", "a1", { lost: true });
    device.scan();

    userDeleted(device, "A", "a.md", "a1");
  });

  it("transfers no binding when two missing files had the untracked file's content", () => {
    const device = new CoreDevice("posix", {
      A: synced("A", "a.md", "same"),
      B: synced("B", "b.md", "same"),
    });

    device.rename("a.md", "c.md", { lost: true });
    device.delete("b.md", { lost: true });
    device.scan();

    userDeleted(device, "A", "a.md", "same");
    userDeleted(device, "B", "b.md", "same");
  });

  it("transfers no binding to a file whose content changed after the rename", () => {
    const device = synchedA();

    device.rename("a.md", "b.md", { lost: true });
    device.write("b.md", "a2", { lost: true });
    device.scan();

    userDeleted(device, "A", "a.md", "a1");
  });

  it("keeps a bound file that still holds its own content, even when it equals a missing file's (E7b)", () => {
    const device = new CoreDevice("posix", {
      N: synced("N", "note.md", "same"),
      O: synced("O", "other.md", "same"),
    });

    device.delete("note.md", { lost: true });
    device.scan();

    userDeleted(device, "N", "note.md", "same");
    expect(device.row("O").binding).toEqual(sameFile("other.md", "same"));
    expect(device.row("O").outbox).toBeNull();
  });

  it("keeps the bindings when only one of two files holds the other's content (an edit, not a swap)", () => {
    const device = new CoreDevice("posix", {
      A: synced("A", "a.md", "a1"),
      B: synced("B", "b.md", "b1"),
    });

    device.write("a.md", "b1", { lost: true });
    device.scan();

    expect(device.row("A").binding).toEqual(sameFile("a.md", "b1"));
    expect(device.row("A").outbox).toMatchObject({
      path: "a.md",
      content: "b1",
      deleted: false,
    });
    expect(device.row("B").binding).toEqual(sameFile("b.md", "b1"));
    expect(device.row("B").outbox).toBeNull();
  });
});

describe("bindings.test.ts: the start-up content match races with events (E7, decision 4)", () => {
  // The core takes the scan as one step with its listing; events the vault
  // reports while the shell lists the disk reach the core after it.
  it("keeps the binding the scan matched when the delete and rename it saw arrive as events while it runs (E7b)", () => {
    const device = new CoreDevice("posix", {
      N: synced("N", "note.md", "note"),
      O: synced("O", "moved.md", "other"),
    });

    device.scan();
    device.delete("moved.md");
    device.rename("note.md", "moved.md");

    expect(device.row("N").binding).toEqual(sameFile("moved.md", "note"));
    userDeleted(device, "O", "moved.md", "other");
  });

  it("keeps the bindings the scan matched when a rename chain's events arrive while it runs", () => {
    const device = new CoreDevice("posix", {
      A: synced("A", "a.md", "a1"),
      B: synced("B", "b.md", "b1"),
    });

    device.scan();
    device.rename("b.md", "c.md");
    device.rename("a.md", "b.md");

    expect(device.row("A").binding).toEqual(sameFile("b.md", "a1"));
    expect(device.row("B").binding).toEqual(sameFile("c.md", "b1"));
  });

  it("unbinds the matched document when the user deletes its new file while the scan runs", () => {
    const device = synchedA();

    device.rename("a.md", "b.md", { lost: true });
    device.scan();
    device.delete("b.md");

    userDeleted(device, "A", "b.md", "a1");
  });
});

describe("scan-race.test.ts: a rename while the start-up scan runs", () => {
  it("does not bind a document whose file was deleted to a new file moved from its path", () => {
    const device = synchedA();
    device.delete("a.md", { lost: true });

    device.scan();
    device.write("a.md", "new");
    device.rename("a.md", "b.md");

    userDeleted(device, "A", "a.md", "a1");
    expectOnlyPersists(device);
  });

  it("keeps the binding of a document whose own file it moves", () => {
    const device = synchedA();

    device.scan();
    device.rename("a.md", "b.md");

    expect(device.row("A").binding).toEqual(sameFile("b.md", "a1"));
  });

  // Adapted: the engine test expects `seen` to stay a1 because its scan
  // reads the file after the event; the core's scan reads the listing first,
  // so it records the offline edit, and the outbox sends it (the engine
  // test's push result).
  it("keeps the binding of a document edited while the app was closed whose file it moves", () => {
    const device = synchedA();
    device.write("a.md", "a2", { lost: true });

    device.scan();
    device.rename("a.md", "b.md");

    expect(device.row("A").binding?.spelling).toBe("b.md");
    expect(device.row("A").outbox).toMatchObject({
      path: "b.md",
      content: "a2",
      deleted: false,
    });
  });

  it("does not bind a document whose file was deleted to an untracked file moved through its path", () => {
    const device = synchedA();
    device.delete("a.md", { lost: true });
    device.write("x.md", "x", { lost: true });

    device.scan();
    device.rename("x.md", "a.md");
    device.rename("a.md", "b.md");

    userDeleted(device, "A", "a.md", "a1");
  });

  it("keeps the binding of a document whose own file it moves through a temporary name", () => {
    const device = synchedA();

    device.scan();
    device.rename("a.md", "t.md");
    device.rename("t.md", "b.md");

    expect(device.row("A").binding).toEqual(sameFile("b.md", "a1"));
    expect(device.row("A").absence).not.toBe("user-deleted");
  });

  it("keeps each document's own file when the user swaps two files through a temporary name while the scan runs", () => {
    const device = new CoreDevice("posix", {
      A: synced("A", "a.md", "a1"),
      B: synced("B", "b.md", "b1"),
    });

    device.scan();
    device.rename("a.md", "t.md");
    device.rename("b.md", "a.md");
    device.rename("t.md", "b.md");

    expect(device.row("A").binding).toEqual(sameFile("b.md", "a1"));
    expect(device.row("B").binding).toEqual(sameFile("a.md", "b1"));
  });
});
