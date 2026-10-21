import { execFileSync } from "node:child_process";
import path from "node:path";

import { config as base } from "./wdio.conf.mjs";

// SPIKE (#187), throwaway: the e2e suite on the real Obsidian Android app in
// an already booted Android emulator, through Appium UiAutomator2. The
// experimental workflow (.github/workflows/android-spike.yml) boots the
// emulator, verifies the APK's checksum and passes it in
// VAULT_SYNC_E2E_ANDROID_APK.

const apk = process.env.VAULT_SYNC_E2E_ANDROID_APK;
if (apk === undefined || apk === "") throw new Error("VAULT_SYNC_E2E_ANDROID_APK is not set");

const adb = path.join(process.env.ANDROID_HOME ?? "", "platform-tools", "adb");
const baseCapability = (base.capabilities as WebdriverIO.Capabilities[])[0] ?? {};
const baseOptions = baseCapability["wdio:obsidianOptions"] ?? {};

export const config: WebdriverIO.Config = {
  ...base,
  specs: process.env.VAULT_SYNC_E2E_SPECS ? process.env.VAULT_SYNC_E2E_SPECS.split(",") : base.specs,
  capabilities: [
    {
      browserName: "obsidian",
      browserVersion: baseCapability.browserVersion,
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:udid": "emulator-5554",
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
  services: [
    "obsidian",
    ["appium", { args: { allowInsecure: "*:chromedriver_autodownload,*:adb_shell" } }],
  ],
  onPrepare() {
    // The device reaches the harness's server and fake issuer at the same
    // 127.0.0.1 addresses as the host.
    for (const name of ["VAULT_SYNC_E2E_SERVER_URL", "VAULT_SYNC_E2E_ISSUER_URL"]) {
      const port = new URL(process.env[name] ?? "").port;
      execFileSync(adb, ["-s", "emulator-5554", "reverse", `tcp:${port}`, `tcp:${port}`], { stdio: "inherit" });
    }
  },
};
