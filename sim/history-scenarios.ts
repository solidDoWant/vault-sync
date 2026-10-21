// Scripted history-restore scenario (#651, SPEC.md §11): an engine's user
// restores versions from a document's history, of live and deleted
// documents, in place and at another path (#420), while another engine edits
// and deletes. The run's invariants must hold across every restore.

import type { EngineObserver } from "./engine-observer";
import { settle } from "./network";
import { SimRun, type RunResult, type SimEndpoints } from "./runner";
import { liveDocuments } from "./scenarios";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const textLines = (...values: string[]) => values.map((value) => `${value}\n`).join("");

export interface HistoryRestoreResult extends RunResult {
  /** Each engine's vault at the end: path to content. */
  vaults: Map<string, string>[];
  /** The server's live documents before the restores: path to document label. */
  before: Map<string, string>;
  /** The server's live documents at the end: path to document label. */
  documents: Map<string, string>;
}

/**
 * The first engine's user restores, in turn:
 *
 * 1. an older version of `notes/a.md` in place, while the second engine holds
 *    an unpushed edit of the version it replaces, which then merges onto it;
 * 2. `notes/b.md`, which the second engine deleted, in place;
 * 3. `notes/c.md`, which the second engine deleted and then renamed another
 *    note, `notes/d.md`, onto: refused (`path-taken`), then restored at
 *    `notes/c (restored).md`;
 * 4. an older version of the live `notes/a.md` at `archive/a.md`, which moves
 *    the document there.
 *
 * Every restore is a new head revision of its document, so each document
 * keeps its id and no version is lost (SPEC.md §2 principle 1, §11). The
 * second engine must apply each one as an ordinary remote revision, and
 * neither engine may report the restored files as local changes.
 */
export async function historyRestores(endpoints: SimEndpoints): Promise<HistoryRestoreResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 2, platforms: ["posix", "posix"] });
  const [first, second] = run.observers;
  if (first === undefined || second === undefined) throw new Error("the run has two engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const drained = async (engine: EngineObserver, entry: string) => {
    log(entry);
    await settle();
    await run.drain(engine.index);
  };
  const push = (engine: EngineObserver) => drained(engine, engine.startPush());
  const pull = (engine: EngineObserver) => drained(engine, engine.startPull());
  const restore = (path: string, options: { at?: string; back?: number } = {}) => drained(first, first.startRestore(path, options));

  log(await first.edit("notes/a.md", encoder.encode(textLines("title", "one"))));
  log(await first.edit("notes/b.md", encoder.encode(textLines("bee"))));
  log(await first.edit("notes/c.md", encoder.encode(textLines("old sea"))));
  log(await first.edit("notes/d.md", encoder.encode(textLines("dee"))));
  await push(first);
  log(await first.edit("notes/a.md", encoder.encode(textLines("title", "two"))));
  await push(first);
  await pull(second);
  const before = await liveDocuments(run);

  // 1. An older version in place, against the second engine's unpushed edit.
  log(await second.edit("notes/a.md", encoder.encode(textLines("title", "two", "second's line"))));
  await restore("notes/a.md");
  await push(second);
  await pull(first);

  // 2. A deleted document in place.
  log(await second.remove("notes/b.md"));
  // 3. A deleted document whose path another document took since. (A new
  // file written there would revive the deleted document instead.)
  log(await second.remove("notes/c.md"));
  await push(second);
  log(await second.move("notes/d.md", "notes/c.md"));
  await push(second);
  await pull(first);
  await restore("notes/b.md");
  await restore("notes/c.md");
  await restore("notes/c.md", { at: "notes/c (restored).md" });

  // 4. An older version of a live document at another path: the version
  // before the restore of step 1 ("two").
  await restore("notes/a.md", { back: 1, at: "archive/a.md" });

  const result = await run.finish();
  const vaults = await Promise.all(
    [first, second].map(async (engine) => {
      const contents = new Map<string, string>();
      for (const path of await engine.list()) contents.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
      return contents;
    }),
  );
  return { ...result, vaults, before, documents: await liveDocuments(run) };
}
