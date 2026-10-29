import { describe, expect, it } from "vitest";

import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

/**
 * The decision table of docs/design/engine.md §5, run exhaustively: every
 * local state × remote revision kind × file kind × occupancy of the path the
 * revision puts the document at × which side changed last × which device
 * commits first.
 *
 * Device A makes the remote change and B the local one. When A commits
 * first, B meets A's revision in its pull and resolves it by the table, and
 * the test checks the files the row decides. When B commits first, A is the
 * one whose commit is refused and resolves it. Either way, both devices must
 * then converge to the server's heads with every user edit in a file or a
 * conflict copy.
 */

type Local = "absent" | "clean" | "edited" | "edited-same-lines" | "deleted" | "renamed" | "renamed-edited";
type Remote = "edit" | "move" | "tombstone";
type Kind = "text" | "blob";
type Occupancy = "free" | "same-content" | "other-content" | "folder";
type Newer = "local" | "remote";
type First = "remote" | "local";

const locals: Local[] = ["absent", "clean", "edited", "edited-same-lines", "deleted", "renamed", "renamed-edited"];
const remotes: Remote[] = ["edit", "move", "tombstone"];
const kinds: Kind[] = ["text", "blob"];
const occupancies: Occupancy[] = ["free", "same-content", "other-content", "folder"];
const newers: Newer[] = ["local", "remote"];
const firsts: First[] = ["remote", "local"];

const BASE = "one\ntwo\nthree\n";
/** A's edit: the first line. */
const REMOTE = "ONE\ntwo\nthree\n";
/** B's edit of another line: merges with A's. */
const LOCAL = "one\ntwo\nTHREE\n";
/** B's edit of A's line: conflicts with it. */
const LOCAL_SAME = "uno\ntwo\nthree\n";
const MERGED = "ONE\ntwo\nTHREE\n";
const OCCUPANT = "an untracked file\n";
const INNER = "inside an untracked folder\n";

interface Case {
  local: Local;
  remote: Remote;
  kind: Kind;
  occupancy: Occupancy;
  newer: Newer;
  first: First;
}

interface Paths {
  /** The document's path on the server before either change. */
  base: string;
  /** B's rename target. */
  renamed: string;
  /** A's move target. */
  moved: string;
}

function paths(kind: Kind): Paths {
  const ext = kind === "text" ? "md" : "png";
  return { base: `notes/a.${ext}`, renamed: `notes/b.${ext}`, moved: `moved/a.${ext}` };
}

/** The content B's local change leaves in the file, or null if it leaves none. */
function localContent(local: Local): string | null {
  switch (local) {
    case "absent":
    case "deleted":
      return null;
    case "clean":
    case "renamed":
      return BASE;
    case "edited":
    case "renamed-edited":
      return LOCAL;
    case "edited-same-lines":
      return LOCAL_SAME;
  }
}

/** The content of A's revision. */
function remoteContent(remote: Remote): string | null {
  return remote === "edit" ? REMOTE : remote === "move" ? BASE : null;
}

/**
 * Where B must put the document for A's live revision when its file is not
 * there already (the path rule W applies to), or null when the revision
 * writes no new path on B.
 */
function writtenPath(testCase: Case): string | null {
  const { base, moved } = paths(testCase.kind);
  if (testCase.remote === "tombstone") return null;
  if (testCase.remote === "move") return moved;
  // An edit at the base path: only a document B does not hold there is written there.
  return testCase.local === "absent" ? base : null;
}

function cases(): Case[] {
  const all: Case[] = [];
  for (const local of locals) {
    for (const remote of remotes) {
      for (const kind of kinds) {
        for (const occupancy of occupancies) {
          if (occupancy !== "free" && writtenPath({ local, remote, kind, occupancy, newer: "local", first: "remote" }) === null) continue;
          for (const newer of newers) {
            for (const first of firsts) {
              // An absent document is one B never saw: B cannot commit before meeting it.
              if (local === "absent" && first === "local") continue;
              all.push({ local, remote, kind, occupancy, newer, first });
            }
          }
        }
      }
    }
  }
  return all;
}

/** A file the row leaves: the document's own file at an exact path, or a conflict copy of `copyOf` made by `device`. */
type Expected = { path: string; content: string } | { copyOf: string; folder?: string; device: string; content: string };

