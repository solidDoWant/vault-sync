# Android release checklist

For: the person who releases vault-sync, and developers who change what the plugin does on Android.

Android is a required client (`SPEC.md` §2). Before each release, a person runs the manual checks on this page on a physical Android device. Everything that an automated suite can check is an automated test instead. Those tests run in CI, so they need no action at release time. Each section lists them in one line, so that you can see what is covered.

Some checks stay manual. The emulated-mobile e2e job (`VAULT_SYNC_E2E_MOBILE=1`, `docs/testing/e2e.md`) runs desktop Obsidian with the mobile UI. It never uses the Android WebView, Capacitor's filesystem, BRAT on Android, Android pausing or killing the app, real network changes or the battery. The Android emulator job (`plugin-e2e (android-emulator)`, "Android emulator job" in `e2e.md`) runs the real Android app in an emulator. It runs every e2e spec, plus [`device.android.e2e.ts`](../../plugin/test/e2e/specs/device.android.e2e.ts), which kills the app's process, sends it to the background, has Android destroy its activity and cuts the network. BRAT, the browser and clipboard, battery use and large-vault performance stay manual.

## Before you start

- A physical Android phone with the BRAT community plugin and the Obsidian version that the release supports (`minAppVersion` in `plugin/manifest.json` or newer). Write the phone model, the Android version and the Obsidian version in the release notes.
- A vault-sync server for the release, reachable over `https` from the phone's Wi-Fi and from mobile data, with its identity provider set up as in `docs/plugin.md`.
- A test account, and a desktop Obsidian signed in to that account with a test vault connected. You use it to make remote changes and to see what arrives.
- For the large-vault check, a vault of at least 5,000 notes and 500 MB of attachments (images, PDFs) on the server.

Mark each manual check passed or failed, with a note for every failure. A failed check blocks the release until it is fixed or the project owner accepts it.

## 1. Install via BRAT

Automated: the manifest allows mobile and the bundle loads no Node built-in or Electron ([`plugin/test/mobile.test.ts`](../../plugin/test/mobile.test.ts)). The built plugin loads and enables in the mobile UI and in the Android app ([`smoke.e2e.ts`](../../plugin/test/e2e/specs/smoke.e2e.ts)).

| Manual check | Expected result | Why manual |
|---|---|---|
| In BRAT, add the release's repository (`solidDoWant/vault-sync`), install the release under test and enable Vault Sync. Restart Obsidian. | BRAT installs the release's version. Vault Sync is enabled after the restart, with no error notice, and **Settings → Vault Sync** opens. | BRAT downloads the GitHub release into the Android app's storage only in the real app. |

## 2. Sign-in

Automated: the device flow, a reload, a revoked refresh token and sign-out ([`signin.e2e.ts`](../../plugin/test/e2e/specs/signin.e2e.ts)). Polling through network failures and a provider outage ([`oidc.test.ts`](../../plugin/src/core/auth/oidc.test.ts), [`tokens.test.ts`](../../plugin/src/core/auth/tokens.test.ts)).

| Manual check | Expected result | Why manual |
|---|---|---|
| On the phone, fill in the settings, tap **Sign in**, then **Open page**. Approve the code in the phone's browser and switch back to Obsidian. | The browser opens the verification page. Back in Obsidian, the dialog closes by itself within a few seconds, and **Vault Sync: Show sync status** shows `no vault connected`. | The browser sends Obsidian to the background, and only Android decides if its polling keeps running there. |
| On the phone, tap **Copy code** and paste it into the verification page in the browser. | The pasted code is the one that the dialog shows. | The Android clipboard is only in the real app. |

## 3. Initial sync of a large vault

Automated: a first sync pulls every page and download range, an interrupted first sync resumes ([`engine.test.ts`](../../plugin/src/core/sync/engine.test.ts), [`crash.test.ts`](../../plugin/src/core/sync/crash.test.ts)), and connecting a vault through a real server asks first when both sides have files ([`sync.e2e.ts`](../../plugin/test/e2e/specs/sync.e2e.ts)).

| Manual check | Expected result | Why manual |
|---|---|---|
| On the phone, create an empty vault, sign in and connect it to the large test vault. Keep Obsidian in the foreground until **Show sync status** shows `idle`. | Sync finishes with `idle`, `0 pending`. The file count and total size in the phone's vault match the server's. Obsidian stays responsive, does not crash or reload, and Android shows no "app isn't responding" dialog. | Memory, storage speed and WebView limits are those of a real phone. |

## 4. Offline edits

Automated, no manual check: an edit made offline stays on disk with the status `offline` and is pushed later, also after the app closed ([`session.test.ts`](../../plugin/src/obsidian/session.test.ts)). A start while offline is retried ([`controller.test.ts`](../../plugin/src/obsidian/controller.test.ts)). Offline edits on two devices are combined ([`table.test.ts`](../../plugin/src/core/sync/table.test.ts)). Airplane mode on the device is in section 9.

## 5. App killed mid-sync

Automated: an interrupted push, merge or upload recovers with no duplicate revision ([`crash.test.ts`](../../plugin/src/core/sync/crash.test.ts), [`engine.test.ts`](../../plugin/src/core/sync/engine.test.ts)). A new session resumes from the journal ([`session.test.ts`](../../plugin/src/obsidian/session.test.ts), [`lifecycle.e2e.ts`](../../plugin/test/e2e/specs/lifecycle.e2e.ts)). On the Android app, `am force-stop` during a push, after the server acknowledged a commit that the device never saw, ends `idle` with the vault equal to the server and no duplicate revision ([`device.android.e2e.ts`](../../plugin/test/e2e/specs/device.android.e2e.ts)).

