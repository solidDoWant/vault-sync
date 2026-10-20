import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { pathKey } from "../pathkey/pathkey";
import { InMemoryVault } from "../vault/memory";
import { unmaterializableReason, type PathPlatform } from "../vaultpath/platform";
import { InMemoryServer } from "./memory-server";
import { Crash, CrashingJournal, CrashingVault, CrashPoints, harness, type Harness } from "./testing";

const pool = (process.env.FUZZ_POOL ?? "a.md,A.md,b.md,café.md,café.md,notes/c.md,Notes/C.md,NOTES/d.md,NOTES,notes,CON.md,con/x.md,x.md.,ab:c.md,straße.md,STRASSE.md").replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))).split(",");
const folders = ["notes", "Notes", "NOTES", "con", "CON", "x"];

function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Device {
  name: string;
  platform: PathPlatform;
  h: Harness;
  vault: InMemoryVault;
  points: CrashPoints;
}

async function runSteps(stepList: number[][], platforms: PathPlatform[], log: string[]): Promise<string[]> {
  let draws: number[] = [];
  let drawIndex = 0;
  const random = () => draws[drawIndex++ % draws.length] as number;
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const server = new InMemoryServer({ maxPageSize: 3, maxDownloadBytes: 64 });
  const problems: string[] = [];
  let tag = 0;
  const devices: Device[] = platforms.map((platform, index) => {
    const points = new CrashPoints();
    const vault = new InMemoryVault({ pathRules: { platform } });
    const journal = new CrashingJournal(points);
    const h = harness({ merge: "default", server, vault, journal, pathRules: { platform }, idPrefix: `d${String(index)}`, deviceName: `dev${String(index)}`, wrapVault: (inner) => new CrashingVault(inner, points) });
    return { name: `d${String(index)}(${platform})`, platform, h, vault, points };
  });
  const run = async (device: Device, what: "push" | "pull") => {
    try {
      const result = await device.h.engine[what]();
      log.push(`${device.name} ${what} -> ${JSON.stringify(result, (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value))}`);
    } catch (error) {
      if (error instanceof Crash) {
        log.push(`${device.name} ${what} CRASH`);
        device.points.crashAfter = 0;
        device.h.restart();
        return;
      }
      problems.push(`${device.name} ${what} threw: ${String(error)}`);
      log.push(`${device.name} ${what} THREW ${String(error)}`);
    }
  };
  for (const stepDraws of stepList) {
    draws = stepDraws;
    drawIndex = 0;
    const device = pick(devices);
    const roll = random();
    try {
      if (roll < 0.2) {
        const path = pick(pool);
        const content = `w${String(++tag)}\n`;
        await device.vault.write(path, encoder.encode(content));
        log.push(`${device.name} write ${path} ${content.trim()}`);
      } else if (roll < 0.3) {
        const existing = await device.vault.list();
        if (existing.length === 0) continue;
        const path = pick(existing);
        const old = decoder.decode(await device.vault.read(path));
        const content = `${old}e${String(++tag)}\n`;
        await device.vault.write(path, encoder.encode(content));
        log.push(`${device.name} append ${path} e${String(tag)}`);
      } else if (roll < 0.42) {
        const existing = await device.vault.list();
        if (existing.length === 0) continue;
        const from = pick(existing);
        const to = random() < 0.4 ? (from === from.toLowerCase() ? from.toUpperCase() : from.toLowerCase()) : pick(pool);
        await device.vault.rename(from, to);
        log.push(`${device.name} rename ${from} -> ${to}`);
      } else if (roll < 0.47) {
        const from = pick(folders);
        const to = pick(folders);
        await device.vault.renameFolder(from, to);
        log.push(`${device.name} renameFolder ${from} -> ${to}`);
      } else if (roll < 0.55) {
        const existing = await device.vault.list();
        if (existing.length === 0) continue;
        const path = pick(existing);
        await device.vault.delete(path);
        log.push(`${device.name} delete ${path}`);
      } else if (roll < 0.72) {
        await run(device, "push");
      } else if (roll < 0.9) {
        await run(device, "pull");
      } else if (roll < 0.95) {
        device.points.count = 0;
        device.points.crashAfter = 1 + Math.floor(random() * 6);
        log.push(`${device.name} arm crash after ${String(device.points.crashAfter)}`);
        await run(device, random() < 0.5 ? "push" : "pull");
        device.points.crashAfter = 0;
      } else {
        log.push(`${device.name} restart`);
        device.h.restart();
      }
    } catch (error) {
      if (error instanceof Crash) throw error;
      // A change the vault refuses simply does not happen.
    }
    await Promise.all(devices.map((each) => each.h.engine.settled().catch(() => undefined)));
    if (process.env.FUZZ_TRACE !== undefined) {
      log.push(`      server ${JSON.stringify([...server.liveDocuments()])}`);
      for (const each of devices) {
        const contents: string[] = [];
        for (const path of await each.vault.list()) contents.push(`${path}=${decoder.decode(await each.vault.read(path)).replaceAll("\n", "|")}`);
        log.push(`      ${each.name} vault ${contents.join(", ")} journal ${JSON.stringify((await each.h.journal.listDocuments()).map((state) => `${state.documentId}@${state.path}${state.deleted ? "(del)" : ""}`))} pending ${String((await each.h.journal.listPending()).length)}`);
      }
    }
  }
  // Quiesce.
  let quiet = false;
  for (let round = 0; round < 12 && !quiet; round++) {
    quiet = true;
    for (const device of devices) {
      try {
        const summary = await device.h.engine.push();
        log.push(`${device.name} final push -> ${JSON.stringify(summary)}`);
        if (summary.committed > 0 || summary.conflicts > 0 || summary.pending > 0) quiet = false;
      } catch (error) {
        problems.push(`${device.name} final push threw: ${String(error)}`);
        quiet = false;
      }
    }
  }
  if (!quiet) problems.push("liveness: pushes never quiesced");
  for (const device of devices) {
    try {
      await device.h.engine.pull();
    } catch (error) {
      problems.push(`${device.name} final pull threw: ${String(error)}`);
    }
  }
  const live = server.liveFiles();
  for (const device of devices) {
    const rules = { platform: device.platform };
    const key = device.platform === "posix" ? (path: string) => path : pathKey;
    const expected = new Map<string, string>();
    for (const [path, content] of live) if (unmaterializableReason(path, rules) === undefined) expected.set(key(path), `${path}=${content}`);
    const actual = new Map<string, string>();
    for (const path of await device.vault.list()) actual.set(key(path), `${path}=${decoder.decode(await device.vault.read(path))}`);
    const unmat = new Set((await device.h.engine.unmaterializable()).map((document) => key(document.localPath ?? document.path)));
    for (const [k, value] of expected) {
      const got = actual.get(k);
      if (got === undefined) problems.push(`${device.name} missing ${value}`);
      else if (got.split("=").slice(1).join("=") !== value.split("=").slice(1).join("=")) problems.push(`${device.name} content differs at ${k}: vault ${got} server ${value}`);
      else if (device.platform === "posix" && got !== value) problems.push(`${device.name} spelling ${got} vs ${value}`);
    }
    for (const [k, value] of actual) if (!expected.has(k) && !unmat.has(k)) problems.push(`${device.name} extra ${value}`);
    const deferred = (await device.h.journal.listDeferred()).filter((entry) => entry.reason !== "unmaterializable");
    for (const entry of deferred) problems.push(`${device.name} deferred ${entry.reason} ${decoder.decode(encoder.encode(entry.revision.path))}`);
  }
  if (problems.length > 0 && process.env.FUZZ_LOG !== undefined) {
    log.push(`SERVER ${JSON.stringify([...live])}`);
    for (const device of devices) {
      const contents: [string, string][] = [];
      for (const path of await device.vault.list()) contents.push([path, decoder.decode(await device.vault.read(path))]);
      log.push(`VAULT ${device.name} ${JSON.stringify(contents)}`);
      log.push(`JOURNAL ${device.name} ${JSON.stringify((await device.h.journal.listDocuments()).map((state) => [state.documentId, state.path, state.deleted]))}`);
      log.push(`PENDING ${device.name} ${JSON.stringify(await device.h.journal.listPending(), (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? "<bytes>" : v))}`);
      log.push(`DEFERRED ${device.name} ${JSON.stringify((await device.h.journal.listDeferred()).map((entry) => [entry.reason, entry.revision.path, entry.revision.documentId]))}`);
      log.push(`UNMAT ${device.name} ${JSON.stringify((await device.h.engine.unmaterializable()).map((d) => [d.path, d.localPath]))}`);
    }
  }
  return problems;
}

