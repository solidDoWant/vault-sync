import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { copyOf, files, harness, testStamp, type Harness } from "../engine/testing";
import { InMemoryServer } from "../engine/memory-server";
import { runConformanceCase, vaultAdapterConformance } from "../vault/conformance";
import { InMemoryVault } from "../vault/memory";
import { ConfigSyncVault } from "./config-vault";
import { configReloadMessage, type ConfigCategory, type ConfigSyncSettings } from "./policy";

// Config folder sync through the engine (SPEC.md §8, #28): the notes vault
// and the config folder are in-memory vaults, the config folder's paths
// relative to it, as the Obsidian adapter gives them.

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

const none: Record<ConfigCategory, boolean> = { themes: false, snippets: false, hotkeys: false, pluginList: false, plugins: false };
const all: Record<ConfigCategory, boolean> = { themes: true, snippets: true, hotkeys: true, pluginList: true, plugins: true };

interface Device extends Harness {
  config: InMemoryVault;
  /** Config files sync wrote, renamed or deleted, relative to the config folder. */
  configChanges: string[];
  /** Changes the settings and restarts the engine over the same vaults and journal, as the plugin does. */
  reconfigure(settings: ConfigSyncSettings): void;
}

function device(server: InMemoryServer, settings: ConfigSyncSettings, name: string): Device {
  const config = new InMemoryVault();
  const configChanges: string[] = [];
  const state = { settings };
  const h = harness({
    server,
    merge: "default",
    idPrefix: name,
    deviceName: name,
    wrapVault: (notes) =>
      new ConfigSyncVault({
        notes,
        config,
        settings: state.settings,
        ownFolders: ["plugins/vault-sync"],
        onConfigChange: (relative) => configChanges.push(relative),
      }),
  });
  return Object.assign(h, {
    config,
    configChanges,
    reconfigure(next: ConfigSyncSettings) {
      state.settings = next;
      h.restart();
    },
  });
}

/** A typical config folder: settings, layout, a theme, a snippet and two plugins, one of them vault-sync. */
async function typicalConfig(config: InMemoryVault): Promise<void> {
  const contents: Record<string, string> = {
    "app.json": '{"vimMode":true}',
    "appearance.json": '{"cssTheme":"Minimal"}',
    "hotkeys.json": '{"editor:toggle-bold":[]}',
    "community-plugins.json": '["dataview","vault-sync"]',
    "core-plugins.json": '{"graph":true}',
    "workspace.json": '{"main":{}}',
    "workspace-mobile.json": '{"main":{}}',
    "workspaces.json": '{"workspaces":{}}',
    "graph.json": '{"scale":1}',
    "themes/Minimal/theme.css": "body{}",
    "snippets/wide.css": ".wide{}",
    "plugins/dataview/main.js": "module.exports = {};",
    "plugins/dataview/data.json": "{}",
    "plugins/vault-sync/main.js": "module.exports = {};",
    "plugins/vault-sync/data.json": '{"refreshToken":"secret"}',
  };
  for (const [path, content] of Object.entries(contents)) await config.write(path, bytes(content));
}

const off: ConfigSyncSettings = { enabled: false, categories: all };
const everything: ConfigSyncSettings = { enabled: true, categories: all };

/** The server's live config paths. */
function serverConfig(server: InMemoryServer): string[] {
  return [...server.liveFiles().keys()].filter((path) => path.startsWith(".obsidian/")).sort();
}

/** Every CommitRevision from now on, by path. */
function commits(server: InMemoryServer): string[] {
  const paths: string[] = [];
  const previous = server.interceptor;
  server.interceptor = (method, request) => {
    previous?.(method, request);
    if (method === "CommitRevision") paths.push(new TextDecoder().decode((request as { path: Uint8Array }).path));
  };
  return paths;
}

