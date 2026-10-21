import { describe, expect, it } from "vitest";

import shared from "../../../../testdata/paths/vectors.json";
import { sha256Hex } from "../hash";
import { isVaultError, type VaultAdapter, type VaultEvent, type VaultListener } from "./adapter";
import { ConformanceFailure, runConformanceCase, vaultAdapterConformance, type ConformanceCase } from "./conformance";
import { InMemoryVault, type InodeEvent } from "./memory";

const fast = { eventTimeoutMs: 200, quietPeriodMs: 10 };

describe("InMemoryVault", () => {
  for (const platform of ["posix", "windows", "macos"] as const) {
    describe(`VaultAdapter conformance (${platform} path rules)`, () => {
      for (const testCase of vaultAdapterConformance) {
        it(testCase.name, async () => {
          await runConformanceCase(
            testCase,
            () => {
              const vault = new InMemoryVault({ pathRules: { platform } });
              return { adapter: vault, renameFolder: (from: string, to: string) => vault.renameFolder(from, to) };
            },
            fast,
          );
        });
      }
    });
  }

  describe("path rules", () => {
    const refusals = async (vault: InMemoryVault, path: string) => {
      const errors: unknown[] = [];
      await vault.write(path, new Uint8Array([1])).catch((error: unknown) => errors.push(error));
      await vault.write("ok.md", new Uint8Array([2]));
      await vault.rename("ok.md", path).catch((error: unknown) => errors.push(error));
      return errors;
    };

    for (const path of ["CON.md", "a:b.md", "trailing.", "notes./a.md", `${"a".repeat(256)}.md`]) {
      it(`refuses to write or rename to ${path.slice(0, 20)} under windows rules, and changes nothing`, async () => {
        const vault = new InMemoryVault({ pathRules: { platform: "windows" } });
        const events: VaultEvent[] = [];
        vault.watch((event) => events.push(event));
        const errors = await refusals(vault, path);
        expect(errors).toHaveLength(2);
        for (const error of errors) expect(isVaultError(error, "unmaterializable")).toBe(true);
        expect(await vault.list()).toEqual(["ok.md"]);
        expect(events).toEqual([{ type: "create", path: "ok.md" }]);
      });
    }

    it("accepts the same names under posix and macos rules", async () => {
      for (const platform of ["posix", "macos"] as const) {
        for (const path of ["CON.md", "a:b.md", "trailing."]) {
          const vault = new InMemoryVault({ pathRules: { platform } });
          await vault.write(path, new Uint8Array([1]));
          await vault.rename(path, `x${path}`);
          await vault.rename(`x${path}`, path);
          expect(await vault.list()).toEqual([path]);
        }
      }
    });

    it("counts the vault root in the path length", async () => {
      const vault = new InMemoryVault({ pathRules: { platform: "windows", root: `C:\\${"r".repeat(200)}` } });
      // 203 characters of root, a separator and 55 characters make 259, MAX_PATH less its terminator.
      await expect(vault.write(`${"a".repeat(52)}.md`, new Uint8Array())).resolves.toBeUndefined();
      await expect(vault.write(`${"a".repeat(53)}.md`, new Uint8Array())).rejects.toSatisfy((error) => isVaultError(error, "unmaterializable"));
    });

    it("renames the only file in a folder to the folder's name, in any spelling the platform matches", async () => {
      for (const [platform, target] of [
        ["posix", "notes"],
        ["windows", "NOTES"],
        ["macos", "Notes"],
      ] as const) {
        const vault = new InMemoryVault({ pathRules: { platform } });
        await vault.write("notes/f.md", new Uint8Array([1]));
        await vault.rename("notes/f.md", target);
        expect(await vault.list()).toEqual([target]);
      }
    });

    it("is case-sensitive under posix rules", async () => {
      const vault = new InMemoryVault();
      await vault.write("a.md", new Uint8Array([1]));
      await vault.write("A.md", new Uint8Array([2]));
      expect((await vault.list()).sort()).toEqual(["A.md", "a.md"]);
    });

    for (const platform of ["windows", "macos"] as const) {
      describe(`under ${platform} rules`, () => {
        it("finds a file by any spelling with the same path key, and keeps the name it was created with", async () => {
          const vault = new InMemoryVault({ pathRules: { platform } });
          const events: VaultEvent[] = [];
          vault.watch((event) => events.push(event));
          await vault.write("Notes/Straße.md", new Uint8Array([1]));
          expect(await vault.read("notes/STRASSE.md")).toEqual(new Uint8Array([1]));
          expect(await vault.stat("NOTES/strasse.md")).toEqual({ size: 1, mtime: expect.any(Number) as number });
          await vault.write("notes/strasse.md", new Uint8Array([2]));
          expect(await vault.list()).toEqual(["Notes/Straße.md"]);
          expect(await vault.read("Notes/Straße.md")).toEqual(new Uint8Array([2]));
          expect(events).toEqual([
            { type: "create", path: "Notes/Straße.md" },
            { type: "modify", path: "Notes/Straße.md" },
          ]);
        });

        it("refuses a rename onto another spelling of an existing file, but allows a case-only rename", async () => {
          const vault = new InMemoryVault({ pathRules: { platform } });
          await vault.write("a.md", new Uint8Array([1]));
          await vault.write("b.md", new Uint8Array([2]));
          await expect(vault.rename("b.md", "A.md")).rejects.toSatisfy((error) => isVaultError(error, "already-exists"));
          await vault.rename("a.md", "A.md");
          expect((await vault.list()).sort()).toEqual(["A.md", "b.md"]);
        });

        it("checks a write's or delete's precondition against the file of another spelling", async () => {
          const vault = new InMemoryVault({ pathRules: { platform } });
          await vault.write("Note.md", new Uint8Array([1]));
          const current = { expectedHash: sha256Hex(new Uint8Array([1])) };
          const other = { expectedHash: sha256Hex(new Uint8Array([9])) };
          await expect(vault.write("NOTE.md", new Uint8Array([2]), { expectedHash: null })).rejects.toSatisfy((error) => isVaultError(error, "changed"));
          await expect(vault.write("NOTE.md", new Uint8Array([2]), other)).rejects.toSatisfy((error) => isVaultError(error, "changed"));
          await expect(vault.delete("NOTE.MD", other)).rejects.toSatisfy((error) => isVaultError(error, "changed"));
          expect(await vault.read("Note.md")).toEqual(new Uint8Array([1]));
          await vault.write("NOTE.md", new Uint8Array([2]), current);
          expect(await vault.read("Note.md")).toEqual(new Uint8Array([2]));
          await vault.delete("NOTE.MD", { expectedHash: sha256Hex(new Uint8Array([2])) });
          expect(await vault.list()).toEqual([]);
        });

        it("treats a folder of another spelling as the same folder", async () => {
          const vault = new InMemoryVault({ pathRules: { platform } });
          await vault.write("notes/a.md", new Uint8Array([1]));
          await expect(vault.write("NOTES", new Uint8Array())).rejects.toSatisfy((error) => isVaultError(error, "path-conflict"));
          await vault.write("Notes/b.md", new Uint8Array([2]));
          await vault.delete("NOTES/A.MD");
          expect(await vault.list()).toEqual(["Notes/b.md"]);
        });

        // The server refuses two live documents whose path keys collide
        // (SPEC.md §5), and testdata/paths/vectors.json is the conformance
        // suite of its normalization, which internal/pathkey (Go) passes too.
        // A file found under another spelling is therefore exactly a file the
        // server keeps apart from no other.
        it("names one file by two of the shared vectors' paths exactly when the server gives them one path key", async () => {
          const paths = shared.vectors.map((vector) => vector.path).filter((path) => path !== "" && !path.endsWith("/") && path.split("/").every((segment) => segment !== ""));
          const keyOf = new Map(shared.vectors.map((vector) => [vector.path, vector.path_key]));
          let matched = 0;
          for (const first of paths) {
            for (const second of paths) {
              if (first.startsWith(`${second}/`) || second.startsWith(`${first}/`)) continue;
              const vault = new InMemoryVault({ pathRules: { platform } });
              // A vector the platform cannot hold at all says nothing about matching.
              const written = await vault.write(first, new Uint8Array([1])).then(
                () => true,
                (error: unknown) => {
                  if (isVaultError(error, "unmaterializable")) return false;
                  throw error;
                },
              );
              if (!written) continue;
              const found = (await vault.stat(second)) !== null;
              expect(found, `${JSON.stringify(first)} and ${JSON.stringify(second)}`).toBe(keyOf.get(first) === keyOf.get(second));
              if (found && first !== second) matched++;
            }
          }
          // The vectors must hold pairs that differ only by case or Unicode form, or this proves nothing.
          expect(matched).toBeGreaterThan(0);
        });
      });
    }
  });

  // Faithful filesystem (docs/design/engine-path-ownership.md §3.1, step R2):
  // the platform's own name equivalence F decides which spellings are one
  // file, not the server's path key. The expectations are written out per
  // case from what NTFS and APFS do, not derived from the vault's key.
  describe("faithful filesystem", () => {
    const faithful = (platform: "posix" | "windows" | "macos") => new InMemoryVault({ pathRules: { platform }, filesystem: "faithful" });
    const nfc = "Café.md";
    const nfd = "Café.md";

    for (const platform of ["posix", "windows", "macos"] as const) {
      describe(`VaultAdapter conformance (${platform} path rules)`, () => {
        for (const testCase of vaultAdapterConformance) {
          it(testCase.name, async () => {
            await runConformanceCase(
              testCase,
              () => {
                const vault = faithful(platform);
                return { adapter: vault, renameFolder: (from: string, to: string) => vault.renameFolder(from, to) };
              },
              fast,
            );
          });
        }
      });
    }

    // [first, second, one file under windows rules, one file under macos rules]
    const pairs: [string, string, boolean, boolean][] = [
      ["a.md", "A.md", true, true],
      ["Straße.md", "STRASSE.md", false, false],
      ["straße.md", "Straße.md", true, true],
      [nfc, nfd, false, true],
      [nfc, "CAFÉ.md", true, true],
      ["ı.md", "I.md", true, true],
      ["i.md", "ı.md", true, true],
      ["ß.md", "SS.md", false, false],
    ];
    for (const [first, second, windows, macos] of pairs) {
      for (const [platform, one] of [
        ["windows", windows],
        ["macos", macos],
        ["posix", first === second],
      ] as const) {
        it(`holds ${JSON.stringify(first)} and ${JSON.stringify(second)} as ${one ? "one file" : "two files"} under ${platform} rules`, async () => {
          const vault = faithful(platform);
          await vault.write(first, new Uint8Array([1]));
          expect((await vault.stat(second)) !== null).toBe(one);
          await vault.write(second, new Uint8Array([2]));
          expect((await vault.list()).sort()).toEqual(one ? [first] : [first, second].sort());
          expect(await vault.read(first)).toEqual(new Uint8Array([one ? 2 : 1]));
        });
      }
    }

    it("renames a file onto a spelling that is another file only if that file is absent, under windows rules", async () => {
      const vault = faithful("windows");
      await vault.write("Straße.md", new Uint8Array([1]));
      await vault.write("STRASSE.md", new Uint8Array([2]));
      await expect(vault.rename("Straße.md", "STRASSE.md")).rejects.toSatisfy((error) => isVaultError(error, "already-exists"));
      await vault.delete("STRASSE.md");
      await vault.rename("Straße.md", "STRASSE.md");
      expect(await vault.list()).toEqual(["STRASSE.md"]);
      expect(await vault.read("strasse.md")).toEqual(new Uint8Array([1]));
      await expect(vault.read("straße.md")).rejects.toSatisfy((error) => isVaultError(error, "not-found"));
    });

    it("keeps folders apart by the filesystem's names, not the path key, under macos rules", async () => {
      const vault = faithful("macos");
      await vault.write("straße/a.md", new Uint8Array([1]));
      await vault.write("STRASSE", new Uint8Array([2]));
      await vault.write("STRASSE2/b.md", new Uint8Array([3]));
      await expect(vault.write("Straße", new Uint8Array([4]))).rejects.toSatisfy((error) => isVaultError(error, "path-conflict"));
      await expect(vault.write("strasse/c.md", new Uint8Array([4]))).rejects.toSatisfy((error) => isVaultError(error, "path-conflict"));
      await expect(vault.renameFolder("STRASSE", "x")).rejects.toSatisfy((error) => isVaultError(error, "not-found"));
      await vault.renameFolder("STRAßE", "moved");
      expect((await vault.list()).sort()).toEqual(["STRASSE", "STRASSE2/b.md", "moved/a.md"]);
    });

    it("keeps the folded behaviour by default", async () => {
      const vault = new InMemoryVault({ pathRules: { platform: "windows" } });
      await vault.write("Straße.md", new Uint8Array([1]));
      await vault.write(nfc, new Uint8Array([1]));
      expect((await vault.stat("STRASSE.md")) !== null).toBe(true);
      expect((await vault.stat(nfd)) !== null).toBe(true);
    });
  });

  // Harness inodes (docs/design/engine-path-ownership.md §5.4): a create
  // mints an inode, a rename by anyone and a write keep it, a delete ends it.
  describe("harness inodes", () => {
    it("mints an inode on create, keeps it across writes and renames, and ends it on delete", async () => {
      const vault = new InMemoryVault({ pathRules: { platform: "windows" } });
      expect(vault.inodeOf("a.md")).toBeUndefined();
      await vault.write("a.md", new Uint8Array([1]));
      await vault.write("b.md", new Uint8Array([1]));
      const a = vault.inodeOf("a.md");
      const b = vault.inodeOf("b.md");
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a).not.toBe(b);
      expect(vault.inodeOf("A.MD")).toBe(a);
      await vault.write("a.md", new Uint8Array([2]));
      expect(vault.inodeOf("a.md")).toBe(a);
      await vault.rename("a.md", "A.md");
      expect(vault.inodeOf("A.md")).toBe(a);
      await vault.rename("A.md", "notes/c.md");
      expect(vault.inodeOf("notes/c.md")).toBe(a);
      await vault.renameFolder("notes", "Other");
      expect(vault.inodeOf("Other/c.md")).toBe(a);
      expect(vault.inodeOf("notes/c.md")).toBeUndefined();
      await vault.delete("Other/c.md");
      expect(vault.inodeOf("Other/c.md")).toBeUndefined();
      await vault.write("Other/c.md", new Uint8Array([1]));
      const recreated = vault.inodeOf("Other/c.md");
      expect(recreated).toBeDefined();
      expect([a, b]).not.toContain(recreated);
    });

    it("taps every change with its inode and the actor whose handle made it", async () => {
      const vault = new InMemoryVault({ pathRules: { platform: "macos" }, filesystem: "faithful" });
      const user = vault.handle("user");
      const engine = vault.handle("engine");
      const tapped: InodeEvent[] = [];
      const watched: VaultEvent[] = [];
      vault.tapInodes((event) => tapped.push(event));
      engine.watch((event) => watched.push(event));
      await user.write("a.md", new Uint8Array([1]));
      const inode = vault.inodeOf("a.md") ?? -1;
      await engine.write("a.md", new Uint8Array([2]));
      await engine.rename("a.md", "b.md");
      await expect(engine.rename("missing.md", "c.md")).rejects.toSatisfy((error) => isVaultError(error, "not-found"));
      // A change on the vault itself, right after the engine's refused one, is the user's.
      await vault.delete("b.md");
      await vault.write("c.md", new Uint8Array([3]));
      const other = vault.inodeOf("c.md") ?? -1;
      await engine.delete("c.md");
      expect(tapped).toEqual([
        { type: "create", path: "a.md", inode, actor: "user" },
        { type: "modify", path: "a.md", inode, actor: "engine" },
        { type: "rename", path: "b.md", oldPath: "a.md", inode, actor: "engine" },
        { type: "delete", path: "b.md", inode, actor: "user" },
        { type: "create", path: "c.md", inode: other, actor: "user" },
        { type: "delete", path: "c.md", inode: other, actor: "engine" },
      ]);
      // What a handle's watchers see is the plain event: the engine never sees inodes or actors.
      expect(watched).toEqual([
        { type: "create", path: "a.md" },
        { type: "modify", path: "a.md" },
        { type: "rename", path: "b.md", oldPath: "a.md" },
        { type: "delete", path: "b.md" },
        { type: "create", path: "c.md" },
        { type: "delete", path: "c.md" },
      ]);
    });

    it("attributes a folder rename's moves to the handle that made it", async () => {
      const vault = new InMemoryVault();
      await vault.write("n/a.md", new Uint8Array([1]));
      await vault.write("n/b.md", new Uint8Array([2]));
      const inodes = [vault.inodeOf("n/a.md"), vault.inodeOf("n/b.md")];
      const tapped: InodeEvent[] = [];
      vault.tapInodes((event) => tapped.push(event));
      await vault.handle("engine").renameFolder("n", "m");
      expect(tapped).toEqual([
        { type: "rename", path: "m/a.md", oldPath: "n/a.md", inode: inodes[0], actor: "engine" },
        { type: "rename", path: "m/b.md", oldPath: "n/b.md", inode: inodes[1], actor: "engine" },
      ]);
    });
  });

  it("uses the injected clock for mtimes", async () => {
    let now = 1_000;
    const vault = new InMemoryVault({ now: () => now });
    await vault.write("a.md", new Uint8Array([1]));
    now = 2_000;
    await vault.rename("a.md", "b.md");
    expect(await vault.stat("b.md")).toEqual({ size: 1, mtime: 1_000 });
    await vault.write("b.md", new Uint8Array([2]));
    expect(await vault.stat("b.md")).toEqual({ size: 1, mtime: 2_000 });
  });

  it("keeps state consistent when a listener throws", async () => {
    const vault = new InMemoryVault();
    const seen: string[] = [];
    const errors: unknown[] = [];
    vault.watch(() => {
      throw new Error("listener bug");
    });
    vault.watch((event) => seen.push(event.type));
    const reported = new Promise<void>((resolve) => {
      vault.onListenerError = (error) => {
        errors.push(error);
        resolve();
      };
    });

    await vault.write("a.md", new Uint8Array([1]));
    await reported;

    expect(await vault.list()).toEqual(["a.md"]);
    expect(seen).toEqual(["create"]);
    expect(errors).toHaveLength(1);
  });
});

