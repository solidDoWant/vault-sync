import { sha256Hex } from "../hash";
import { isVaultError, type VaultAdapter, type VaultErrorCode, type VaultEvent } from "./adapter";

/**
 * Shared VaultAdapter conformance suite. It is framework-agnostic (no vitest
 * or Node imports) so the Obsidian adapter can run the same cases later, e.g.
 * under wdio/mocha inside Obsidian. Each case gets a fresh, empty vault from
 * the harness factory and throws on failure.
 */
export interface VaultAdapterHarness {
  adapter: VaultAdapter;
  /**
   * Renames a folder the way the user does, outside the adapter (VaultAdapter
   * models files only). The case that needs it fails without it.
   */
  renameFolder?: (from: string, to: string) => Promise<void>;
  /** Releases the vault after the case. */
  dispose?: () => Promise<void> | void;
}

export type VaultAdapterFactory = () => Promise<VaultAdapterHarness> | VaultAdapterHarness;

export interface ConformanceOptions {
  /**
   * How long to wait for asynchronously delivered events, and how long to
   * watch for events that must not arrive. Defaults to 1000 / 50 ms.
   */
  eventTimeoutMs?: number;
  quietPeriodMs?: number;
}

export interface ConformanceCase {
  name: string;
  run: (adapter: VaultAdapter, options: Required<ConformanceOptions>, harness: VaultAdapterHarness) => Promise<void>;
}

/** Runs one case against a fresh vault from `factory`, disposing it afterwards. */
export async function runConformanceCase(
  testCase: ConformanceCase,
  factory: VaultAdapterFactory,
  options: ConformanceOptions = {},
): Promise<void> {
  const harness = await factory();
  try {
    await testCase.run(
      harness.adapter,
      {
        eventTimeoutMs: options.eventTimeoutMs ?? 1000,
        quietPeriodMs: options.quietPeriodMs ?? 50,
      },
      harness,
    );
  } finally {
    await harness.dispose?.();
  }
}

export class ConformanceFailure extends Error {
  override readonly name = "ConformanceFailure";
}

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

function describe(value: unknown): string {
  if (value instanceof Uint8Array) return `Uint8Array[${Array.from(value).join(",")}]`;
  return JSON.stringify(value);
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (describe(actual) !== describe(expected)) {
    throw new ConformanceFailure(`${what}: expected ${describe(expected)}, got ${describe(actual)}`);
  }
}

async function assertRejects(promise: Promise<unknown>, code: VaultErrorCode, what: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (isVaultError(error, code)) return;
    throw new ConformanceFailure(`${what}: expected VaultError "${code}", got ${String(error)}`);
  }
  throw new ConformanceFailure(`${what}: expected VaultError "${code}", but it succeeded`);
}

