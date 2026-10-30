import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

import { argon2WorkerDefine } from "./scripts/argon2-worker.js";

// Plugin e2e suite: the built plugin inside a real, pinned Obsidian, driven by
// WebdriverIO through wdio-obsidian-service (SPEC.md §13,
// docs/testing/e2e.md). `make test-e2e` runs it through the `e2e`-tagged Go
// driver (cmd/vault-sync-server/e2e_test.go), which starts the server and
// passes its address and a test token in VAULT_SYNC_E2E_*.

// The Obsidian app version under test. The installer (the Electron binary) is
// the earliest one compatible with it, so this one line pins both.
// renovate: datasource=github-releases depName=obsidianmd/obsidian-releases
const obsidianVersion = "1.14.5";
export { obsidianVersion };

// The Obsidian version the Android job (wdio.android.conf.mts) installs, and
// the SHA-256 of its APK (Obsidian-<version>.apk in the obsidianmd/obsidian-
// releases release, as `gh api repos/obsidianmd/obsidian-releases/releases/
// tags/v<version>` reports its `digest`). Pinned separately from
// obsidianVersion because Obsidian publishes an APK only for some releases
// (none for 1.14.5). Bump both together, by hand, to a release that has one.
export const obsidianAndroidVersion = "1.14.4";
export const obsidianApkSha256 = "b3e5bfa107bb01c4c121d810622ff2de03fd298f55fcf6268b9db50186f192a3";

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

// VAULT_SYNC_ACCEPTANCE_RESULTS (`make acceptance`, scripts/acceptance.sh)
// runs only the spec files with an acceptance test, a test whose title starts
// with its checklist id (`[AC-04] ...`, docs/acceptance/phase-2.md, or
// `[P3-01] ...`, docs/acceptance/phase-3.md), and
// appends each test's result to e2e.jsonl in that directory for the
// scoreboard. Whole files run, not just the tagged tests: a spec's tests build
// on the ones before them.
const acceptanceResults = process.env.VAULT_SYNC_ACCEPTANCE_RESULTS;
const specDir = path.join(root, "test", "e2e", "specs");
const acceptanceSpecs = readdirSync(specDir)
  .filter((name) => name.endsWith(".e2e.ts") && !name.endsWith(".android.e2e.ts"))
  .filter((name) => /\bit\(\s*["'`]\[(?:AC|P3)-\d+\]/.test(readFileSync(path.join(specDir, name), "utf8")))
  .map((name) => `./test/e2e/specs/${name}`);

// VAULT_SYNC_E2E_SCREENSHOTS_DIR (`make docs-screenshots`,
// scripts/docs-screenshots.sh) runs only the spec that takes the user
// guide's screenshots of the settings tab, and writes them to that directory.
// Without it, that spec skips itself.
const screenshotsDir = process.env.VAULT_SYNC_E2E_SCREENSHOTS_DIR;
const screenshotSpecs = ["./test/e2e/specs/docs-screenshots.e2e.ts"];

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
  // The Argon2id Web Worker's script, as the release build inlines it.
  define: await argon2WorkerDefine(),
});
await copyFile(path.join(harnessDir, "manifest.json"), path.join(harnessOut, "manifest.json"));

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",
  specs: screenshotsDir !== undefined ? screenshotSpecs : acceptanceResults === undefined ? ["./test/e2e/specs/**/*.e2e.ts"] : acceptanceSpecs,
  // Device checks (process kill, background, airplane mode) need a real
  // Android device; only wdio.android.conf.mts runs them.
  exclude: ["./test/e2e/specs/**/*.android.e2e.ts"],
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
  ...(acceptanceResults === undefined
    ? {}
    : {
        afterTest(test: { title: string }, _context: unknown, result: { passed: boolean }) {
          appendFileSync(path.join(acceptanceResults, "e2e.jsonl"), `${JSON.stringify({ title: test.title, passed: result.passed })}\n`);
        },
      }),
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
};
