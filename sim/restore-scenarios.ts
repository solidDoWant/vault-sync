// Scripted server-restore scenarios combined with retention purges (#488,
// #494, SPEC.md §6.1, §8, §11).

import { settle } from "./network";
import { SimRun, type SimEndpoints } from "./runner";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RestoreWindowResult {
  trace: string[];
  /** The device's vault at the end: path to content. */
  device: Map<string, string>;
  /** A device new to the vault, which pulls only at the end: the server's view, path to content. */
  server: Map<string, string>;
  /** Whether any pull of the device resynced. */
  resynced: boolean;
}

/**
 * The shapes of a restore whose loss the cursor anchor alone cannot tell
 * from a retention purge.
 *
 * - `deleted-after-restore` (#488): the device (second engine) commits an
 *   edit of a note at seq 2, its cursor. The database is restored to seq 1, losing that
 *   revision; a third engine new to the vault then writes another note at
 *   seq 2, deletes the device's note at seq 3 and edits the other note at
 *   seq 4, and retention purges the revision at seq 2: the device's cursor
 *   and the note's synced seq.
 * - `untouched-after-restore` (#488): the same, but the third engine writes
 *   two other notes instead of deleting the device's note, so the restored
 *   server's head of that note is older than the device's revision.
 * - `own-commit-above-cursor` (#494 item 3): the device commits an edit at
 *   seq 3 while its cursor is at 1 (another device committed at 2 meanwhile,
 *   #261). The database is restored to seq 2, losing the edit; nothing at the
 *   cursor is purged, so the anchor check passes. The first engine then edits
 *   the note on the restored server.
 *
 * In every shape the device's acknowledged content must survive on the
 * device and reach the server again (SPEC.md §2 principle 1).
 */
export async function restoreWindow(endpoints: SimEndpoints, shape: "deleted-after-restore" | "untouched-after-restore" | "own-commit-above-cursor"): Promise<RestoreWindowResult> {
  const run = await SimRun.start(endpoints, { seed: 0, clients: 0, engines: 4, platforms: ["posix", "posix", "posix", "posix"] });
  const [first, second, third, fresh] = run.observers;
  if (first === undefined || second === undefined || third === undefined || fresh === undefined) throw new Error("the run has four engines");
  const log = (entry: string) => {
    run.context.log(entry);
  };
  const push = async (engine: typeof first) => {
    log(engine.startPush());
    await settle();
    await run.drain(engine.index);
  };
  const pull = async (engine: typeof first) => {
    log(engine.startPull());
    await settle();
    await run.drain(engine.index);
  };
  let resynced = false;
  const pullSecond = async () => {
    second.lastPull = undefined;
    await pull(second);
    const lastPull = () => second.lastPull;
    if (lastPull()?.resynced === true) resynced = true;
  };
  const write = (value: string) => encoder.encode(`${value}\n`);

  log(await first.edit("notes/a.md", write("base")));
  await push(first);

  if (shape === "own-commit-above-cursor") {
    await pull(second);
    log(await second.edit("notes/a.md", write("acknowledged edit")));
    log(second.startPush());
    await settle();
    // The device's commit waits while another device commits at seq 2.
    for (let delivery = 0; run.context.network.pendingRequest(second.index) !== "CommitRevision"; delivery++) {
      if (delivery > 200) throw new Error("the second engine never sent CommitRevision");
      await run.step({ kind: "deliver-request", client: second.index });
      await run.step({ kind: "deliver-response", client: second.index });
    }
    log(await first.edit("notes/b.md", write("other")));
    await push(first);
    if ((await run.snapshot()) !== 2n) throw new Error("expected the backup at seq 2");
    await run.drain(second.index);
    if (second.lastPush?.committed !== 1) throw new Error("the second engine's edit was not acknowledged");
    await run.restore();
    log(await first.edit("notes/a.md", write("edited on the restored server")));
    await push(first);
  } else {
    if ((await run.snapshot()) !== 1n) throw new Error("expected the backup at seq 1");
    // The device's own edit, acknowledged: a revision it only pulled is its
    // writer's to send again after a restore (#874, design §4.6).
    await pull(second);
    log(await second.edit("notes/a.md", write("acknowledged edit")));
    await push(second);
    await pull(second);
    if (second.lastPull?.cursor !== 2n) throw new Error(`expected the second engine at seq 2, it is at ${String(second.lastPull?.cursor)}`);
    await run.restore();
    await pull(third);
    log(await third.edit("notes/b.md", write("one")));
    await push(third);
    if (shape === "deleted-after-restore") {
      log(await third.remove("notes/a.md"));
    } else {
      log(await third.edit("notes/c.md", write("other")));
    }
    await push(third);
    log(await third.edit("notes/b.md", write("two")));
    await push(third);
    const revisions = (await run.direct.sync.listChanges({ vaultId: run.context.vaultId, sinceSeq: 0n })).revisions;
    const atCursor = revisions.find((revision) => revision.seq === 2n);
    if (atCursor === undefined) throw new Error("no revision at seq 2");
    // Aged with its document's head, which supersedes it in its retention bucket; the head itself is never purged.
    const head = revisions.filter((revision) => revision.documentId === atCursor.documentId).at(-1);
    if (head === undefined || head.seq <= atCursor.seq) throw new Error("the revision at seq 2 is its document's head");
    const purged = await run.purge([atCursor.id, head.id]);
    if (purged.length !== 1 || purged[0] !== atCursor.id) throw new Error(`expected the revision at seq 2 purged, got ${String(purged.length)}`);
  }

  await pullSecond();
  await push(second);
  await pullSecond();
  await push(second);
  await pull(fresh);

  const contents = async (engine: typeof first) => {
    const files = new Map<string, string>();
    for (const path of await engine.list()) files.set(path, decoder.decode((await engine.read(path)) ?? new Uint8Array()));
    return files;
  };
  return { trace: run.trace, device: await contents(second), server: await contents(fresh), resynced };
}
