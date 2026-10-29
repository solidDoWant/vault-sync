import { expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";

import { e2eEnvironment } from "../environment";
import { callHarness } from "../obsidian";

// The local platform's path rules reach the engine from vault-sync's own
// startSync (src/main.ts → SyncSession → engine), and the Obsidian adapter
// turns an OS refusal of a name into "unmaterializable" (#418). The reason
// the engine reports tells the two apart: a path the rules refuse has the
// rule's reason, and one only the file system refuses has "refused-by-vault".

/**
 * A vault-relative path of exactly `length` UTF-8 bytes, in folders of 200
 * characters: within the platform's PATH_MAX on its own, but not once the
 * vault folder's absolute path is counted too.
 */
function pathOfLength(length: number): string {
  const segments: string[] = [];
  let remaining = length - ".md".length;
  while (remaining > 201) {
    segments.push("p".repeat(200));
    remaining -= 201;
  }
  segments.push(`${"n".repeat(remaining)}.md`);
  return segments.join("/");
}

describe("Platform path rules", function () {
  it("reach the engine from vault-sync's session, with the vault folder counted", async function () {
    await callHarness("setUpSession");
    // The device's platform, not the host's: on the Android job the host is
    // Linux and the app runs in an emulator.
    const platform = await obsidianPage.getPlatform();
    expect(platform.isAndroidApp).toBe(e2eEnvironment.android);
    // The server accepts only portable paths of at most 1024 bytes (engine.md §6), so only
    // a path too long for the device once its vault folder is counted is one the rules refuse.
    // Linux (PATH_MAX 4096) and Android hold every such path.
    if (!platform.isWin && !platform.isMacOS) this.skip();
    const root = await callHarness("vaultBasePath");
    expect(root).not.toBeNull();
    // Windows: MAX_PATH, 260 UTF-16 code units less its terminator; macOS: PATH_MAX, 1023 bytes.
    const pathMax = platform.isWin ? 259 : 1023;
    const path = pathOfLength(pathMax);
    expect(new TextEncoder().encode(path).length + new TextEncoder().encode(root ?? "").length + 1).toBeGreaterThan(pathMax);
    const reason = "path-too-long";
    await callHarness("commitRemote", "doc-platform", path, "a path this device cannot hold\n");
    await callHarness("startSession");

    expect(await callHarness("sessionUnmaterializable")).toEqual([{ path, reason }]);
    expect(Object.keys(await callHarness("vaultFiles"))).toEqual(["Synced.md"]);
  });

  it("let the adapter report a name the file system refuses as unmaterializable", async function () {
    // A 300-byte name, over every platform's 255. The engine's rules would
    // refuse it before writing, so the adapter is called directly.
    const name = `${"n".repeat(297)}.md`;
    expect(await callHarness("writeThroughAdapter", name, "too long a name\n")).toBe(`VaultError: unmaterializable: ${name}`);
    // Not yet on Android: its mkdir failure is not classified (#725).
    if (!e2eEnvironment.android) {
      expect(await callHarness("writeThroughAdapter", `${"f".repeat(300)}/note.md`, "too long a folder name\n")).toBe(`VaultError: unmaterializable: ${"f".repeat(300)}/note.md`);
    }
    expect(await callHarness("writeThroughAdapter", "Renamed.md", "renamed to too long a name\n")).toBe("ok");
    // Not yet on Android: its rename failure is not classified (#725).
    if (!e2eEnvironment.android) {
      expect(await callHarness("renameThroughAdapter", "Renamed.md", name)).toBe(`VaultError: unmaterializable: ${name}`);
      expect(await callHarness("vaultFiles")).toHaveProperty(["Renamed.md"], "renamed to too long a name\n");
    }
  });
});