/**
 * The files every device holds once B resolved A's revision (A committed
 * first), as §5 decides them.
 */
function expectedFiles(testCase: Case): Expected[] {
  const { local, remote, kind, occupancy, newer } = testCase;
  const { base, renamed, moved } = paths(kind);
  const files: Expected[] = [];
  const copy = (of: string, content: string) => files.push({ copyOf: of, device: "device-b", content });
  const localText = localContent(local);
  const edited = local === "edited" || local === "edited-same-lines" || local === "renamed-edited";
  const renamedHere = local === "renamed" || local === "renamed-edited";

  if (remote === "tombstone") {
    // A2, A5, A11: the document is gone. A7, A10: the edit or rename wins at its path.
    if (edited || renamedHere) files.push({ path: renamedHere ? renamed : base, content: localText ?? "" });
    return files;
  }
  const target = writtenPath(testCase);
  if (target !== null) {
    if (occupancy === "other-content") copy(target, OCCUPANT);
    if (occupancy === "folder") files.push({ copyOf: target, folder: "inner.md", device: "device-b", content: INNER });
  }
  const remoteText = remoteContent(remote) ?? "";
  if (local === "absent" || local === "clean" || local === "deleted") {
    // A1, A3, A4, A8.
    files.push({ path: remote === "move" ? moved : base, content: remoteText });
    return files;
  }
  // A6, A9: A's move wins over B's path; B's rename stays when A kept the base path.
  const path = remote === "move" ? moved : renamedHere ? renamed : base;
  if (!edited || remote === "move") {
    // Rule M: only one side changed the content.
    files.push({ path, content: edited ? (localText ?? "") : remoteText });
    return files;
  }
  // Rule M, both sides changed the content.
  const localEdit = localText ?? "";
  if (kind === "text") {
    if (local === "edited-same-lines") {
      files.push({ path, content: REMOTE });
      copy(path, localEdit);
    } else files.push({ path, content: MERGED });
  } else if (newer === "local") {
    files.push({ path, content: localEdit });
    copy(path, REMOTE);
  } else {
    files.push({ path, content: REMOTE });
    copy(path, localEdit);
  }
  return files;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matches(expected: Expected, path: string, content: string): boolean {
  if (expected.content !== content) return false;
  if ("path" in expected) return expected.path === path;
  const slash = expected.copyOf.lastIndexOf("/");
  const name = expected.copyOf.slice(slash + 1);
  const dot = expected.folder === undefined ? name.lastIndexOf(".") : -1;
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const suffix = ` \\(Conflicted copy ${escape(expected.device)} \\d{12}\\)(?: \\d+)?`;
  const tail = expected.folder === undefined ? "" : `/${escape(expected.folder)}`;
  return new RegExp(`^${escape(expected.copyOf.slice(0, slash + 1) + stem)}${suffix}${escape(ext)}${tail}$`, "u").test(path);
}

/** Asserts `files` are exactly `expected`, each matched once. */
function expectFiles(files: Record<string, string>, expected: Expected[]): void {
  const unmatched = [...expected];
  const extra: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const index = unmatched.findIndex((candidate) => matches(candidate, path, content));
    if (index === -1) extra.push(path);
    else unmatched.splice(index, 1);
  }
  expect({ files, extra, unmatched }).toEqual({ files, extra: [], unmatched: [] });
}

/** The edits a user made that must survive: whole files for blobs, the changed lines for text. */
function survivors(testCase: Case): string[] {
  const edits: string[] = [];
  const local = localContent(testCase.local);
  // A rename changes the path only (see A9 below).
  if (local !== null && local !== BASE) edits.push(local);
  // A move changes the path only; when both devices move a note, the server's path wins (A9).
  const remote = remoteContent(testCase.remote);
  if (remote !== null && remote !== BASE) edits.push(remote);
  if (testCase.occupancy === "other-content") edits.push(OCCUPANT);
  if (testCase.occupancy === "folder") edits.push(INNER);
  if (testCase.kind === "blob") return edits;
  // A merge keeps each side's changed line, not its whole text.
  return edits.flatMap((text) => (text === BASE ? [text] : text.split("\n").filter((line) => line !== "" && !BASE.split("\n").includes(line))));
}

