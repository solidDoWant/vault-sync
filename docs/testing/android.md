# Android release checklist

Android is a required client (`SPEC.md` §2). Before each release, a person runs the **manual** checks on this page on a physical Android device. Everything our automated suites can check is an automated test instead, and this page links to it rather than asking for a manual step. Those tests run in CI on every change, so they need no action at release time.

Why some checks stay manual: the emulated-mobile e2e (`VAULT_SYNC_E2E_MOBILE=1`, `docs/testing/e2e.md`) runs desktop Obsidian, on Electron, with the mobile UI. It never exercises the Android WebView, Capacitor's filesystem, BRAT on Android, Android pausing or killing the app, real network changes, or battery use. The Android emulator job (`plugin-e2e (android-emulator)`, `docs/testing/e2e.md`, "Android emulator job") runs the real Android app in an emulator: every e2e spec, plus [`device.android.e2e.ts`](../../plugin/test/e2e/specs/device.android.e2e.ts), which kills the app's process, sends it to the background, has Android destroy its activity and cuts the network. The rows those tests cover are automated below. BRAT, the browser and clipboard, battery use and large-vault performance are still manual here; #31 tracks automating them or covering them by a proxy.

## Before you start

- A physical Android phone with the Obsidian version the release supports (`minAppVersion` in `plugin/manifest.json` or newer) and the BRAT community plugin installed. Note the phone model, the Android version and the Obsidian version in the release notes.
- A vault-sync server for the release, reachable over `https` from the phone's Wi-Fi and from mobile data, with its identity provider set up as in `docs/plugin.md`.
- A test account, and a desktop Obsidian signed in to that account with a test vault connected, to make remote changes and check what arrives.
- For the large-vault check, a vault of at least 5,000 notes and 500 MB of attachments (images, PDFs) on the server.

Mark each manual check passed or failed, with a note for every failure. A failed check blocks the release until it is fixed or the project owner accepts it.

## How to read the tables