async function sortedList(adapter: VaultAdapter): Promise<string[]> {
  return (await adapter.list()).sort();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Records events and waits for them to arrive. */
class EventRecorder {
  readonly events: VaultEvent[] = [];
  readonly stop: () => void;

  constructor(adapter: VaultAdapter) {
    this.stop = adapter.watch((event) => this.events.push(event));
  }

  async expect(expected: VaultEvent[], options: Required<ConformanceOptions>, what: string): Promise<void> {
    const deadline = Date.now() + options.eventTimeoutMs;
    while (this.events.length < expected.length && Date.now() < deadline) await sleep(5);
    await sleep(options.quietPeriodMs); // catch unexpected extra events
    assertEqual(this.events, expected, what);
  }

  /** As expect, in any order. */
  async expectUnordered(expected: VaultEvent[], options: Required<ConformanceOptions>, what: string): Promise<void> {
    const deadline = Date.now() + options.eventTimeoutMs;
    while (this.events.length < expected.length && Date.now() < deadline) await sleep(5);
    await sleep(options.quietPeriodMs);
    const sorted = (events: VaultEvent[]) => events.map((event) => JSON.stringify(event)).sort();
    assertEqual(sorted(this.events), sorted(expected), what);
  }
}

/** The cases. Order is irrelevant; every case starts from an empty vault. */
export const vaultAdapterConformance: readonly ConformanceCase[] = [
  {
    name: "a new vault is empty",
    run: async (adapter) => {
      assertEqual(await adapter.list(), [], "list()");
    },
  },
  {
    name: "write then read returns the same bytes",
    run: async (adapter) => {
      await adapter.write("note.md", bytes("hello"));
      assertEqual(await adapter.read("note.md"), bytes("hello"), "read()");
      assertEqual(await adapter.list(), ["note.md"], "list()");
    },
  },
  {
    name: "arbitrary binary content round-trips",
    run: async (adapter) => {
      const data = Uint8Array.from({ length: 512 }, (_, index) => index % 256);
      await adapter.write("image.png", data);
      assertEqual(await adapter.read("image.png"), data, "read()");
    },
  },
  {
    name: "empty files round-trip",
    run: async (adapter) => {
      await adapter.write("empty.md", new Uint8Array());
      assertEqual(await adapter.read("empty.md"), new Uint8Array(), "read()");
      assertEqual((await adapter.stat("empty.md"))?.size, 0, "stat().size");
    },
  },
  {
    name: "stored content is isolated from caller buffers",
    run: async (adapter) => {
      const input = bytes("abc");
      await adapter.write("note.md", input);
      input[0] = 0x7a;
      const first = await adapter.read("note.md");
      first[1] = 0x7a;
      assertEqual(await adapter.read("note.md"), bytes("abc"), "read() after mutating buffers");
    },
  },
  {
    name: "write overwrites an existing file",
    run: async (adapter) => {
      await adapter.write("note.md", bytes("first version"));
      await adapter.write("note.md", bytes("v2"));
      assertEqual(await adapter.read("note.md"), bytes("v2"), "read()");
      assertEqual((await adapter.stat("note.md"))?.size, 2, "stat().size");
      assertEqual(await adapter.list(), ["note.md"], "list()");
    },
  },
  {
    name: "write creates missing parent folders",
    run: async (adapter) => {
      await adapter.write("a/b/c/note.md", bytes("deep"));
      await adapter.write("a/other.md", bytes("shallow"));
      assertEqual(await sortedList(adapter), ["a/b/c/note.md", "a/other.md"], "list()");
      assertEqual(await adapter.read("a/b/c/note.md"), bytes("deep"), "read()");
    },
  },
  {
    name: "non-ASCII paths are preserved exactly",
    run: async (adapter) => {
      const path = "Café/日本語 \u{1f4dd}.md";
      await adapter.write(path, bytes("x"));
      assertEqual(await adapter.list(), [path], "list()");
      assertEqual(await adapter.read(path), bytes("x"), "read()");
    },
  },
  {
    name: "stat reports size and a numeric mtime",
    run: async (adapter) => {
      await adapter.write("note.md", bytes("12345"));
      const stat = await adapter.stat("note.md");
      if (stat === null) throw new ConformanceFailure("stat() returned null for an existing file");
      assertEqual(stat.size, 5, "stat().size");
      if (!Number.isFinite(stat.mtime)) throw new ConformanceFailure(`stat().mtime is not a number: ${String(stat.mtime)}`);
    },
  },
  {
    name: "operations on a missing file fail with not-found",
    run: async (adapter) => {
      await adapter.write("present.md", bytes("x"));
      await assertRejects(adapter.read("missing.md"), "not-found", "read()");
      await assertRejects(adapter.delete("missing.md"), "not-found", "delete()");
      await assertRejects(adapter.rename("missing.md", "elsewhere.md"), "not-found", "rename()");
      assertEqual(await adapter.stat("missing.md"), null, "stat()");
      assertEqual(await adapter.list(), ["present.md"], "list()");
    },
  },
  {
    name: "delete removes a file",
    run: async (adapter) => {
      await adapter.write("keep.md", bytes("k"));
      await adapter.write("gone.md", bytes("g"));
      await adapter.delete("gone.md");
      assertEqual(await adapter.list(), ["keep.md"], "list()");
      assertEqual(await adapter.stat("gone.md"), null, "stat()");
      await assertRejects(adapter.read("gone.md"), "not-found", "read()");
    },
  },
  {
    name: "rename moves content to the new path",
    run: async (adapter) => {
      await adapter.write("old.md", bytes("content"));
      await adapter.rename("old.md", "folder/new.md");
      assertEqual(await adapter.list(), ["folder/new.md"], "list()");
      assertEqual(await adapter.read("folder/new.md"), bytes("content"), "read() at new path");
      assertEqual(await adapter.stat("old.md"), null, "stat() at old path");
    },
  },
  {
    name: "rename that changes only letter case is allowed",
    run: async (adapter) => {
      await adapter.write("note.md", bytes("content"));
      await adapter.rename("note.md", "Note.md");
      assertEqual(await adapter.list(), ["Note.md"], "list()");
      assertEqual(await adapter.read("Note.md"), bytes("content"), "read()");
    },
  },
  {
    name: "rename onto an existing file fails and changes nothing",
    run: async (adapter) => {
      await adapter.write("a.md", bytes("a"));
      await adapter.write("b.md", bytes("b"));
      await assertRejects(adapter.rename("a.md", "b.md"), "already-exists", "rename()");
      assertEqual(await adapter.read("a.md"), bytes("a"), "read(a.md)");
      assertEqual(await adapter.read("b.md"), bytes("b"), "read(b.md)");
    },
  },
  {
    name: "a file cannot be written where a folder exists, or under a file",
    run: async (adapter) => {
      await adapter.write("a/b.md", bytes("x"));
      await adapter.write("file.md", bytes("y"));
      await assertRejects(adapter.write("a", bytes("z")), "path-conflict", "write() onto a folder");
      await assertRejects(adapter.write("file.md/child.md", bytes("z")), "path-conflict", "write() under a file");
      await assertRejects(adapter.rename("file.md", "a"), "path-conflict", "rename() onto a folder");
      assertEqual(await sortedList(adapter), ["a/b.md", "file.md"], "list()");
    },
  },
  {
    // The sync engine's guard against overwriting a save it has not seen (SPEC.md §8, #163).
    name: "a write naming the file's current content replaces it, and one naming other content fails with changed",
    run: async (adapter, options) => {
      // UTF-8 text, text with a byte order mark, and bytes that are not UTF-8.
      const versions: [string, Uint8Array, Uint8Array, Uint8Array][] = [
        ["note.md", bytes("base\n"), bytes("saved by the user\n"), bytes("remote\n")],
        ["bom.md", bytes("\ufeffbase\n"), bytes("\ufeffsaved by the user\n"), bytes("\ufeffremote\n")],
        ["image.png", Uint8Array.of(0xff, 0x00, 0x01), Uint8Array.of(0xff, 0x00, 0x02), Uint8Array.of(0xff, 0x00, 0x03)],
      ];
      for (const [path, base, saved, remote] of versions) {
        await adapter.write(path, base);
        await adapter.write(path, saved);
        const recorder = new EventRecorder(adapter);
        try {
          await assertRejects(adapter.write(path, remote, { expectedHash: sha256Hex(base) }), "changed", `write(${path}) naming the old content`);
          await recorder.expect([], options, `events of the refused write to ${path}`);
        } finally {
          recorder.stop();
        }
        assertEqual(await adapter.read(path), saved, `read(${path}) after the refused write`);
        await adapter.write(path, remote, { expectedHash: sha256Hex(saved) });
        assertEqual(await adapter.read(path), remote, `read(${path}) after the write naming the current content`);
      }
    },
  },
  {
    name: "a write expecting no file creates one, and fails with changed where a file is",
    run: async (adapter) => {
      await adapter.write("new.md", bytes("created"), { expectedHash: null });
      assertEqual(await adapter.read("new.md"), bytes("created"), "read() after the create");
      await assertRejects(adapter.write("new.md", bytes("again"), { expectedHash: null }), "changed", "write() expecting no file");
      assertEqual(await adapter.read("new.md"), bytes("created"), "read() after the refused create");
    },
  },
  {
    name: "a write expecting a file fails with changed where none is",
    run: async (adapter) => {
      await assertRejects(adapter.write("gone.md", bytes("remote"), { expectedHash: sha256Hex(bytes("base")) }), "changed", "write() expecting a file");
      assertEqual(await adapter.list(), [], "list()");
    },
  },
  {
    name: "a delete naming the file's current content removes it, and one naming other content fails with changed",
    run: async (adapter, options) => {
      await adapter.write("note.md", bytes("base"));
      await adapter.write("note.md", bytes("saved by the user"));
      const recorder = new EventRecorder(adapter);
      try {
        await assertRejects(adapter.delete("note.md", { expectedHash: sha256Hex(bytes("base")) }), "changed", "delete() naming the old content");
        await recorder.expect([], options, "events of the refused delete");
      } finally {
        recorder.stop();
      }
      assertEqual(await adapter.read("note.md"), bytes("saved by the user"), "read() after the refused delete");
      await assertRejects(adapter.delete("missing.md", { expectedHash: sha256Hex(bytes("base")) }), "not-found", "delete() of a missing file");
      await adapter.delete("note.md", { expectedHash: sha256Hex(bytes("saved by the user")) });
      assertEqual(await adapter.list(), [], "list() after the delete");
    },
  },
  {
    name: "changes are reported as events in order",
    run: async (adapter, options) => {
      const recorder = new EventRecorder(adapter);
      try {
        await adapter.write("a.md", bytes("1"));
        await adapter.write("a.md", bytes("2"));
        await adapter.rename("a.md", "dir/b.md");
        await adapter.delete("dir/b.md");
        await recorder.expect(
          [
            { type: "create", path: "a.md" },
            { type: "modify", path: "a.md" },
            { type: "rename", path: "dir/b.md", oldPath: "a.md" },
            { type: "delete", path: "dir/b.md" },
          ],
          options,
          "events",
        );
      } finally {
        recorder.stop();
      }
    },
  },
  {
    // Echo suppression (SPEC.md §8) matches the events at one path against
    // the engine's changes there in order: a delete reported after the
    // create that followed it would be taken for the user's.
    name: "changes at one path are reported as events in the order they happened, a rename onto it too",
    run: async (adapter, options) => {
      await adapter.write("b.md", bytes("b"));
      const recorder = new EventRecorder(adapter);
      try {
        await adapter.write("a.md", bytes("1"));
        await adapter.delete("a.md");
        await adapter.write("a.md", bytes("2"));
        await adapter.delete("a.md");
        await adapter.rename("b.md", "a.md");
        await adapter.write("a.md", bytes("3"));
        await recorder.expect(
          [
            { type: "create", path: "a.md" },
            { type: "delete", path: "a.md" },
            { type: "create", path: "a.md" },
            { type: "delete", path: "a.md" },
            { type: "rename", path: "a.md", oldPath: "b.md" },
            { type: "modify", path: "a.md" },
          ],
          options,
          "events",
        );
      } finally {
        recorder.stop();
      }
    },
  },
  {
    // The sync engine sees a folder rename only through these events, and
    // syncs it as renames of its documents (SPEC.md §6.3).
    name: "a folder rename is reported as a rename of every file in it",
    run: async (adapter, options, harness) => {
      if (harness.renameFolder === undefined) throw new ConformanceFailure("the harness cannot rename folders");
      await adapter.write("dir/a.md", bytes("a"));
      await adapter.write("dir/sub/b.md", bytes("b"));
      await adapter.write("other.md", bytes("other"));
      const recorder = new EventRecorder(adapter);
      try {
        await harness.renameFolder("dir", "moved");
        await recorder.expectUnordered(
          [
            { type: "rename", path: "moved/a.md", oldPath: "dir/a.md" },
            { type: "rename", path: "moved/sub/b.md", oldPath: "dir/sub/b.md" },
          ],
          options,
          "events",
        );
      } finally {
        recorder.stop();
      }
      assertEqual(await sortedList(adapter), ["moved/a.md", "moved/sub/b.md", "other.md"], "list()");
      assertEqual(await adapter.read("moved/sub/b.md"), bytes("b"), "read() at the new path");
    },
  },
  {
    name: "failed operations report no events",
    run: async (adapter, options) => {
      await adapter.write("a.md", bytes("a"));
      await adapter.write("b.md", bytes("b"));
      const recorder = new EventRecorder(adapter);
      try {
        await assertRejects(adapter.delete("missing.md"), "not-found", "delete()");
        await assertRejects(adapter.rename("a.md", "b.md"), "already-exists", "rename()");
        await recorder.expect([], options, "events");
      } finally {
        recorder.stop();
      }
    },
  },
  {
    name: "unsubscribing stops event delivery",
    run: async (adapter, options) => {
      const kept = new EventRecorder(adapter);
      const stopped = new EventRecorder(adapter);
      try {
        stopped.stop();
        await adapter.write("a.md", bytes("a"));
        await kept.expect([{ type: "create", path: "a.md" }], options, "events of the active listener");
        assertEqual(stopped.events, [], "events after unsubscribing");
      } finally {
        kept.stop();
      }
    },
  },
  {
    name: "replace (where the platform has it) moves a file over its target and checks the precondition",
    run: async (adapter) => {
      if (adapter.replace === undefined) return;
      await adapter.write("note.md", bytes("old"));
      await adapter.write("note.md.next", bytes("new"));
      await assertRejects(adapter.replace("note.md.next", "note.md", { expectedHash: sha256Hex(bytes("other")) }), "changed", "replace() with a stale precondition");
      assertEqual(await adapter.read("note.md"), bytes("old"), "target after a refused replace");
      await adapter.replace("note.md.next", "note.md", { expectedHash: sha256Hex(bytes("old")) });
      assertEqual(await adapter.read("note.md"), bytes("new"), "target after replace()");
      assertEqual(await sortedList(adapter), ["note.md"], "list() after replace()");
      await adapter.write("fresh.md.next", bytes("fresh"));
      await assertRejects(adapter.replace("fresh.md.next", "note.md", { expectedHash: null }), "changed", "replace() onto a file expected absent");
      await adapter.replace("fresh.md.next", "folder/fresh.md", { expectedHash: null });
      assertEqual(await adapter.read("folder/fresh.md"), bytes("fresh"), "a new file after replace()");
      assertEqual(await sortedList(adapter), ["folder/fresh.md", "note.md"], "list() after replace() onto a new path");
    },
  },
];