async function run(testCase: Case): Promise<{ server: InMemoryServer; a: Device; b: Device; documentId: string }> {
  let clock = Date.UTC(2026, 9, 29, 12, 0);
  const tick = () => (clock += 60_000);
  const server = new InMemoryServer({ now: () => new Date(clock) });
  const a = new Device(server, "device-a", { now: () => clock }, { now: () => clock });
  const b = new Device(server, "device-b", { now: () => clock }, { now: () => clock });
  const { base, renamed, moved } = paths(testCase.kind);

  // B watches its vault from the start, so its renames are live events; nothing triggers its cycles but the test.
  void b.engine.start();
  await b.sync();
  await a.write(base, BASE);
  await a.sync();
  const created = server.head((await a.journal.load()).docs.values().next().value?.documentId ?? "");
  if (testCase.local !== "absent") await b.sync();

  const remoteChange = async () => {
    tick();
    // A's changes are found by its next detection: a move keeps the content, so it is a rename by hash.
    if (testCase.remote === "edit") await a.write(base, REMOTE);
    if (testCase.remote === "move") await a.vault.rename(base, moved);
    if (testCase.remote === "tombstone") await a.vault.delete(base);
    // The device that commits first commits as it changes the file, so the commit's create_time is the change's time.
    if (testCase.first === "remote") await a.sync();
  };
  const localChange = async () => {
    tick();
    switch (testCase.local) {
      case "absent":
      case "clean":
        break;
      case "edited":
        await b.write(base, LOCAL);
        break;
      case "edited-same-lines":
        await b.write(base, LOCAL_SAME);
        break;
      case "deleted":
        await b.vault.delete(base);
        break;
      case "renamed":
        await b.vault.rename(base, renamed);
        break;
      case "renamed-edited":
        await b.vault.rename(base, renamed);
        await b.write(renamed, LOCAL);
        break;
    }
    const target = writtenPath(testCase);
    if (target !== null) {
      if (testCase.occupancy === "same-content") await b.write(target, remoteContent(testCase.remote) ?? "");
      if (testCase.occupancy === "other-content") await b.write(target, OCCUPANT);
      if (testCase.occupancy === "folder") await b.write(`${target}/inner.md`, INNER);
    }
    b.engine.stop();
    if (testCase.first === "local") await b.sync();
  };
  if (testCase.newer === "remote") {
    await localChange();
    await remoteChange();
  } else {
    await remoteChange();
    await localChange();
  }

  tick();
  if (testCase.first === "remote") {
    // An absent document: B never saw its first revision.
    if (testCase.local === "absent" && created !== undefined) server.purge(created.id);
    await b.sync();
  } else await a.sync();
  for (let round = 0; round < 3; round++) {
    tick();
    await a.sync();
    await b.sync();
  }
  return { server, a, b, documentId: created?.documentId ?? "" };
}

function name(testCase: Case): string {
  return `${testCase.local} × ${testCase.remote} × ${testCase.kind} × ${testCase.occupancy} × ${testCase.newer} newer × ${testCase.first} first`;
}

describe("decision table (docs/design/engine.md §5)", () => {
  it.each(cases().map((testCase) => [name(testCase), testCase] as const))("%s", async (_name, testCase) => {
    const { server, a, b, documentId } = await run(testCase);
    const filesA = await a.files();
    const filesB = await b.files();
    // Convergence: both devices hold the server's heads, and nothing is left to push.
    expect(filesB).toEqual(filesA);
    expect(new Map(Object.entries(filesA))).toEqual(server.liveFiles());
    expect((await a.journal.load()).pending).toEqual([]);
    expect((await b.journal.load()).pending).toEqual([]);
    // No edit is lost: each is in a file or a conflict copy.
    const contents = Object.values(filesA);
    for (const edit of survivors(testCase)) expect(contents.some((content) => content.includes(edit)), `edit ${JSON.stringify(edit)} survives`).toBe(true);
    // The row's action, decided by the device that met the other's revision.
    if (testCase.first === "remote") {
      const expected = expectedFiles(testCase);
      expectFiles(filesB, expected);
      // The document keeps its identity wherever it ends up: a re-create or a moved file is the same document, not a new one.
      const live = server.liveDocuments();
      for (const file of expected) if ("path" in file) expect(live.get(file.path), file.path).toBe(documentId);
    }
  });
});
