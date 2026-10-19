# Android release checklist

Android is a required client (`SPEC.md` §2). Before each release, a person runs the **manual** checks on this page on a physical Android device. Everything our automated suites can check is an automated test instead, and this page links to it rather than asking for a manual step. Those tests run in CI on every change, so they need no action at release time.

Why some checks stay manual: the emulated-mobile e2e (`VAULT_SYNC_E2E_MOBILE=1`, `docs/testing/e2e.md`) runs desktop Obsidian, on Electron, with the mobile UI. It never exercises the Android WebView, Capacitor's filesystem, BRAT on Android, Android pausing or killing the app, real network changes, or battery use. Running the real Android app on an emulator in CI is being researched in [#187](https://github.com/solidDoWant/vault-sync/issues/187). If it is adopted, more items here move to automated tests.

## Before you start

- A physical Android phone with the Obsidian version the release supports (`minAppVersion` in `plugin/manifest.json` or newer) and the BRAT community plugin installed. Note the phone model, the Android version and the Obsidian version in the release notes.
- A vault-sync server for the release, reachable over `https` from the phone's Wi-Fi and from mobile data, with its identity provider set up as in `docs/plugin.md`.
- A test account, and a desktop Obsidian signed in to that account with a test vault connected, to make remote changes and check what arrives.
- For the large-vault check, a vault of at least 5,000 notes and 500 MB of attachments (images, PDFs) on the server.

Mark each manual check passed or failed, with a note for every failure. A failed check blocks the release until it is fixed or the project owner accepts it.

## How to read the tables