Each row is one check and its expected result. **Automated** rows name the test that covers it (file, then the test's name), so nothing needs doing on the device. **Manual** rows say in one line why they need a physical device. The e2e specs listed run in every plugin-e2e job, including emulated-mobile: `plugin-e2e (ubuntu-latest)`, `plugin-e2e (windows-latest)` and `plugin-e2e (macos-latest)` (desktop UI) and `plugin-e2e (emulated-mobile)`. They also run on the real Android app in `plugin-e2e (android-emulator)`, nightly and on manual dispatch (not a required check). `device.android.e2e.ts` runs only there; its tests are all in "vault-sync on an Android device".

## 1. Install via BRAT

| Check | Expected result | Covered by |
|---|---|---|
| The manifest users install allows mobile. | `isDesktopOnly` is `false`, so Obsidian mobile offers to install the plugin. | Automated: [`plugin/test/mobile.test.ts`](../../plugin/test/mobile.test.ts), "is not marked desktop-only in the manifest users install, so it installs on Android". |
| The bundle loads nothing that only desktop has. | `main.js` loads only `obsidian` (and Obsidian's own CodeMirror modules), never a Node built-in or Electron, which do not exist on Android. | Automated: [`plugin/test/mobile.test.ts`](../../plugin/test/mobile.test.ts), "loads no module that only desktop has (Node built-ins, Electron)". |
| The built plugin loads and enables in the mobile UI, and in the real Android app. | Obsidian enables the plugin, and its `onload` does not throw. | Automated: [`smoke.e2e.ts`](../../plugin/test/e2e/specs/smoke.e2e.ts), "runs in the configured UI mode and app (desktop, emulated mobile, or the Android app)" and "loads and enables the built plugin" (the Android app in `plugin-e2e (android-emulator)`). |
| In BRAT, add the release's repository (`solidDoWant/vault-sync`), install the release under test and enable Vault Sync. Restart Obsidian. | BRAT installs the release's version. Vault Sync is enabled after the restart, with no error notice, and **Settings → Vault Sync** opens. | Manual: BRAT downloading the GitHub release into the Android app's storage happens only in the real Android app. |

## 2. Sign-in

| Check | Expected result | Covered by |
|---|---|---|
| The device flow signs in, and the session survives a reload and a revoked refresh token. | The dialog shows the verification URL and user code, the refresh token is stored once approved, a reload refreshes the access token, a revoked token asks for a new sign-in, and sign-out forgets the tokens. | Automated: [`signin.e2e.ts`](../../plugin/test/e2e/specs/signin.e2e.ts), every test in "signing in with the device flow". |
| Sign-in survives a flaky network. | Polling continues through network failures and server errors and stops when the code expires or the dialog closes. A provider outage while refreshing does not sign the user out. | Automated: [`plugin/src/core/auth/oidc.test.ts`](../../plugin/src/core/auth/oidc.test.ts), "keeps polling through network failures and server errors", "fails with expired_token once the code expires, without polling past it", "stops polling when cancelled"; [`plugin/src/core/auth/tokens.test.ts`](../../plugin/src/core/auth/tokens.test.ts), "stays signed in through a provider outage and retries on the next request". |
| On the phone, fill in the settings, tap **Sign in**, then **Open page**. Approve the code in the phone's browser and switch back to Obsidian. | The browser opens the verification page. Back in Obsidian, the dialog closes by itself within a few seconds and **Vault Sync: Show sync status** shows `no vault connected`. | Manual: opening the Android browser sends Obsidian to the background, and only Android decides whether its polling keeps running there. |
| On the phone, tap **Copy code**, paste it into the verification page in the browser. | The pasted code is the one the dialog shows. | Manual: the Android clipboard is only reachable in the real app. |

## 3. Initial sync of a large vault

| Check | Expected result | Covered by |
|---|---|---|
| A first sync pulls every page of changes and every download range of large files. | The local vault equals the server's live files, and the cursor is at the head. | Automated: [`plugin/src/core/sync/engine.test.ts`](../../plugin/src/core/sync/engine.test.ts), "two devices" (every test). |
| An interrupted first sync resumes where it stopped. | The cursor stays at the last applied revision, and the next pull continues from it. | Automated: [`crash.test.ts`](../../plugin/src/core/sync/crash.test.ts), "an app killed during a sync"; [`engine.test.ts`](../../plugin/src/core/sync/engine.test.ts), "an engine restart resumes from the journal and pulls only what is new". |
| Connecting a new vault to a remote vault brings its files across through a real server. | The files and their content arrive. If both sides have files, the plugin asks before it connects. | Automated: [`sync.e2e.ts`](../../plugin/test/e2e/specs/sync.e2e.ts), "brings the file to a second vault, after warning that both vaults have files". |
| On the phone, create an empty vault, sign in and connect it to the large test vault. Keep Obsidian in the foreground until **Show sync status** shows `idle`. | Sync finishes with `idle`, `0 pending`. The file count and total size in the phone's vault match the server's. Obsidian stays responsive, does not crash or reload, and Android shows no "app isn't responding" dialog. | Manual: memory, storage speed and WebView limits are those of a real phone. |

## 4. Offline edits

| Check | Expected result | Covered by |
|---|---|---|
| An edit made while the server cannot be reached is kept and pushed once it can. | The file stays on disk, the status is `offline`, and the next sync timer pushes it, then shows `idle`, `0 pending`. | Automated: [`plugin/src/obsidian/session.test.ts`](../../plugin/src/obsidian/session.test.ts), "keeps an edit made while the server is unreachable, reports offline, and pushes it on the sync timer once the server is back" and "reports offline, with the pending count, when the server cannot be reached". |
| Offline edits survive closing the app before it could sync. | The next start pushes the edit and the new file made offline. | Automated: [`session.test.ts`](../../plugin/src/obsidian/session.test.ts), "shows offline while the server is unreachable, keeps the local change pending, and pushes it once the server is back". |
| A start while offline is retried. | Sync starts once the server is reachable. | Automated: [`plugin/src/obsidian/controller.test.ts`](../../plugin/src/obsidian/controller.test.ts), "retries a start that failed because the server was unreachable". |
| Offline edits on two devices are combined. | Both devices end with every edit, with conflict copies where they overlap (see Conflicts). | Automated: [`table.test.ts`](../../plugin/src/core/sync/table.test.ts), "decision table (docs/design/engine.md §5)". |

Turning on airplane mode on the device itself is in section 9.

## 5. App killed mid-sync

| Check | Expected result | Covered by |
|---|---|---|
| A push interrupted at any point (lost response, crash) reaches the same state after a restart, with no duplicate revision. | The server holds each local change once. The journal matches what the server acknowledged. | Automated: [`crash.test.ts`](../../plugin/src/core/sync/crash.test.ts), "an app killed during a sync"; [`engine.test.ts`](../../plugin/src/core/sync/engine.test.ts), "a commit retried after a lost reply leaves one revision on the server". |
| A merge interrupted at any point recovers. | The merge result is pushed, and nothing is lost or merged twice. | Automated: [`crash.test.ts`](../../plugin/src/core/sync/crash.test.ts), "an app killed during a sync". |
| An interrupted upload resumes. | After a restart the upload continues at the server's received size, without re-sending stored chunks. | Automated: [`crash.test.ts`](../../plugin/src/core/sync/crash.test.ts), "an app killed during a sync" (uploads resume through `BeginBlob`, SPEC.md §6.2). |
| A new session over the same journal picks up where a stopped one left off. | It resumes from the stored cursor, and a stopped session never touches the vault or server again. | Automated: [`session.test.ts`](../../plugin/src/obsidian/session.test.ts), "calls neither the server nor the vault once stopped, and a new session over the same journal resumes"; [`lifecycle.e2e.ts`](../../plugin/test/e2e/specs/lifecycle.e2e.ts), "resumes from the journal without a full resync". |
| Obsidian's process is force-stopped (`am force-stop`) on the Android app during a push, after the server acknowledged a commit the device never saw, and opened again. | Sync resumes and ends `idle`, `0 pending`. The vault equals the server (each file's SHA-256), and the server holds one revision per change: the acknowledged commit is not committed again. | Automated: [`device.android.e2e.ts`](../../plugin/test/e2e/specs/device.android.e2e.ts), "resumes a sync after Obsidian's process is killed mid-push, with the vault equal to the server and no duplicate revision (section 5)". |
| On the phone, during the large-vault sync (section 3), swipe Obsidian away from the recent apps list. Open it again. Repeat once more, then use **Settings → Apps → Obsidian → Force stop** during the sync and open it again. | Each time, sync resumes without starting over (it finishes much sooner than a full sync) and ends `idle`, `0 pending`, with the same file count and size as the server. No file is empty or truncated, and the server shows no duplicate files. | Manual: the kill itself is automated (above), but its effect on a large-vault sync depends on a real phone's memory and storage speed (section 3). |

## 6. Background and foreground

| Check | Expected result | Covered by |
|---|---|---|
| The plugin stops and starts cleanly (as it does when Obsidian unloads it). | Disabling and re-enabling resumes sync from the journal without a full resync. | Automated: [`lifecycle.e2e.ts`](../../plugin/test/e2e/specs/lifecycle.e2e.ts), "resumes from the journal without a full resync". |
| Background, short: edit a note, send Obsidian to the background at once, wait, bring it back. | The edit reaches the server, at the latest within a minute of switching back. The note on the device is unchanged, and the WebView is the same one (Obsidian was not restarted). | Automated: [`device.android.e2e.ts`](../../plugin/test/e2e/specs/device.android.e2e.ts), "pushes an edit made just before Obsidian went to the background, once it is back (section 6)". |
| Background, long: make a change on desktop, leave the phone's Obsidian in the background (screen off) for at least 30 minutes, then open it. | Within 30 seconds of opening, the desktop change has arrived and the status is `idle`. No error notice is shown. | Manual: only Android decides whether a backgrounded app is paused, killed or restarted. |
| With **Developer options → Don't keep activities** on (`always_finish_activities`), edit a note, switch apps, and switch back. | Android destroys the activity and Obsidian starts again. The edit is not lost, and it reaches the server. | Automated: [`device.android.e2e.ts`](../../plugin/test/e2e/specs/device.android.e2e.ts), "keeps and pushes an edit when Android destroys the activity on the switch ("Don't keep activities", section 6)". |

## 7. Conflicts

| Check | Expected result | Covered by |
|---|---|---|
| Concurrent non-overlapping edits of a note merge. | Both edits on every device, no conflict copy. | Automated: [`table.test.ts`](../../plugin/src/core/sync/table.test.ts), rows A6 and A9. |
| Concurrent overlapping edits keep both versions. | The remote version stays at the path, the local one is a conflict copy with no conflict markers, counted until the copy is deleted. | Automated: [`table.test.ts`](../../plugin/src/core/sync/table.test.ts), row A6; [`session.test.ts`](../../plugin/src/obsidian/session.test.ts), "lists a conflict copy with the note it was taken from, and counts it in the status". |
| A remote change to a note open in the editor with unsaved typing. | A non-overlapping change keeps the cursor and the typed text. An overlapping one is refused and the typed text saved instead. | Automated: [`editor.e2e.ts`](../../plugin/test/e2e/specs/editor.e2e.ts), every test in "Remote writes to a note open in the editor" and "Remote writes to a canvas open in its view". |
| Connecting a vault that has files to a remote vault that has files. | The plugin asks first, and nothing starts without confirmation. | Automated: [`sync.e2e.ts`](../../plugin/test/e2e/specs/sync.e2e.ts), "brings the file to a second vault, after warning that both vaults have files". |

## 8. Attachments

| Check | Expected result | Covered by |
|---|---|---|
| An attachment larger than one upload chunk and one download range syncs byte for byte between two vaults through a real server. | The second vault's file has the same size and SHA-256. | Automated: [`sync.e2e.ts`](../../plugin/test/e2e/specs/sync.e2e.ts), "pushes an attachment larger than one upload chunk" and "brings the attachment to the second vault byte for byte". |
| Concurrent edits of a binary file. | The newer version stays in place, the other one is a conflict copy. | Automated: [`rules.test.ts`](../../plugin/src/core/sync/rules.test.ts), "blob edits at the same time: the remote version wins at the path, and the local one is the copy". |
| An interrupted attachment upload resumes. | See section 5. | See section 5. |
| On the phone, add a photo to a note with Obsidian's **Attach file** (pick one from the gallery) and another by taking a new photo with the camera. | Both images reach the desktop vault, open there, and have the same size as on the phone. | Manual: the Android file picker and camera only exist on a device. |

## 9. Battery and network

| Check | Expected result | Covered by |
|---|---|---|
| A server or identity provider that cannot be reached shows as `offline`, not as an error, and nothing is lost. | See section 4. | Automated: [`plugin/src/obsidian/status.test.ts`](../../plugin/src/obsidian/status.test.ts), "counts an unreachable server or identity provider as offline, and nothing else", and the section 4 tests. |
| A call that is aborted (a timeout, say) frees the caller at once and its late response is dropped. | Sync carries on with the next attempt. | Automated: [`plugin/src/obsidian/http.test.ts`](../../plugin/src/obsidian/http.test.ts), "frees the caller as soon as the call is aborted, without waiting for the response" and "drops a response that arrives after the call was aborted". |
| Turn on airplane mode, edit a note and create one, turn airplane mode off. The server is reached over the emulator's own network (`10.0.2.2`), which airplane mode cuts, not over `adb reverse`, which bypasses it. | While offline, the status is `offline`, with the edits pending and on disk. Once the network is back, both reach the server and the status is `idle`, `0 pending`, with the vault equal to the server. | Automated: [`device.android.e2e.ts`](../../plugin/test/e2e/specs/device.android.e2e.ts), "reports offline while the network is cut and pushes the edits made meanwhile once it is back (sections 4 and 9)". |
| On the phone, start syncing a large attachment (at least 20 MB) on Wi-Fi, then turn Wi-Fi off so the phone moves to mobile data. | The upload finishes over mobile data, and the desktop's copy has the same size. | Manual: a real switch between networks happens only on a device. |
| With **Battery saver** on, repeat the short background check (section 6) and edit a note in the foreground. | Sync still works in the foreground. Changes made in the background arrive at the latest within 30 seconds of opening Obsidian. | Manual: Android's battery saver and Doze restrictions apply only on a device. |
| With the large vault synced and idle, note the battery level, leave the phone unplugged with Obsidian open in the foreground and the screen on for 30 minutes, then check **Settings → Battery → Battery usage**. | Obsidian's battery use is in line with Obsidian's without Vault Sync enabled (compare a second 30-minute run with the plugin disabled), and the phone is not noticeably warm. | Manual: battery drain can only be measured on a device. |

## 10. Config folder

| Check | Expected result | Covered by |
|---|---|---|
| Nothing under the config folder syncs (config-folder sync is not part of this version, `docs/design/engine.md` §1). | No config file reaches the server or is written locally. | Automated: the Obsidian adapter never lists the config folder ([`conformance.e2e.ts`](../../plugin/test/e2e/specs/conformance.e2e.ts)). |

## 11. End-to-end encryption key

| Check | Expected result | Covered by |
|---|---|---|
| Enabling encryption sends the private key only wrapped under the passphrase, and a second device unlocks the same key. | Only the public key, the wrapped private key, its parameters and the verifier reach the server. A second device with the right passphrase holds the same key pair; a wrong one fails, and once the server's limit is reached the server's retry time is shown. | Automated: [`plugin/src/core/keys/user-key.test.ts`](../../plugin/src/core/keys/user-key.test.ts), "creates the key pair on the device and sends only the public key, the wrapped private key and the verifier", "holds the same key pair as the device that enabled encryption", "after 10 wrong passphrases, refuses even the right one and reports the server's retry time"; [`plugin/src/obsidian/encryption.test.ts`](../../plugin/src/obsidian/encryption.test.ts), "shows the server's retry time once 10 wrong passphrases were tried". |
| Unlocking is fast on the emulator (P4-15). | An unlock at the default Argon2id parameters runs on WebAssembly (`hash-wasm` in a Web Worker, after its self-test) and takes under 5 seconds. | Automated: [`plugin/test/e2e/specs/encryption.e2e.ts`](../../plugin/test/e2e/specs/encryption.e2e.ts) "[P4-15] unlocks within a few seconds with Argon2id at 64 MiB and 3 passes, on WebAssembly", in the Android emulator job. |
| The Argon2id derivation yields to the event loop. | The derivation does not block the UI thread for its whole length. | Automated: [`plugin/src/core/e2ee/e2ee.test.ts`](../../plugin/src/core/e2ee/e2ee.test.ts) "passphrase derivation does not block the event loop": "yields while unlocking" and "yields while creating the wrapped key" (the pure-JavaScript path); the WebAssembly path runs in a Web Worker, and the `[P4-15]` e2e test logs the longest main-thread pause during an unlock. |
| Unlock timing (#657): on a low-end phone (note the model), with encryption enabled on the desktop, open **Settings → Vault Sync → End-to-end encryption**, tap **Unlock** and enter the passphrase. Time from tapping **Unlock** in the dialog to the notice that the key is unlocked. Repeat with a wrong passphrase. | The key unlocks with the default parameters (64 MiB, 3 passes) without Obsidian crashing or Android showing "app isn't responding". The dialog stays responsive (it can be scrolled) while the key is derived. Record the time in the release notes and in `docs/design/crypto.md` (Measurements); if it is over 10 seconds, raise it on #657 before releasing. | Manual: only a real low-end phone's WebView shows the derivation's real time and memory use. |
