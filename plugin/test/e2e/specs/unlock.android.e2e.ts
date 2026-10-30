import { expect } from "@wdio/globals";

import { callHarness } from "../obsidian";

// The unlock timing on the Android emulator, recorded for the acceptance
// scoreboard: only wdio.android.conf.mts runs this file, and it records
// only the `*.android.e2e.ts` results. Unlocking derives Argon2id at the
// default 64 MiB and 3 passes in the Obsidian app's WebView.
describe("Passphrase unlock on Android", function () {
  it("[P4-15] unlocks on the Android emulator within a few seconds with Argon2id at 64 MiB and 3 passes, on WebAssembly", async function () {
    const timing = await callHarness("passphraseUnlockTiming");
    console.log(`passphrase unlock on Android: ${timing.milliseconds.toFixed(0)} ms, longest main-thread pause: ${timing.longestPauseMilliseconds.toFixed(0)} ms, Argon2id implementation: ${JSON.stringify(timing.implementation)}`);
    expect(timing.unlocked).toBe(true);
    expect(timing.implementation).toEqual({ kind: "webassembly" });
    expect(timing.milliseconds).toBeLessThan(5000);
  });
});
