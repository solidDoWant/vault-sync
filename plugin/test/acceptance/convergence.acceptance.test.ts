/// <reference types="node" />
import { describe, expect, it } from "vitest";

import { configured, createVault, RealDevice, serverFiles } from "./real-server";

// AC-25 (docs/acceptance/phase-2.md): three devices make seeded random
// creates, edits, renames and deletes against a real server, some going
// offline and coming back, then sync until idle. Every choice comes from the
// seed, and the devices act one at a time, so a seed replays the same run.
// VAULT_SYNC_AC25_SEED runs one seed instead of the default ones.

const defaultSeeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const seedOverride = process.env.VAULT_SYNC_AC25_SEED ?? "";
const seeds = seedOverride === "" ? defaultSeeds : [Number(seedOverride)];
const steps = 150;

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const folders = ["", "Projects/", "Archive/"];

/** One seeded run: the operations, then sync until idle. Returns what it did and the server's files at the end. */
async function run(seed: number): Promise<{ log: string[]; files: Record<string, string> }> {
  const random = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  let clock = Date.UTC(2026, 9, 29, 12, 0);
  const now = () => clock;

  const vaultId = await createVault(`convergence ${String(seed)}`);
  const devices = [await RealDevice.register(vaultId, "alpha", now), await RealDevice.register(vaultId, "beta", now), await RealDevice.register(vaultId, "gamma", now)];
  const offline = new Set<RealDevice>();

  /** Every line a device wrote, and the ones a device deleted with its file. */
  const written = new Set<string>();
  const deleted = new Set<string>();
  const log: string[] = [];

  const newPath = (files: Record<string, string>): string => {
    for (;;) {
      const path = `${pick(folders)}note-${String(Math.floor(random() * 30))}.md`;
      if (files[path] === undefined) return path;
    }
  };

  for (let step = 0; step < steps; step++) {
    clock += 1_000;
    const device = pick(devices);
    if (random() < 0.12) {
      if (offline.has(device)) {
        offline.delete(device);
        log.push(`${device.name} comes online`);
      } else if (offline.size < 2) {
        offline.add(device);
        log.push(`${device.name} goes offline`);
      }
    }
    const files = await device.files();
    const paths = Object.keys(files);
    const token = `line ${String(seed)}.${String(step)} by ${device.name}`;
    const roll = random();
    if (paths.length === 0 || roll < 0.3) {
      const path = newPath(files);
      written.add(token);
      await device.write(path, `${token}\n`);
      log.push(`${device.name} creates ${path}`);
    } else if (roll < 0.7) {
      const path = pick(paths);
      const lines = (files[path] ?? "").split("\n").filter((line) => line !== "");
      lines.splice(Math.floor(random() * (lines.length + 1)), 0, token);
      written.add(token);
      await device.write(path, `${lines.join("\n")}\n`);
      log.push(`${device.name} edits ${path}`);
    } else if (roll < 0.85) {
      const from = pick(paths);
      const to = newPath(files);
      await device.vault.rename(from, to);
      log.push(`${device.name} renames ${from} to ${to}`);
    } else {
      const path = pick(paths);
      for (const line of (files[path] ?? "").split("\n")) if (line !== "") deleted.add(line);
      await device.vault.delete(path);
      log.push(`${device.name} deletes ${path}`);
    }
    if (!offline.has(device) && random() < 0.5) await device.sync();
  }

  // Everyone comes back online and syncs until a whole round changes nothing.
  let previous = -1n;
  for (let round = 0; ; round++) {
    expect(round, `seed ${String(seed)} did not reach idle:\n${log.join("\n")}`).toBeLessThan(10);
    for (const device of devices) await device.sync();
    const { headSeq } = await serverFiles(vaultId);
    if (headSeq === previous) break;
    previous = headSeq;
  }

  const { files: heads } = await serverFiles(vaultId);
  for (const device of devices) {
    expect(await device.files(), `${device.name} after seed ${String(seed)}:\n${log.join("\n")}`).toEqual(heads);
    expect((await device.journal.load()).pending, `${device.name} has pending operations`).toEqual([]);
  }
  const kept = new Set(Object.values(heads).flatMap((content) => content.split("\n")));
  const lost = [...written].filter((line) => !kept.has(line) && !deleted.has(line));
  expect(lost, `user edits lost with seed ${String(seed)}:\n${log.join("\n")}`).toEqual([]);
  return { log, files: heads };
}

describe.skipIf(!configured)("convergence against a real server", () => {
  it.each(seeds)("[AC-25] three devices converge to the server's heads, losing no edit (seed %i)", async (seed) => {
    await run(seed);
  });

  it("[AC-25] replays the same run for the same seed", async () => {
    const first = await run(seeds[0] ?? 1);
    const second = await run(seeds[0] ?? 1);
    expect(second.log).toEqual(first.log);
    expect(second.files).toEqual(first.files);
  });
});
