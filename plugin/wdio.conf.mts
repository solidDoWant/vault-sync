import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

// Plugin e2e suite: the built plugin inside a real, pinned Obsidian, driven by
// WebdriverIO through wdio-obsidian-service (SPEC.md §13,
// docs/testing/e2e.md). `make test-e2e` runs it through the `e2e`-tagged Go
// driver (cmd/vault-sync-server/e2e_test.go), which starts the server and
// passes its address and a test token in VAULT_SYNC_E2E_*.

// The Obsidian app version under test. The installer (the Electron binary) is
// the earliest one compatible with it, so this one line pins both.
// renovate: datasource=github-releases depName=obsidianmd/obsidian-releases
const obsidianVersion = "1.14.4";

const root = path.dirname(fileURLToPath(import.meta.url));

// VAULT_SYNC_E2E_MOBILE=1 runs the suite with Obsidian's mobile emulation
// (app.emulateMobile on the desktop app; not a real Android device).
const emulateMobile = process.env.VAULT_SYNC_E2E_MOBILE === "1";

// VAULT_SYNC_E2E_LOG_DIR keeps a run's diagnostics in that directory: each
// worker's WebdriverIO log and a verbose chromedriver log that includes
// Obsidian's (Electron's) own stderr, so a lost renderer or a crashed
// Obsidian can be told apart afterwards (#457). CI uploads it when the job
// fails.
const logDir = process.env.VAULT_SYNC_E2E_LOG_DIR;

// Windows: render in software inside Obsidian's main process. On a loaded
// Windows runner (no GPU) Electron's separate GPU process kept dying until
// Chromium gave up and ended Obsidian with "GPU process isn't usable.
// Goodbye." (chromedriver: "Unable to receive message from renderer"), which
// failed whichever spec was running (#457). The specs check no pixels, so
// software rendering loses no coverage.
const gpuArgs = process.platform === "win32" ? ["--disable-gpu", "--in-process-gpu"] : [];

declare global {
  namespace WebdriverIO {
    // chromedriver flags WebdriverIO passes through (as `--verbose` and
    // `--enable-chrome-logs`) but does not type.
    interface ChromedriverOptions {
      verbose?: boolean;
      enableChromeLogs?: boolean;
    }
  }
}

// The test-only harness plugin (test/e2e/harness) is bundled here, so the
// suite always runs the harness that matches the checked-out sources.
const harnessDir = path.join(root, "test", "e2e", "harness");
const harnessOut = path.join(harnessDir, "dist");
await mkdir(harnessOut, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(harnessDir, "main.ts")],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2022",
  logLevel: "warning",
  outfile: path.join(harnessOut, "main.js"),
});
await copyFile(path.join(harnessDir, "manifest.json"), path.join(harnessOut, "manifest.json"));

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",
  specs: ["./test/e2e/specs/**/*.e2e.ts"],
  // One Obsidian at a time: the VM and CI runners are shared (CLAUDE.md).
  maxInstances: 1,
  capabilities: [
    {
      browserName: "obsidian",
      browserVersion: obsidianVersion,
      "wdio:obsidianOptions": {
        installerVersion: "earliest",
        // dist/ is the bundle `make plugin-build` produces (main.js +
        // manifest.json), i.e. exactly what users install.
        plugins: ["./dist", "./test/e2e/harness/dist"],
        vault: "./test/e2e/vaults/primary",
        emulateMobile,
      },
      ...(logDir === undefined ? {} : { "wdio:chromedriverOptions": { verbose: true, enableChromeLogs: true } }),
      "goog:chromeOptions": {
        args: gpuArgs,
        ...(emulateMobile ? { mobileEmulation: { deviceMetrics: { width: 390, height: 844 } } } : {}),
      },
    },
  ],
  services: ["obsidian"],
  reporters: ["obsidian"],
  cacheDir: process.env.VAULT_SYNC_E2E_CACHE_DIR ?? path.join(root, ".wdio-obsidian-cache"),
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
  // Fail rather than retry: a flaky e2e test is a bug to fix.
  specFileRetries: 0,
  bail: 0,
  logLevel: "warn",
  ...(logDir === undefined ? {} : { outputDir: logDir }),
  waitforTimeout: 30_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
};
