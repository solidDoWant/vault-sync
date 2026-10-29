import { describe, expect, it } from "vitest";

import { DocumentKind } from "../../gen/vaultsync/v1/types_pb";
import { InMemoryServer } from "./memory-server";
import { Device } from "./testing";

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const decoder = new TextDecoder();
function serverFolders(server: InMemoryServer): string[] {
  const heads = new Map<string, { path: string; deleted: boolean; folder: boolean }>();
  for (let seq = 1n; seq <= server.currentHeadSeq; seq++) {
    const revision = server.revisionAt(seq);
    heads.set(revision.documentId, { path: decoder.decode(revision.path), deleted: revision.deleted, folder: revision.kind === DocumentKind.FOLDER });
  }
  return [...heads.values()].filter((head) => head.folder && !head.deleted).map((head) => head.path).sort();
}

const seedStart = Number(process.env.BH_SEED_START ?? "1");
const seedCount = Number(process.env.BH_SEEDS ?? "200");
const steps = Number(process.env.BH_STEPS ?? "60");
const seeds = Array.from({ length: seedCount }, (_, index) => seedStart + index);
const folderNames = ["", "A/", "B/", "A/C/"];

describe("bughunt fuzz", () => {
  it.each(seeds)("seed %i converges", async (seed) => {
    const random = prng(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    let clock = Date.UTC(2026, 9, 29, 12, 0);
    const now = () => clock;
    const server = new InMemoryServer({ now: () => new Date(clock) });
    const devices = ["alpha", "beta", "gamma"].map((name) => new Device(server, name, { now }, { now }));
    for (const device of devices) await device.engine.start();
    const offline = new Set<Device>();
    const written = new Set<string>();
    const deleted = new Set<string>();
    const log: string[] = [];
    const newPath = (files: Record<string, string>, folders: string[]): string => {
      for (;;) {
        const folder = random() < 0.3 && folders.length > 0 ? `${pick(folders)}/` : pick(folderNames);
        const path = `${folder}note-${String(Math.floor(random() * (process.env.BH_FRESH_CREATE ? 3000 : 30)))}.md`;
        if (files[path] === undefined && !folders.includes(path) && !(process.env.BH_FRESH_CREATE && used.has(path))) { used.add(path); return path; }
      }
    };
    const errors: string[] = [];
    const used = new Set<string>();
    const sync = async (device: Device) => {
      await device.sync().catch((error: unknown) => errors.push(`${device.deviceId}: ${String(error)}`));
    };
    for (let step = 0; step < steps; step++) {
      clock += 1_000;
      const device = pick(devices);
      if (random() < 0.12) {
        if (offline.has(device)) offline.delete(device);
        else if (offline.size < 2) offline.add(device);
      }
      const files = await device.files();
      const folders = await device.vault.listFolders();
      const paths = Object.keys(files);
      const token = `line ${String(seed)}.${String(step)} by ${device.deviceId}`;
      const roll = random();
      try {
        if (paths.length === 0 || roll < 0.25) {
          const path = newPath(files, folders);
          written.add(token);
          await device.write(path, `${token}\n`);
          log.push(`${device.deviceId} creates ${path}`);
        } else if (roll < 0.55) {
          const path = pick(paths);
          const lines = (files[path] ?? "").split("\n").filter((line) => line !== "");
          lines.splice(Math.floor(random() * (lines.length + 1)), 0, token);
          written.add(token);
          await device.write(path, `${lines.join("\n")}\n`);
          log.push(`${device.deviceId} edits ${path}`);
        } else if (roll < 0.65) {
          const from = pick(paths);
          const to = process.env.BH_FRESH ? `${pick(folderNames)}renamed-${String(step)}.md` : newPath(files, folders);
          await device.vault.rename(from, to);
          log.push(`${device.deviceId} renames ${from} to ${to}`);
        } else if (roll < 0.73) {
          const path = pick(paths);
          for (const line of (files[path] ?? "").split("\n")) if (line !== "") deleted.add(line);
          await device.vault.delete(path);
          log.push(`${device.deviceId} deletes ${path}`);
        } else if (roll < 0.8) {
          const folder = `${pick(folderNames)}F${String(Math.floor(random() * 5))}`;
          await device.vault.createFolder(folder);
          log.push(`${device.deviceId} creates folder ${folder}`);
        } else if (roll < 0.9 && folders.length > 0) {
          const from = pick(folders);
          const to = process.env.BH_FRESH ? `${pick(folderNames)}R${String(step)}` : `${pick(folderNames)}R${String(Math.floor(random() * 5))}`;
          if (!to.startsWith(`${from}/`) && to !== from) {
            await device.vault.renameFolder(from, to);
            log.push(`${device.deviceId} renames folder ${from} to ${to}`);
          }
        } else if (folders.length > 0) {
          const folder = pick(folders);
          for (const path of paths.filter((path) => path.startsWith(`${folder}/`))) {
            for (const line of (files[path] ?? "").split("\n")) if (line !== "") deleted.add(line);
            await device.vault.delete(path);
          }
          for (const sub of folders.filter((other) => other.startsWith(`${folder}/`)).sort((x, y) => y.length - x.length)) await device.vault.deleteFolder(sub);
          await device.vault.deleteFolder(folder);
          log.push(`${device.deviceId} deletes folder ${folder}`);
        }
      } catch (error) {
        log.push(`${device.deviceId} op failed: ${String(error)}`);
      }
      if (process.env.BH_FAULTS && random() < 0.08) {
        await device.engine.settled();
        device.restart();
        await device.engine.start().catch(() => undefined);
        log.push(`${device.deviceId} restarts`);
      }
      if (!offline.has(device) && random() < 0.5) {
        const lose = process.env.BH_FAULTS !== undefined && random() < 0.3;
        let lost = false;
        server.responseInterceptor = (method) => {
          if (lose && !lost && (method === "CommitRevision" || method === "ListChanges")) {
            lost = true;
            throw new Error("connection reset");
          }
        };
        await sync(device);
        server.responseInterceptor = undefined;
        if (lost) log.push(`${device.deviceId} loses a reply`);
        log.push(`${device.deviceId} syncs`);
      }
    }
    let previous = -1n;
    for (let round = 0; ; round++) {
      expect(round, `seed ${String(seed)} did not reach idle:\n${log.join("\n")}`).toBeLessThan(10);
      for (const device of devices) await sync(device);
      if (server.currentHeadSeq === previous) break;
      previous = server.currentHeadSeq;
    }
    if (process.env.BH_SKIP_KNOWN) for (const device of devices) if ((await device.journal.load()).pending.some((op) => op.refused !== undefined)) return;
    const context = `\n${log.join("\n")}\nerrors: ${errors.join("; ")}`;
    const heads = Object.fromEntries([...server.liveFiles()].sort());
    if (process.env.BH_DEBUG) for (const device of devices) {
      const state = await device.journal.load();
      console.log(device.deviceId, "cursor", state.cursor.seq, "head", server.currentHeadSeq, "status", device.engine.status, String(device.engine.lastError), "pending", JSON.stringify(state.pending), "docs", JSON.stringify([...state.docs.values()].map((entry) => [entry.documentId.slice(-6), entry.path, entry.deleted ?? false])));
    }
    if (process.env.BH_DEBUG) for (const device of devices) {
      const state = await device.journal.load();
      if (state.cursor.seq < server.currentHeadSeq) {
        const next = server.revisionAt(state.cursor.seq + 1n);
        const entry = state.docs.get(next.documentId);
        console.log("STUCK", device.deviceId, "next", next.documentId.slice(-6), decoder.decode(next.path), next.deleted, "entry", JSON.stringify(entry), "ops", JSON.stringify(state.pending.filter((op) => op.documentId === next.documentId)), "files", JSON.stringify(Object.keys(await device.files())));
        const ops = state.pending.filter((op) => op.documentId === next.documentId);
        const at = ops.at(-1)?.path ?? "";
        console.log("SAMEPATH docs", JSON.stringify([...state.docs.values()].filter((e) => e.path === at)), "pending", JSON.stringify(state.pending.filter((op) => op.path === at)), "file", JSON.stringify((await device.files())[at]));
      }
    }
    if (process.env.BH_DEBUG) console.log("server docs", JSON.stringify([...server.liveDocuments()].map(([path, id]) => [path, id.slice(-6)])));
    for (const device of devices) {
      expect(await device.files(), `${device.deviceId} files, seed ${String(seed)}${context}`).toEqual(heads);
      expect((await device.vault.listFolders()).sort(), `${device.deviceId} folders, seed ${String(seed)}${context}`).toEqual(serverFolders(server));
      const state = await device.journal.load();
      expect(state.pending, `${device.deviceId} pending, seed ${String(seed)}${context}`).toEqual([]);
      expect(state.cursor.seq, `${device.deviceId} cursor, seed ${String(seed)}${context}`).toBe(server.currentHeadSeq);
    }
    const kept = new Set(Object.values(heads).flatMap((content) => content.split("\n")));
    const lost = [...written].filter((line) => !kept.has(line) && !deleted.has(line));
    expect(lost, `lost, seed ${String(seed)}${context}`).toEqual([]);
  });
});