/**
 * The conformance suite must catch broken adapters, or the Obsidian adapter
 * passing it would prove nothing. Each mutant breaks one contract.
 */
describe("VaultAdapter conformance suite", () => {
  class SilentVault extends InMemoryVault {
    // Accepts listeners but never calls them.
    override watch(): () => void {
      return () => undefined;
    }
  }

  class ClobberingVault extends InMemoryVault {
    override async rename(from: string, to: string): Promise<void> {
      if ((await this.stat(to)) !== null) await this.delete(to);
      await super.rename(from, to);
    }
  }

  class AliasingVault extends InMemoryVault {
    private readonly raw = new Map<string, Uint8Array>();
    override async write(path: string, data: Uint8Array): Promise<void> {
      await super.write(path, data);
      this.raw.set(path, data);
    }
    override async read(path: string): Promise<Uint8Array> {
      await super.read(path);
      return this.raw.get(path) ?? new Uint8Array();
    }
  }

  class LateDeleteVault extends InMemoryVault {
    // Reports deletes a task later than everything else, as a watcher that
    // queues some events might: each event arrives, but not in change order.
    override watch(listener: VaultListener): () => void {
      return super.watch((event) => {
        if (event.type === "delete") {
          setTimeout(() => {
            listener(event);
          }, 0);
        }
        else listener(event);
      });
    }
  }

  class FlatVault extends InMemoryVault {
    override async write(path: string, data: Uint8Array): Promise<void> {
      await super.write(path.replaceAll("/", "_"), data);
    }
  }

  const mutants: [string, () => VaultAdapter, string][] = [
    ["an adapter that never reports events", () => new SilentVault(), "changes are reported as events in order"],
    ["an adapter that reports a delete after the create that followed it", () => new LateDeleteVault(), "changes at one path are reported as events in the order they happened, a rename onto it too"],
    ["an adapter whose rename overwrites", () => new ClobberingVault(), "rename onto an existing file fails and changes nothing"],
    ["an adapter that aliases caller buffers", () => new AliasingVault(), "stored content is isolated from caller buffers"],
    ["an adapter that mangles folder paths", () => new FlatVault(), "write creates missing parent folders"],
  ];

  it("fails an adapter that reports a folder rename as creates and deletes", async () => {
    // Moves each file by copying it, as a sync tool without rename support would.
    class CopyingVault extends InMemoryVault {
      override async renameFolder(from: string, to: string): Promise<void> {
        for (const path of (await this.list()).filter((candidate) => candidate.startsWith(`${from}/`))) {
          await this.write(`${to}/${path.slice(from.length + 1)}`, await this.read(path));
          await this.delete(path);
        }
      }
    }
    const testCase = vaultAdapterConformance.find((candidate) => candidate.name === "a folder rename is reported as a rename of every file in it");
    expect(testCase).toBeDefined();
    if (testCase === undefined) return;
    const vault = new CopyingVault();
    await expect(runConformanceCase(testCase, () => ({ adapter: vault, renameFolder: (from, to) => vault.renameFolder(from, to) }), fast)).rejects.toBeInstanceOf(ConformanceFailure);
  });

  for (const [name, create, caseName] of mutants) {
    it(`fails ${name}`, async () => {
      const testCase = vaultAdapterConformance.find((candidate: ConformanceCase) => candidate.name === caseName);
      expect(testCase).toBeDefined();
      if (testCase === undefined) return;
      await expect(runConformanceCase(testCase, () => ({ adapter: create() }), fast)).rejects.toBeInstanceOf(ConformanceFailure);
    });
  }
});
