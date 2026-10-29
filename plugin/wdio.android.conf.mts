import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { config as base, obsidianApkSha256, obsidianVersion } from "./wdio.conf.mjs";

// The e2e suite on the real Obsidian Android app (docs/testing/e2e.md,
// "Android emulator job"), in an Android emulator that is already booted
// (the android-e2e workflow boots one), through Appium's UiAutomator2
// driver. `VAULT_SYNC_E2E_ANDROID=1 make test-e2e` makes the Go driver use
// this configuration. It runs every spec the desktop configuration runs, and
// the device checks (`*.android.e2e.ts`) that need a real device.

/** The device under test: `ANDROID_SERIAL`, or the first emulator. */
export const androidSerial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const adb = process.env.ANDROID_HOME === undefined ? "adb" : path.join(process.env.ANDROID_HOME, "platform-tools", "adb");
const root = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = base.cacheDir ?? path.join(root, ".wdio-obsidian-cache");

// Appium, its UiAutomator2 driver and WebdriverIO's Appium service are a
// separate npm project (test/e2e/android/package.json, with its own lock
// file), so only this job installs them: `npm ci --prefix
// test/e2e/android`. Appium 3 finds drivers listed in APPIUM_HOME's
// package.json.
const androidTools = path.join(root, "test", "e2e", "android");
process.env.APPIUM_HOME = androidTools;
const appiumService = (await import(pathToFileURL(path.join(androidTools, "node_modules", "@wdio", "appium-service", "build", "index.js")).href).catch((error: unknown) => {
  throw new Error(`the Android tools are not installed; run \`npm ci --prefix test/e2e/android\` in plugin/ (${String(error)})`);
})) as { launcher: new (...args: never[]) => WebdriverIO.ServiceInstance };

/**
 * The APK of the Obsidian version wdio.conf.mts pins, from Obsidian's own
 * release, downloaded once into the cache. Its SHA-256 is checked against
 * the pinned value on every run, cached or not, before Appium may install
 * it: wdio-obsidian-service does not check it.
 */
async function verifiedApk(): Promise<string> {
  const directory = path.join(cacheDir, "android");
  const apk = path.join(directory, `Obsidian-${obsidianVersion}.apk`);
  let content = await readFile(apk).catch(() => undefined);
  if (content === undefined) {
    const url = `https://github.com/obsidianmd/obsidian-releases/releases/download/v${obsidianVersion}/Obsidian-${obsidianVersion}.apk`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`downloading ${url}: HTTP ${String(response.status)}`);
    content = Buffer.from(await response.arrayBuffer());
    await mkdir(directory, { recursive: true });
    const partial = `${apk}.partial`;
    await writeFile(partial, content);
    await rename(partial, apk);
  }
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== obsidianApkSha256) {
    // A tampered or truncated download, or a version bump without its hash:
    // drop it, so the next run downloads it again, and install nothing.
    await rm(apk, { force: true });
    throw new Error(`Obsidian-${obsidianVersion}.apk has SHA-256 ${digest}, not the pinned ${obsidianApkSha256} (wdio.conf.mts, obsidianApkSha256)`);
  }
  return apk;
}

// VAULT_SYNC_ACCEPTANCE_RESULTS appends the result of each device check (the
// tests in `*.android.e2e.ts`, which only this configuration runs) to
// android-e2e.jsonl in that directory, for the acceptance scoreboard
// (scripts/acceptance.sh): the android-e2e workflow uploads it, and the
// acceptance workflow reads the latest one from master. Unlike the desktop
// configuration, every spec still runs, and the shared specs' results stay
// out of it: the desktop run reports those.
const acceptanceResults = process.env.VAULT_SYNC_ACCEPTANCE_RESULTS;

const apk = await verifiedApk();
const baseCapability = (base.capabilities as WebdriverIO.Capabilities[])[0] ?? {};
const baseOptions = baseCapability["wdio:obsidianOptions"] ?? {};

export const config: WebdriverIO.Config = {
  ...base,
  // Every spec, including the device checks the desktop configuration excludes.
  specs: ["./test/e2e/specs/**/*.e2e.ts"],
  exclude: [],
  ...(acceptanceResults === undefined
    ? {}
    : {
        afterTest(test: { title: string; file: string }, _context: unknown, result: { passed: boolean }) {
          if (!test.file.endsWith(".android.e2e.ts")) return;
          appendFileSync(path.join(acceptanceResults, "android-e2e.jsonl"), `${JSON.stringify({ title: test.title, passed: result.passed })}\n`);
        },
      }),
  capabilities: [
    {
      browserName: "obsidian",
      browserVersion: obsidianVersion,
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:udid": androidSerial,
      "appium:app": apk,
      "appium:noReset": true,
      "appium:adbExecTimeout": 120_000,
      "appium:uiautomator2ServerLaunchTimeout": 120_000,
      "appium:uiautomator2ServerInstallTimeout": 120_000,
      "appium:androidInstallTimeout": 300_000,
      "wdio:obsidianOptions": {
        plugins: baseOptions.plugins,
        vault: baseOptions.vault,
      },
    },
  ],
  services: ["obsidian", [appiumService.launcher, { args: { allowInsecure: "*:chromedriver_autodownload,*:adb_shell" } }]],
  mochaOpts: { ...base.mochaOpts, timeout: 300_000 },
  onPrepare() {
    // The device reaches the harness-started server and the fake issuer at
    // the host's 127.0.0.1 addresses through adb. The network checks
    // (device.android.e2e.ts) reach the server over the emulator's own
    // network instead (10.0.2.2), which airplane mode cuts.
    for (const name of ["VAULT_SYNC_E2E_SERVER_URL", "VAULT_SYNC_E2E_ISSUER_URL"]) {
      const port = new URL(process.env[name] ?? "").port;
      execFileSync(adb, ["-s", androidSerial, "reverse", `tcp:${port}`, `tcp:${port}`], { stdio: "inherit" });
    }
  },
};
