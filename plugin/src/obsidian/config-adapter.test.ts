import type { DataAdapter, ListedFiles, Stat } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigSyncVault } from "../core/config/config-vault";
import { harness } from "../core/engine/testing";
import { InMemoryServer } from "../core/engine/memory-server";
import { runConformanceCase, vaultAdapterConformance } from "../core/vault/conformance";
import { ObsidianConfigAdapter, reloadNotifier, type ConfigFolderHost } from "./config-adapter";

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: ArrayBuffer | Uint8Array) => new TextDecoder().decode(value);

afterEach(() => {
  vi.useRealTimers();
});

/** A disk as Obsidian's DataAdapter shows it: vault-relative paths, files and folders, and "raw" events for every change. */
class FakeDisk implements ConfigFolderHost {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  private readonly listeners = new Set<(path: string) => void>();

  constructor(readonly configDir: string) {}

  readonly adapter: ConfigFolderHost["adapter"] = {
    stat: (path) => Promise.resolve(this.statOf(path)),
    list: (path) => Promise.resolve(this.listOf(path)),
    readBinary: (path) => {
      const data = this.files.get(path);
      return data === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(new Uint8Array(data).buffer);
    },
    writeBinary: (path, data) => {
      if (!this.folders.has(parent(path))) return Promise.reject(new Error(`ENOENT ${parent(path)}`));
      this.files.set(path, new Uint8Array(data));
      this.raw(path);
      return Promise.resolve();
    },
    mkdir: (path) => {
      this.folders.add(path);
      return Promise.resolve();
    },
    remove: (path) => {
      this.files.delete(path);
      this.raw(path);
      return Promise.resolve();
    },
    rename: (from, to) => {
      const data = this.files.get(from);
      if (data === undefined) return Promise.reject(new Error(`ENOENT ${from}`));
      this.files.delete(from);
      this.files.set(to, data);
      this.raw(from);
      this.raw(to);
      return Promise.resolve();
    },
  } satisfies Pick<DataAdapter, "stat" | "list" | "readBinary" | "writeBinary" | "mkdir" | "remove" | "rename">;