const seeds = Number(process.env.FUZZ_SEEDS ?? "50");
const first = Number(process.env.FUZZ_FIRST ?? "1");
const steps = Number(process.env.FUZZ_STEPS ?? "80");
const sets: PathPlatform[][] = (process.env.FUZZ_PLATFORMS ?? "posix+windows,posix+macos,windows+macos,windows+windows,macos+macos").split(",").map((set) => set.split("+") as PathPlatform[]);

describe("bughunt fuzz", () => {
  for (const platforms of sets) {
    it(`converges on ${platforms.join("+")}`, { timeout: 600_000 }, async () => {
      const failures: string[] = [];
      for (let seed = first; seed < first + seeds; seed++) {
        const log: string[] = [];
        const random = rng(seed);
        let stepList = Array.from({ length: steps }, () => Array.from({ length: 6 }, () => random()));
        const attempt = async (list: number[][], into: string[]) => {
          try {
            return await runSteps(list, platforms, into);
          } catch (error) {
            return [`harness threw: ${String(error)}`];
          }
        };
        let problems = await attempt(stepList, []);
        if (problems.length > 0 && process.env.FUZZ_SHRINK !== undefined) {
          const kind = (problem: string) => problem.replace(/^d[0-9]\([a-z]+\) /, "").split(" ")[0];
          const wanted = kind(problems[0] as string);
          const fails = async (list: number[][]) => (await attempt(list, [])).some((problem) => kind(problem) === wanted);
          for (let chunk = Math.floor(stepList.length / 2); chunk >= 1; chunk = Math.floor(chunk / 2)) {
            for (let start = 0; start < stepList.length; ) {
              const candidate = [...stepList.slice(0, start), ...stepList.slice(start + chunk)];
              if (await fails(candidate)) stepList = candidate;
              else start += chunk;
            }
          }
          problems = await attempt(stepList, []);
        }
        if (process.env.FUZZ_LOAD !== undefined) stepList = JSON.parse(readFileSync(process.env.FUZZ_LOAD, "utf8")) as number[][];
        if (process.env.FUZZ_SAVE !== undefined) writeFileSync(process.env.FUZZ_SAVE, JSON.stringify(stepList));
        problems = await attempt(stepList, log);
        if (problems.length > 0) {
          failures.push(`seed ${String(seed)} ${platforms.join("+")}:\n  ${problems.join("\n  ")}`);
          if (process.env.FUZZ_LOG !== undefined) failures.push(`  LOG:\n    ${log.join("\n    ")}`);
        }
      }
      if (failures.length > 0) console.log(`FUZZFAIL\n${failures.join("\n")}\nENDFUZZ`);
      expect(failures.length).toBe(0);
    });
  }
});