Each row is one check and its expected result. **Automated** rows name the test that covers it (file, then the test's name), so nothing needs doing on the device. **Manual** rows say in one line why they need a physical device. The e2e specs listed run in both CI jobs, `plugin-e2e (ubuntu-latest)` (desktop UI) and `plugin-e2e (emulated-mobile)`.

## 1. Install via BRAT

| Check | Expected result | Covered by |
|---|---|---|
| The manifest users install allows mobile. | `isDesktopOnly` is `false`, so Obsidian mobile offers to install the plugin. | Automated: [`plugin/test/mobile.test.ts`](../../plugin/test/mobile.test.ts), "is not marked desktop-only in the manifest users install, so it installs on Android". |
| The bundle loads nothing that only desktop has. | `main.js` loads only `obsidian` (and Obsidian's own CodeMirror modules), never a Node built-in or Electron, which do not exist on Android. | Automated: [`plugin/test/mobile.test.ts`](../../plugin/test/mobile.test.ts), "loads no module that only desktop has (Node built-ins, Electron)". |
| The built plugin loads and enables in the mobile UI. | Obsidian enables the plugin, and its `onload` does not throw. | Automated: [`smoke.e2e.ts`](../../plugin/test/e2e/specs/smoke.e2e.ts), "runs in the configured UI mode (desktop, or emulated mobile)" and "loads and enables the built plugin". |
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
| A first sync pulls every page of changes and every download range of large files. | The local vault equals the server's live files, and the cursor is at the head. | Automated: [`plugin/src/core/engine/engine.test.ts`](../../plugin/src/core/engine/engine.test.ts), "makes the local vault match the remote heads and advances the cursor to the head" (the test server returns 2 revisions per page and 5 bytes per range). |
| An interrupted first sync resumes where it stopped. | The cursor stays at the last applied revision, and the next pull continues from it. | Automated: [`engine.test.ts`](../../plugin/src/core/engine/engine.test.ts), "leaves the cursor at the last applied revision when a pull fails midway, and resumes from it" and "given the engine crashes mid-apply". |
| Connecting a new vault to a remote vault brings its files across through a real server. | The files and their content arrive. If both sides have files, the plugin asks before it connects. | Automated: [`sync.e2e.ts`](../../plugin/test/e2e/specs/sync.e2e.ts), "brings the file to a second vault, after warning that both vaults have files". |
| On the phone, create an empty vault, sign in and connect it to the large test vault. Keep Obsidian in the foreground until **Show sync status** shows `idle`. | Sync finishes with `idle`, `0 pending`. The file count and total size in the phone's vault match the server's. Obsidian stays responsive, does not crash or reload, and Android shows no "app isn't responding" dialog. | Manual: memory, storage speed and WebView limits are those of a real phone. |

## 4. Offline edits

| Check | Expected result | Covered by |
|---|---|---|
| An edit made while the server cannot be reached is kept and pushed once it can. | The file stays on disk, the status is `offline`, and the next sync timer pushes it, then shows `idle`, `0 pending`. | Automated: [`plugin/src/obsidian/session.test.ts`](../../plugin/src/obsidian/session.test.ts), "keeps an edit made while the server is unreachable, reports offline, and pushes it on the sync timer once the server is back" and "reports offline, with the pending count, when the server cannot be reached". |
| Offline edits survive closing the app before it could sync. | The next start pushes the edit and the new file made offline. | Automated: [`session.test.ts`](../../plugin/src/obsidian/session.test.ts), "pushes an edit made while the server was unreachable from the next session when the app was closed before it synced". |
| A start while offline is retried. | Sync starts once the server is reachable. | Automated: [`plugin/src/obsidian/controller.test.ts`](../../plugin/src/obsidian/controller.test.ts), "retries a start that failed because the server was unreachable". |
| Offline edits on two devices are combined. | Both devices end with every edit, with conflict copies where they overlap (see Conflicts). | Automated: [`plugin/src/core/engine/structure.test.ts`](../../plugin/src/core/engine/structure.test.ts), "given two devices create the same path offline"; [`merge.test.ts`](../../plugin/src/core/engine/merge.test.ts), "has both edits on every device after sync, and no conflict copy". |

Turning on airplane mode on the phone itself is in section 8.

## 5. App killed mid-sync

| Check | Expected result | Covered by |
|---|---|---|
| A push interrupted at any point (lost response, crash) reaches the same state after a restart, with no duplicate revision. | The server holds each local change once. The journal matches what the server acknowledged. | Automated: [`plugin/src/core/engine/push.test.ts`](../../plugin/src/core/engine/push.test.ts), "reaches the same server and journal state wherever the push is interrupted", "recognizes its own revision after a restart instead of committing it again". |
| A merge interrupted at any point recovers. | The merge result is pushed, and nothing is lost or merged twice. | Automated: [`merge.test.ts`](../../plugin/src/core/engine/merge.test.ts), "given a crash at any point"; [`push.test.ts`](../../plugin/src/core/engine/push.test.ts), "recovers and pushes the merge result wherever the merge is interrupted". |
| An interrupted upload resumes. | After a restart the upload continues at the server's received size, without re-sending stored chunks. | Automated: [`push.test.ts`](../../plugin/src/core/engine/push.test.ts), "resumes after a restart without re-sending the chunks the server stored"; simulation scenario "pushes the engine's edits through a lost commit response, a moved head and an interrupted upload" in [`sim/simulation.sim.test.ts`](../../sim/simulation.sim.test.ts). |
| Crashes under random faults never lose an acknowledged write. | Every seeded schedule, with client crashes and restarts, converges with no invariant violation. | Automated: [`sim/simulation.sim.test.ts`](../../sim/simulation.sim.test.ts), "seeded schedules" (`crash` fault, `docs/testing/simulation.md`). |
| A new session over the same journal picks up where a stopped one left off. | It resumes from the stored cursor, and a stopped session never touches the vault or journal again. | Automated: [`session.test.ts`](../../plugin/src/obsidian/session.test.ts), "lets a new session over the same journal pick up where the stopped one left off" and "resolves while a server call hangs, and the stopped engine never touches the vault or journal again"; [`lifecycle.e2e.ts`](../../plugin/test/e2e/specs/lifecycle.e2e.ts), "resumes from the journal without a full resync". |
| On the phone, during the large-vault sync (section 3), swipe Obsidian away from the recent apps list. Open it again. Repeat once more, then use **Settings → Apps → Obsidian → Force stop** during the sync and open it again. | Each time, sync resumes without starting over (it finishes much sooner than a full sync) and ends `idle`, `0 pending`, with the same file count and size as the server. No file is empty or truncated, and the server shows no duplicate files. | Manual: only Android killing the process can interrupt the real WebView's IndexedDB and Capacitor filesystem writes mid-sync. |

## 6. Background and foreground

| Check | Expected result | Covered by |
|---|---|---|
| The plugin stops and starts cleanly (as it does when Obsidian unloads it). | Disabling and re-enabling resumes sync from the journal without a full resync. | Automated: [`lifecycle.e2e.ts`](../../plugin/test/e2e/specs/lifecycle.e2e.ts), "resumes from the journal without a full resync". |
| Background, short: on the phone, edit a note, switch to another app within 2 seconds, wait a minute, switch back. | The edit reaches the desktop vault, at the latest within 30 seconds of switching back. The note on the phone is unchanged. | Manual: only Android pauses the WebView's timers and network in the background. |
| Background, long: make a change on desktop, leave the phone's Obsidian in the background (screen off) for at least 30 minutes, then open it. | Within 30 seconds of opening, the desktop change has arrived and the status is `idle`. No error notice is shown. | Manual: only Android decides whether a backgrounded app is paused, killed or restarted. |
| With **Developer options → Don't keep activities** on, edit a note, switch apps, and switch back. | The edit is not lost, and it reaches the server. | Manual: Android destroying the activity on every switch happens only on a device. |

## 7. Conflicts

| Check | Expected result | Covered by |
|---|---|---|
| Concurrent non-overlapping edits of a note merge. | Both edits on every device, no conflict copy. | Automated: [`merge.test.ts`](../../plugin/src/core/engine/merge.test.ts), "has both edits on every device after sync, and no conflict copy". |
| Concurrent overlapping edits keep both versions. | The remote version stays at the path, the local one is a conflict copy with no conflict markers, and the conflict is logged and counted until the copy is deleted. | Automated: [`merge.test.ts`](../../plugin/src/core/engine/merge.test.ts), "keeps the remote version in place and the local version as a conflict copy, without conflict markers" and "records the conflict in the conflict log"; [`session.test.ts`](../../plugin/src/obsidian/session.test.ts), "counts a conflict copy until the user deletes it". |
| Two real engines, racing through a real server under a lost response and a crash. | Both vaults end identical with every edit, overlapping and binary edits as conflict copies. | Automated: [`sim/simulation.sim.test.ts`](../../sim/simulation.sim.test.ts), "merges two engines' concurrent edits, keeping overlapping and binary ones as conflict copies", "syncs renames, deletes, same-path creates, folder renames and rename chains between two engines without losing or duplicating a document". |
| A remote change to a note open in the editor with unsaved typing. | A non-overlapping change keeps the cursor and the typed text. An overlapping one is refused and the typed text saved instead. | Automated: [`editor.e2e.ts`](../../plugin/test/e2e/specs/editor.e2e.ts), every test in "Remote writes to a note open in the editor" and "Remote writes to a canvas open in its view". |
| Connecting a vault that has files to a remote vault that has files. | The plugin asks first, and nothing starts without confirmation. | Automated: [`sync.e2e.ts`](../../plugin/test/e2e/specs/sync.e2e.ts), "brings the file to a second vault, after warning that both vaults have files". |

## 8. Attachments

| Check | Expected result | Covered by |
|---|---|---|
| An attachment larger than one upload chunk and one download range syncs byte for byte between two vaults through a real server. | The second vault's file has the same size and SHA-256. | Automated: [`sync.e2e.ts`](../../plugin/test/e2e/specs/sync.e2e.ts), "pushes an attachment larger than one upload chunk" and "brings the attachment to the second vault byte for byte". |
| Concurrent edits of a binary file. | The remote version stays in place, the local one is a conflict copy. | Automated: [`merge.test.ts`](../../plugin/src/core/engine/merge.test.ts), "given concurrent edits of a binary file". |
| An interrupted attachment upload resumes. | See section 5. | Automated: [`push.test.ts`](../../plugin/src/core/engine/push.test.ts), "given an interrupted upload". |
| On the phone, add a photo to a note with Obsidian's **Attach file** (pick one from the gallery) and another by taking a new photo with the camera. | Both images reach the desktop vault, open there, and have the same size as on the phone. | Manual: the Android file picker and camera only exist on a device. |

## 9. Battery and network

| Check | Expected result | Covered by |
|---|---|---|
| A server or identity provider that cannot be reached shows as `offline`, not as an error, and nothing is lost. | See section 4. | Automated: [`plugin/src/obsidian/status.test.ts`](../../plugin/src/obsidian/status.test.ts), "counts an unreachable server or identity provider as offline, and nothing else", and the section 4 tests. |
| A call that is aborted (a timeout, say) frees the caller at once and its late response is dropped. | Sync carries on with the next attempt. | Automated: [`plugin/src/obsidian/http.test.ts`](../../plugin/src/obsidian/http.test.ts), "frees the caller as soon as the call is aborted, without waiting for the response" and "drops a response that arrives after the call was aborted". |
| On the phone, turn on airplane mode, edit a note and create one, wait a minute, turn airplane mode off. | While offline, **Show sync status** shows `offline` and the edits stay. Within 30 seconds of the network returning, both reach the desktop vault and the status is `idle`, `0 pending`. | Manual: only a device has a real radio to switch off. |
| On the phone, start syncing a large attachment (at least 20 MB) on Wi-Fi, then turn Wi-Fi off so the phone moves to mobile data. | The upload finishes over mobile data, and the desktop's copy has the same size. | Manual: a real switch between networks happens only on a device. |
| With **Battery saver** on, repeat the short background check (section 6) and edit a note in the foreground. | Sync still works in the foreground. Changes made in the background arrive at the latest within 30 seconds of opening Obsidian. | Manual: Android's battery saver and Doze restrictions apply only on a device. |
| With the large vault synced and idle, note the battery level, leave the phone unplugged with Obsidian open in the foreground and the screen on for 30 minutes, then check **Settings → Battery → Battery usage**. | Obsidian's battery use is in line with Obsidian's without Vault Sync enabled (compare a second 30-minute run with the plugin disabled), and the phone is not noticeably warm. | Manual: battery drain can only be measured on a device. |