  onRaw(listener: (path: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The part of Obsidian's normalizePath that matters here: U+00A0 and U+202F become a space. */
  normalizePath(path: string): string {
    return path.replace(/[\u00a0\u202f]/gu, " ");
  }

  /** A change made by Obsidian or the user, not through the adapter. */
  put(path: string, content: string): void {
    for (let folder = parent(path); folder !== ""; folder = parent(folder)) this.folders.add(folder);
    this.files.set(path, bytes(content));
    this.raw(path);
  }

  private raw(path: string): void {
    for (const listener of this.listeners) listener(path);
  }

  private statOf(path: string): Stat | null {
    const data = this.files.get(path);
    if (data !== undefined) return { type: "file", ctime: 0, mtime: 1, size: data.length };
    return this.folders.has(path) ? { type: "folder", ctime: 0, mtime: 0, size: 0 } : null;
  }

  private listOf(path: string): ListedFiles {
    return {
      files: [...this.files.keys()].filter((file) => parent(file) === path),
      folders: [...this.folders].filter((folder) => parent(folder) === path),
    };
  }
}

function parent(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function disk(configDir = ".obsidian"): FakeDisk {
  const fake = new FakeDisk(configDir);
  fake.folders.add(configDir);
  return fake;
}

// The event cases need typed create/delete/rename events, which Obsidian's
// raw events do not carry; the engine needs only the path (see watch()).
const fileCases = vaultAdapterConformance.filter((testCase) => !/event|reported|unsubscribing/u.test(testCase.name));

describe("ObsidianConfigAdapter", () => {
  for (const testCase of fileCases) {
    it(`passes the conformance case: ${testCase.name}`, async () => {
      await runConformanceCase(testCase, () => ({ adapter: new ObsidianConfigAdapter(disk()) }));
    });
  }

  it.each([
    ["after", "plugins/x/..\u00a0/..\u00a0/evil.json"],
    ["before", "plugins/x/\u202f../evil.json"],
  ])("never touches a path Obsidian's normalizePath would change, with the space %s the dots (#148)", async (_, path) => {
    const fake = disk();
    fake.put(".obsidian/plugins/x/data.json", "{}");
    fake.put(`.obsidian/${path}`, "already there");
    const files = new Map(fake.files);
    const folders = new Set(fake.folders);
    const adapter = new ObsidianConfigAdapter(fake);
    const events: unknown[] = [];
    const stop = adapter.watch((event) => events.push(event));

    await expect(adapter.write(path, bytes("{}"))).rejects.toMatchObject({ code: "path-conflict" });
    await expect(adapter.rename("plugins/x/data.json", path)).rejects.toMatchObject({ code: "path-conflict" });
    await expect(adapter.read(path)).rejects.toMatchObject({ code: "not-found" });
    await expect(adapter.delete(path)).rejects.toMatchObject({ code: "not-found" });
    expect(await adapter.stat(path)).toBeNull();
    expect(await adapter.list()).toEqual(["plugins/x/data.json"]);
    fake.put(`.obsidian/${path}`, "changed");
    stop();

    // Nothing reported for it, and nothing on disk changed but the outside edit.
    expect(events).toEqual([]);
    files.set(`.obsidian/${path}`, bytes("changed"));
    const contents = (map: Map<string, Uint8Array>) => new Map([...map].map(([key, value]) => [key, text(value)]));
    expect(contents(fake.files)).toEqual(contents(files));
    expect(fake.folders).toEqual(folders);
  });

  it("works in a config folder of any name, with paths relative to it", async () => {
    const fake = disk(".obsidian-mobile");
    fake.put(".obsidian-mobile/hotkeys.json", "{}");
    fake.put(".obsidian-mobile/plugins/dataview/main.js", "code");
    fake.put("note.md", "not config");
    const adapter = new ObsidianConfigAdapter(fake);

    expect((await adapter.list()).sort()).toEqual(["hotkeys.json", "plugins/dataview/main.js"]);
    await adapter.write("snippets/wide.css", bytes(".wide{}"));
    expect(text(fake.files.get(".obsidian-mobile/snippets/wide.css") ?? new Uint8Array())).toBe(".wide{}");
  });

  it("reports every change Obsidian sees in the config folder, and nothing outside it", () => {
    const fake = disk();
    const events: unknown[] = [];
    const stop = new ObsidianConfigAdapter(fake).watch((event) => events.push(event));
    fake.put(".obsidian/workspace.json", "{}");
    fake.put("note.md", "x");
    fake.put(".obsidianish/x.json", "x");
    stop();
    fake.put(".obsidian/hotkeys.json", "{}");

    expect(events).toEqual([{ type: "modify", path: "workspace.json" }]);
  });

  it("syncs a custom config folder with devices that use the default one, under the same server paths", async () => {
    const server = new InMemoryServer();
    const settings = { enabled: true, categories: { themes: true, snippets: true, hotkeys: true, pluginList: true, plugins: true } };
    const desktop = disk(".obsidian");
    const phone = disk(".obsidian-mobile");
    const device = (fake: FakeDisk, name: string) =>
      harness({ server, merge: "default", idPrefix: name, wrapVault: (notes) => new ConfigSyncVault({ notes, config: new ObsidianConfigAdapter(fake), settings }) });
    const a = device(desktop, "a");
    const b = device(phone, "b");
    desktop.put(".obsidian/hotkeys.json", "desktop hotkeys");
    desktop.put(".obsidian/workspace.json", "desktop layout");
    phone.put(".obsidian-mobile/workspace-mobile.json", "phone layout");

    await a.engine.push();
    await b.engine.push();

    expect([...server.liveFiles().keys()]).toEqual([".obsidian/hotkeys.json"]);
    expect(text(phone.files.get(".obsidian-mobile/hotkeys.json") ?? new Uint8Array())).toBe("desktop hotkeys");
    expect(phone.files.has(".obsidian-mobile/workspace.json")).toBe(false);
    expect(phone.files.has(".obsidian/hotkeys.json")).toBe(false);
  });
});

describe("reloadNotifier", () => {
  it("asks once to reload after a burst of plugin list and plugin changes, and never for files no category covers", () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const notify = reloadNotifier((message) => shown.push(message), 1000);

    notify("community-plugins.json");
    vi.advanceTimersByTime(999);
    notify("plugins/dataview/main.js");
    vi.advanceTimersByTime(999);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("the enabled plugin list, plugins");
    expect(shown[0]).toMatch(/Reload Obsidian/u);

    notify("hotkeys (conflict laptop 2026-10-18 040506).json");
    vi.advanceTimersByTime(1000);
    expect(shown).toHaveLength(1);
  });
});