describe("config folder sync (SPEC.md §8)", () => {
  describe("with config sync off (the default)", () => {
    it("pushes nothing under the config folder", async () => {
      const server = new InMemoryServer();
      const a = device(server, off, "a");
      await typicalConfig(a.config);
      await a.vault.write("note.md", bytes("note"));

      await a.engine.push();

      expect([...server.liveFiles().keys()]).toEqual(["note.md"]);
    });

    it("writes no remote config file and leaves the local config folder as it is", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "hotkeys", path: ".obsidian/hotkeys.json", content: "remote" });
      server.commit({ documentId: "theme", path: ".obsidian/themes/T/theme.css", content: "remote" });
      server.commit({ documentId: "note", path: "note.md", content: "note" });
      const b = device(server, off, "b");
      await b.config.write("hotkeys.json", bytes("local"));

      const summary = await b.engine.pull();
      await b.engine.push();

      expect(await files(b.config)).toEqual(new Map([["hotkeys.json", "local"]]));
      expect(await files(b.vault)).toEqual(new Map([["note.md", "note"]]));
      expect(summary).toMatchObject({ applied: 1, deferred: 2 });
      expect(b.configChanges).toEqual([]);
      expect(server.head("hotkeys")?.seq).toBe(1n);
    });

    it("applies the config revisions that arrived while off once config sync is turned on", async () => {
      const server = new InMemoryServer();
      server.commit({ documentId: "hotkeys", path: ".obsidian/hotkeys.json", content: "remote" });
      const b = device(server, off, "b");
      await b.engine.push();
      expect(await files(b.config)).toEqual(new Map());

      b.reconfigure(everything);
      await b.engine.push();

      expect(await files(b.config)).toEqual(new Map([["hotkeys.json", "remote"]]));
      expect(b.configChanges).toEqual(["hotkeys.json"]);
    });
  });

  describe("with config sync on", () => {
    it("syncs only the paths of the enabled categories", async () => {
      const server = new InMemoryServer();
      const a = device(server, { enabled: true, categories: { ...none, hotkeys: true, snippets: true } }, "a");
      await typicalConfig(a.config);

      await a.engine.push();

      expect(serverConfig(server)).toEqual([".obsidian/appearance.json", ".obsidian/hotkeys.json", ".obsidian/snippets/wide.css"]);
    });

    it("never syncs workspace*.json, graph.json or this plugin's own folder, with every category on", async () => {
      const server = new InMemoryServer();
      const a = device(server, everything, "a");
      await typicalConfig(a.config);

      await a.engine.push();

      expect(serverConfig(server)).toEqual([
        ".obsidian/appearance.json",
        ".obsidian/community-plugins.json",
        ".obsidian/core-plugins.json",
        ".obsidian/hotkeys.json",
        ".obsidian/plugins/dataview/data.json",
        ".obsidian/plugins/dataview/main.js",
        ".obsidian/snippets/wide.css",
        ".obsidian/themes/Minimal/theme.css",
      ]);
    });

    it("never writes a remote workspace file or this plugin's own data, with every category on", async () => {
      const server = new InMemoryServer();
      // As another client could commit them.
      server.commit({ documentId: "workspace", path: ".obsidian/workspace.json", content: "remote layout" });
      server.commit({ documentId: "mobile", path: ".obsidian/workspace-mobile.json", content: "remote layout" });
      server.commit({ documentId: "data", path: ".obsidian/plugins/vault-sync/data.json", content: '{"serverUrl":"https://evil.example"}' });
      server.commit({ documentId: "code", path: ".obsidian/plugins/vault-sync/main.js", content: "evil()" });
      server.commit({ documentId: "case", path: ".obsidian/plugins/Vault-Sync/data.json", content: "evil" });
      const b = device(server, everything, "b");
      await b.config.write("workspace.json", bytes("local layout"));
      await b.config.write("plugins/vault-sync/data.json", bytes('{"refreshToken":"secret"}'));

      await b.engine.push();

      expect(await files(b.config)).toEqual(
        new Map([
          ["plugins/vault-sync/data.json", '{"refreshToken":"secret"}'],
          ["workspace.json", "local layout"],
        ]),
      );
      expect(b.configChanges).toEqual([]);
    });

    it("uploads nothing when only the layout changes, as on a pane switch", async () => {
      const server = new InMemoryServer();
      const a = device(server, everything, "a");
      await typicalConfig(a.config);
      await a.engine.push();
      const committed = commits(server);
      a.localChanges.length = 0;

      await a.config.write("workspace.json", bytes('{"main":{"active":"other"}}'));
      await a.config.write("workspace-mobile.json", bytes('{"main":{"active":"other"}}'));
      await a.config.write("graph.json", bytes('{"scale":2}'));
      await a.engine.push();

      expect(committed).toEqual([]);
      expect(a.localChanges.filter((event) => event.path.startsWith(".obsidian/"))).toEqual([]);
    });

    it("pushes an edit of a synced config file and applies it on another device, which is told to reload", async () => {
      const server = new InMemoryServer();
      const a = device(server, everything, "a");
      const b = device(server, everything, "b");
      await a.config.write("community-plugins.json", bytes('["dataview"]'));
      await a.engine.push();
      await b.engine.push();
      expect(await files(b.config)).toEqual(new Map([["community-plugins.json", '["dataview"]']]));

      await a.config.write("community-plugins.json", bytes('["dataview","calendar"]'));
      await a.engine.push();
      b.configChanges.length = 0;
      await b.engine.pull();

      expect(await files(b.config)).toEqual(new Map([["community-plugins.json", '["dataview","calendar"]']]));
      expect(b.configChanges).toEqual(["community-plugins.json"]);
      expect(configReloadMessage(b.configChanges)).toContain("Reload Obsidian");
    });

    it("keeps the local version of a config file both devices have as a conflict copy that stays on the device", async () => {
      const server = new InMemoryServer();
      const a = device(server, everything, "a");
      const b = device(server, everything, "b");
      await a.config.write("hotkeys.json", bytes("a's hotkeys"));
      await b.config.write("hotkeys.json", bytes("b's hotkeys"));
      // A file no category covers, at the name the copy would get first: it is there, though it does not sync.
      await b.config.write(copyOf("hotkeys", ".json", "b"), bytes("an earlier copy"));
      await a.engine.push();

      await b.engine.push();

      expect(await files(b.config)).toEqual(
        new Map([
          [copyOf("hotkeys", ".json", "b"), "an earlier copy"],
          [`hotkeys (conflict b ${testStamp} 2).json`, "b's hotkeys"],
          ["hotkeys.json", "a's hotkeys"],
        ]),
      );
      expect(serverConfig(server)).toEqual([".obsidian/hotkeys.json"]);
    });
  });

  describe("turning config sync off, or a category", () => {
    it("never deletes the synced config files on the server or another device", async () => {
      const server = new InMemoryServer();
      const a = device(server, everything, "a");
      await typicalConfig(a.config);
      await a.engine.push();
      const synced = serverConfig(server);
      const committed = commits(server);

      a.reconfigure({ enabled: true, categories: { ...all, plugins: false } });
      await a.engine.push();
      a.reconfigure(off);
      await a.engine.push();

      expect(committed).toEqual([]);
      expect(serverConfig(server)).toEqual(synced);
    });

    it("does not apply later remote changes of those files, until turned on again", async () => {
      const server = new InMemoryServer();
      const a = device(server, everything, "a");
      const b = device(server, everything, "b");
      await a.config.write("hotkeys.json", bytes("v1"));
      await a.engine.push();
      await b.engine.push();
      b.reconfigure(off);
      await a.config.write("hotkeys.json", bytes("v2"));
      await a.config.delete("hotkeys.json");
      await a.config.write("snippets/new.css", bytes("new"));
      await a.engine.push();

      await b.engine.push();
      expect(await files(b.config)).toEqual(new Map([["hotkeys.json", "v1"]]));

      b.reconfigure(everything);
      await b.engine.push();
      expect(await files(b.config)).toEqual(new Map([["snippets/new.css", "new"]]));
    });

    it("does not send a config change left pending from before it was turned off", async () => {
      const server = new InMemoryServer();
      const a = device(server, everything, "a");
      await a.config.write("hotkeys.json", bytes("v1"));
      server.interceptor = (method) => {
        if (method === "CommitRevision") throw new ConnectError("connection lost", Code.Unavailable);
      };
      await a.engine.push().catch(() => undefined);
      expect(await a.journal.listPending()).toHaveLength(1);
      server.interceptor = undefined;

      a.reconfigure(off);
      await a.engine.push();

      expect(serverConfig(server)).toEqual([]);
      expect(await a.journal.listPending()).toHaveLength(1);
      a.reconfigure(everything);
      await a.engine.push();
      expect(serverConfig(server)).toEqual([".obsidian/hotkeys.json"]);
    });

    it("pushes no local edit of a config file made while off, and pushes it once turned on again", async () => {
      const server = new InMemoryServer();
      const a = device(server, everything, "a");
      await a.config.write("hotkeys.json", bytes("v1"));
      await a.engine.push();
      a.reconfigure(off);
      await a.config.write("hotkeys.json", bytes("edited while off"));
      await a.engine.push();
      expect(server.liveFiles().get(".obsidian/hotkeys.json")).toBe("v1");

      a.reconfigure(everything);
      await a.engine.push();
      expect(server.liveFiles().get(".obsidian/hotkeys.json")).toBe("edited while off");
    });
  });

  describe("a vault with a sync scope (VaultAdapter.isSynced)", () => {
    it("pushes a move out of the scope as a delete, never as a rename to the excluded path", async () => {
      const h = harness({ wrapVault: (vault) => Object.assign(Object.create(vault) as InMemoryVault, { isSynced: (path: string) => !path.startsWith("excluded/") }) });
      await h.vault.write("a.md", bytes("a"));
      await h.engine.push();
      const committed = commits(h.server);

      await h.vault.rename("a.md", "excluded/a.md");
      await h.engine.push();

      expect(committed).toEqual(["a.md"]);
      expect([...h.server.liveFiles().keys()]).toEqual([]);
    });
  });

  describe("as a VaultAdapter for the notes", () => {
    for (const testCase of vaultAdapterConformance) {
      it(`passes the conformance case: ${testCase.name}`, async () => {
        await runConformanceCase(testCase, () => {
          const notes = new InMemoryVault();
          return {
            adapter: new ConfigSyncVault({ notes, config: new InMemoryVault(), settings: everything }),
            renameFolder: (from, to) => notes.renameFolder(from, to),
          };
        });
      });
    }

    it("refuses moves between the notes and the config folder", async () => {
      const notes = new InMemoryVault();
      const config = new InMemoryVault();
      const vault = new ConfigSyncVault({ notes, config, settings: everything });
      await vault.write("note.md", bytes("x"));
      await vault.write(".obsidian/hotkeys.json", bytes("y"));

      await expect(vault.rename("note.md", ".obsidian/snippets/note.css")).rejects.toMatchObject({ code: "path-conflict" });
      await expect(vault.rename(".obsidian/hotkeys.json", "hotkeys.json")).rejects.toMatchObject({ code: "path-conflict" });
      expect(await files(notes)).toEqual(new Map([["note.md", "x"]]));
      expect(await files(config)).toEqual(new Map([["hotkeys.json", "y"]]));
    });

    it("never touches the config folder while config sync is off", async () => {
      const notes = new InMemoryVault();
      const config = new InMemoryVault();
      await config.write("hotkeys.json", bytes("local"));
      const calls: string[] = [];
      const watched = new Proxy(config, {
        get: (target, property, receiver) => {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            calls.push(String(property));
            return (value as (...values: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const vault = new ConfigSyncVault({ notes, config: watched, settings: off });
      vault.watch(() => undefined)();

      expect(await vault.list()).toEqual([]);
      expect(await vault.stat(".obsidian/hotkeys.json")).toBeNull();
      await expect(vault.read(".obsidian/hotkeys.json")).rejects.toMatchObject({ code: "not-found" });
      await expect(vault.write(".obsidian/hotkeys.json", bytes("remote"))).rejects.toMatchObject({ code: "path-conflict" });
      await expect(vault.delete(".obsidian/hotkeys.json")).rejects.toMatchObject({ code: "not-found" });
      await expect(vault.rename(".obsidian/hotkeys.json", ".obsidian/hotkeys2.json")).rejects.toMatchObject({ code: "not-found" });
      expect(calls).toEqual([]);
      expect(await files(config)).toEqual(new Map([["hotkeys.json", "local"]]));
    });
  });
});