| Manual check | Expected result | Why manual |
|---|---|---|
| On the phone, during the large-vault sync (section 3), swipe Obsidian away from the recent apps list and open it again. Do this once more. Then use **Settings → Apps → Obsidian → Force stop** during the sync and open it again. | Each time, sync resumes without starting over (it finishes much sooner than a full sync) and ends `idle`, `0 pending`, with the same file count and size as the server. No file is empty or truncated, and the server shows no duplicate files. | The kill is automated, but its effect on a large-vault sync depends on a real phone's memory and storage speed. |

## 6. Background and foreground

Automated: the plugin stops and starts cleanly ([`lifecycle.e2e.ts`](../../plugin/test/e2e/specs/lifecycle.e2e.ts)). On the Android app, an edit made just before a short background reaches the server once Obsidian is back, and an edit survives "Don't keep activities" ([`device.android.e2e.ts`](../../plugin/test/e2e/specs/device.android.e2e.ts)).

| Manual check | Expected result | Why manual |
|---|---|---|
| Make a change on desktop. Leave the phone's Obsidian in the background (screen off) for at least 30 minutes, then open it. | Within 30 seconds of opening, the desktop change arrived and the status is `idle`. No error notice is shown. | Only Android decides if a backgrounded app is paused, killed or restarted. |

## 7. Conflicts

Automated, no manual check: merges and conflict copies ([`table.test.ts`](../../plugin/src/core/sync/table.test.ts) rows A6 and A9, [`session.test.ts`](../../plugin/src/obsidian/session.test.ts)), remote changes to a note or canvas with unsaved typing ([`editor.e2e.ts`](../../plugin/test/e2e/specs/editor.e2e.ts)), and the warning before two vaults with files are combined ([`sync.e2e.ts`](../../plugin/test/e2e/specs/sync.e2e.ts)).

## 8. Attachments

Automated: an attachment larger than one upload chunk and one download range syncs byte for byte ([`sync.e2e.ts`](../../plugin/test/e2e/specs/sync.e2e.ts)). Concurrent edits of a binary file keep the remote version at the path and the local one as a copy ([`rules.test.ts`](../../plugin/src/core/sync/rules.test.ts)). Resumed uploads are in section 5.

| Manual check | Expected result | Why manual |
|---|---|---|
| On the phone, add a photo to a note with Obsidian's **Attach file** (pick one from the gallery), and another by taking a new photo with the camera. | Both images reach the desktop vault, open there, and have the same size as on the phone. | The Android file picker and camera exist only on a device. |

## 9. Battery and network

Automated: an unreachable server or identity provider shows as `offline` ([`status.test.ts`](../../plugin/src/obsidian/status.test.ts)). An aborted call frees the caller at once and drops its late response ([`http.test.ts`](../../plugin/src/obsidian/http.test.ts)). On the Android app, edits made in airplane mode stay on disk with the status `offline` and reach the server when the network is back ([`device.android.e2e.ts`](../../plugin/test/e2e/specs/device.android.e2e.ts)).

| Manual check | Expected result | Why manual |
|---|---|---|
| On the phone, start to sync a large attachment (at least 20 MB) on Wi-Fi. Then turn Wi-Fi off, so the phone moves to mobile data. | The upload finishes over mobile data, and the desktop's copy has the same size. | A real switch between networks happens only on a device. |
| Turn on **Battery saver**. Repeat the background check of section 6, and edit a note in the foreground. | Sync works in the foreground. Changes made in the background arrive at the latest 30 seconds after you open Obsidian. | Battery saver and Doze apply only on a device. |
| With the large vault synced and idle, write down the battery level. Leave the phone unplugged, with Obsidian open in the foreground and the screen on, for 30 minutes. Then open **Settings → Battery → Battery usage**. | Obsidian's battery use is in line with Obsidian's without Vault Sync (compare a second 30-minute run with the plugin disabled), and the phone is not noticeably warm. | Battery drain can only be measured on a device. |

## 10. Config folder

Automated, no manual check: nothing under the config folder syncs (`docs/design/engine.md` §1), because the Obsidian adapter never lists it ([`conformance.e2e.ts`](../../plugin/test/e2e/specs/conformance.e2e.ts)).

## 11. End-to-end encryption key

Automated: only the public key, the wrapped private key, its parameters and the verifier reach the server, a second device unlocks the same key, and the server's retry time shows after 10 wrong passphrases ([`user-key.test.ts`](../../plugin/src/core/keys/user-key.test.ts), [`encryption.test.ts`](../../plugin/src/obsidian/encryption.test.ts)). An unlock on the emulator runs on WebAssembly in under 5 seconds (`[P4-15]`, [`encryption.e2e.ts`](../../plugin/test/e2e/specs/encryption.e2e.ts)). The derivation yields to the event loop ([`e2ee.test.ts`](../../plugin/src/core/e2ee/e2ee.test.ts)).

| Manual check | Expected result | Why manual |
|---|---|---|
| Use a low-end phone and write down its model. Enable encryption on the desktop. On the phone, open **Settings → Vault Sync → End-to-end encryption**, tap **Unlock** and enter the passphrase. Time from **Unlock** in the dialog to the notice that the key is unlocked. Do it again with a wrong passphrase. | The key unlocks with the default parameters (64 MiB, 3 passes). Obsidian does not crash, and Android shows no "app isn't responding". The dialog stays responsive (you can scroll it) while the key is derived. Write the time in the release notes and in `docs/design/crypto.md` (Measurements). If it is over 10 seconds, raise it on #657 before you release. | Only a real low-end phone's WebView shows the real time and memory use. |
