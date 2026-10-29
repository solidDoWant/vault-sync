import { expect } from "@wdio/globals";

import { callHarness } from "../obsidian";

// Unlocking derives Argon2id at the default 64 MiB and 3 passes on the
// device's own JavaScript engine. On the Android emulator job this is the
// Obsidian app's WebView; on desktop, Electron's renderer.
describe("Passphrase unlock", function () {
  it("[P4-15] unlocks within a few seconds with Argon2id at 64 MiB and 3 passes, on WebAssembly", async function () {
    const timing = await callHarness("passphraseUnlockTiming");
    console.log(`passphrase unlock: ${timing.milliseconds.toFixed(0)} ms, longest main-thread pause: ${timing.longestPauseMilliseconds.toFixed(0)} ms, Argon2id implementation: ${JSON.stringify(timing.implementation)}`);
    expect(timing.unlocked).toBe(true);
    expect(timing.implementation).toEqual({ kind: "webassembly" });
    expect(timing.milliseconds).toBeLessThan(5000);
  });
});
