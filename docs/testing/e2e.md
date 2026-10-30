# Plugin e2e tests

For: developers and agents. You know the architecture (`docs/dev/architecture.md`). This page says how the e2e suite is built, how to run it and how to debug it.

The e2e suite (SPEC.md §13) runs the built plugin inside a real, pinned Obsidian. [WebdriverIO](https://webdriver.io) drives Obsidian through [`wdio-obsidian-service`](https://github.com/jesse-r-s-hines/wdio-obsidian-service). The plugin talks to a real `vault-sync-server` that the harness starts.

## Running

```sh
make test-e2e                            # desktop UI
VAULT_SYNC_E2E_MOBILE=1 make test-e2e    # Obsidian's emulated mobile UI
```

`make test-e2e` builds the plugin (`make plugin-build`) and runs `scripts/test-e2e.sh`. Docker is required, and the suite never skips. The first run downloads Obsidian and chromedriver into `plugin/.wdio-obsidian-cache` (gitignored, about 800 MB unpacked on Linux). After that, a run takes well under a minute.

| Variable | Default | Meaning |
|---|---|---|
| `VAULT_SYNC_E2E_MOBILE` | unset | `1` runs Obsidian with `emulateMobile` (the mobile UI on the desktop app, at a 390×844 viewport). This is not a real Android device. What only a device can check is in `docs/testing/android.md`. |
| `VAULT_SYNC_E2E_ANDROID` | unset | `1` runs the suite on the real Obsidian Android app in an Android emulator that is already booted (`plugin/wdio.android.conf.mts`), with Appium installed by `npm ci --prefix plugin/test/e2e/android`. See "Android emulator job". |
| `VAULT_SYNC_E2E_CACHE_DIR` | `plugin/.wdio-obsidian-cache` | Where Obsidian downloads are cached. |
| `VAULT_SYNC_E2E_SCREENSHOTS_DIR` | unset | A directory. The run then runs only `docs-screenshots.e2e.ts`, which saves the screenshots of the settings tab for the user guide there. `make docs-screenshots` sets it to `docs/user/images/`. Without it, that spec skips itself. |
| `E2E_TIMEOUT` | `20m` | `go test -timeout` for the whole run. |
| `VAULT_SYNC_E2E_LOG_DIR` | unset | A directory for the WebdriverIO and verbose chromedriver logs of each spec. They include the stderr of Obsidian (Electron). The native CI jobs set it and upload the directory as an artifact when they fail. |

Extra arguments to `scripts/test-e2e.sh` go to `go test`.

The driver requires both PostgreSQL and the S3-compatible store. It fails, and does not skip, when either is not configured. To use a PostgreSQL that you started yourself:

1. Set `VAULT_SYNC_TEST_DATABASE_URL` to a role that can create databases.
2. Build the plugin.
3. Run `./scripts/with-native-s3.sh go test -count=1 -tags e2e -run TestPluginE2E -v ./cmd/vault-sync-server/`. If you have an S3 store of your own, set the `VAULT_SYNC_TEST_S3_*` variables and run `go test` directly.

## How it fits together

- **Driver** (`cmd/vault-sync-server/e2e_test.go`, Go, build tag `e2e`). `scripts/test-e2e.sh` starts the compose stack (`scripts/with-test-stack.sh`, shared with the integration tests). It then runs `go test -tags e2e -run TestPluginE2E`, under `xvfb-run` on Linux when there is no `DISPLAY`. The driver creates a database, and a bucket when the S3 variables are set. It starts a fake OIDC issuer (`internal/auth/authtest`) with the device flow on, signs a token for a test user, and builds and starts the server. Then it runs `node plugin/node_modules/@wdio/cli/bin/wdio.js run wdio.conf.mts` with `VAULT_SYNC_E2E_SERVER_URL`, `VAULT_SYNC_E2E_TOKEN`, `VAULT_SYNC_E2E_ISSUER_URL` and `VAULT_SYNC_E2E_CLIENT_ID` set. It fails if WebdriverIO fails or runs no specs. The device flow signs in a different user from the test token, so vaults that the plugin creates never show up for the token. The e2e server's file size limit is 8 MiB (`VAULT_SYNC_BLOB_MAX_SIZE_BYTES`).
- **Configuration** (`plugin/wdio.conf.mts`). It pins the Obsidian version. It installs `plugin/dist` (the bundle users install) and the harness plugin into a copy of `plugin/test/e2e/vaults/primary`, and runs one Obsidian at a time.
- **Specs** (`plugin/test/e2e/specs/*.e2e.ts`, mocha). They run in Node and reach into Obsidian with `browser.executeObsidian`. Each spec file gets a fresh Obsidian. The spec names say what each one covers. A spec that holds an acceptance scenario has its id (`AC-nn`, `P3-nn`, `P4-nn`) in its test names, and `make acceptance` finds it by that id.
- **Harness plugin** (`plugin/test/e2e/harness/`). This is a test-only Obsidian plugin (`vault-sync-e2e-harness`). `wdio.conf.mts` bundles it into `harness/dist` (gitignored) on every run, and it is never shipped. It holds code that a stringified `executeObsidian` function cannot hold: the conformance suite, the editor scenarios, the in-memory sync server, and hooks that hold or lose RPCs and autosaves so that no spec depends on timing. Its `adapterUnderTest` field is the adapter that the conformance spec tests. Specs call its methods with `callHarness` (`plugin/test/e2e/obsidian.ts`), which is typed from the harness class.
- **Two devices** (`plugin/test/e2e/devices.ts`). `reloadObsidian({ vault })` relaunches Obsidian with a fresh browser profile, which drops the IndexedDB journal. So a second device is a second vault, opened in its own window of the same Obsidian through the `vault-open` IPC message, and the spec switches between windows (`switchToWindow`). A device goes offline by disconnecting its vault, which keeps its journal. To kill Obsidian and keep the journal, a spec calls `reloadObsidian()` without a vault: it restarts Obsidian on the same vault and profile.
- **Shared helpers.** The device-flow sign-in steps are in `plugin/test/e2e/signin.ts`. The settings-tab helpers are in `plugin/test/e2e/settings-ui.ts`.
- **Types and lint.** `plugin/test/e2e/tsconfig.json` makes the e2e code its own TypeScript program, so mocha and WebdriverIO globals stay out of the plugin program. `make lint` type-checks and lints it.

## Obsidian version

`plugin/wdio.conf.mts` pins the Obsidian app version (`obsidianVersion`). The installer (the Electron binary) is the earliest one compatible with that app version, so the one pin fixes both. A Renovate regex manager (`.github/renovate.json5`, datasource `github-releases`, `obsidianmd/obsidian-releases`) bumps it. The CI download cache is keyed on that file. A bump must also update `obsidianApkSha256` (see "Android emulator job").

## Platforms

| Where | How |
|---|---|
| Dev VM (NixOS) | `make test-e2e`. Obsidian and chromedriver are generic Linux binaries. The dev shell (`flake.nix`) points nix-ld at a matching loader and Electron's libraries (`NIX_LD`, `NIX_LD_LIBRARY_PATH`), and `xvfb-run` provides the display. |
| CI `plugin-e2e (ubuntu-latest)`, `plugin-e2e (emulated-mobile)` | `nix develop -c make test-e2e`, with `VAULT_SYNC_E2E_MOBILE=1` for the mobile job. |
| CI `plugin-e2e (android-emulator)` | The real Android app in an emulator. See "Android emulator job". |
| CI `plugin-e2e (windows-latest)`, `plugin-e2e (macos-latest)` | No Nix and no Linux containers. Go and Node come from `actions/setup-*`, and PostgreSQL runs natively (version 14 or later). `scripts/with-native-s3.sh` downloads the pinned versitygw release, checks its SHA-256 on every run, runs it as the S3 store, exports the `VAULT_SYNC_TEST_S3_*` variables and stops it afterwards. |

On Windows, `wdio.conf.mts` starts Obsidian with `--disable-gpu --in-process-gpu`, which renders in software in Obsidian's main process. The Windows runners have no GPU. Under load, the separate GPU process kept dying until Chromium ended Obsidian with "GPU process isn't usable. Goodbye.", and chromedriver reported "Unable to receive message from renderer" in whichever spec was running. No spec checks rendered pixels.

The versitygw version in `scripts/with-native-s3.sh` must match the image in `deploy/compose/compose.test.yaml`. The script refuses to run otherwise, and `make test` runs `./scripts/with-native-s3.sh --check-pin`, so a compose bump with a stale pin fails CI. Bump both together, with the release checksums.

## Android emulator job

The workflow `.github/workflows/android-e2e.yml` (job `plugin-e2e (android-emulator)`) runs the whole suite on the real Obsidian Android app. It runs nightly on `master`, on manual dispatch, and on pull requests that change the job's own files. It is not a required check: its flake rate is measured first, and making it required is a separate decision.

- **Emulator.** The job boots a Pixel 6 AVD with the AOSP image `system-images;android-34;default;x86_64`, headless, with animations off. The image has no Google Play services: on `google_apis`, Play services updated itself a minute or two after boot, and Android killed Obsidian, which is bound to its font provider. The renderer is `-gpu lavapipe -feature -Vulkan`: GLES through ANGLE on SwiftShader's Vulkan device (the emulator's log shows `vulkan_mode_selected:lavapipe gles_mode_selected:swangle`). The older `swiftshader_indirect` renderer, deprecated in emulator 36.4.9, segfaulted (exit status 139, in its JIT-compiled code) as soon as chromedriver attached to Obsidian's WebView, on the runners' AMD EPYC hosts. Guest Vulkan off made that crash rarer but did not end it. SwiftShader's JIT is still in the lavapipe path, so the crash can be rarer rather than gone. A manual dispatch can pick another renderer (input `gpu`), and the step "Emulator renderer" prints the GLES backend that the emulator chose. `avdmanager` on the runner writes AVDs under `~/.config/.android/avd`, so the job sets `ANDROID_AVD_HOME` there. If the emulator dies mid-run, every later spec fails. The first one usually fails with `Method is not implemented when running "execute/sync"`, and the rest cannot create a session. `emulator.log` in the job's artifact ends with `emulator exited with status 139`, and the job annotates the run with an error that says the emulator crashed. Read such a failure as this flake, not as a plugin regression.
- **APK.** `plugin/wdio.android.conf.mts` downloads `Obsidian-<version>.apk` from the `obsidianmd/obsidian-releases` release of the pinned `obsidianVersion` into `plugin/.wdio-obsidian-cache/android`. `wdio-obsidian-service` does not check the APK's hash, so the config does: on every run it compares the file's SHA-256 with `obsidianApkSha256` in `wdio.conf.mts`, the `digest` that GitHub reports for the asset (`gh api repos/obsidianmd/obsidian-releases/releases/tags/v<version>`). A mismatch deletes the file and fails the run before anything is installed.
- **Driver.** `wdio-obsidian-service` drives the app through Appium's UiAutomator2 driver. Appium, the driver and `@wdio/appium-service` are a separate npm project (`plugin/test/e2e/android/package.json`, with its own lock file), so the other jobs do not install them. `wdio.android.conf.mts` loads the service from there and sets `APPIUM_HOME` to it, where Appium 3 finds the driver. To run locally, boot an emulator, run `npm ci --prefix plugin/test/e2e/android`, then `VAULT_SYNC_E2E_ANDROID=1 make test-e2e`. Set `ANDROID_HOME` for `adb`, and `ANDROID_SERIAL` if the device is not `emulator-5554`.
- **Network.** `wdio.android.conf.mts` maps the ports of the server and the fake issuer with `adb reverse`, so the device reaches them at the host's `127.0.0.1` addresses. Traffic over `adb reverse` goes through adbd, not the device's network, so airplane mode does not cut it. `device.android.e2e.ts` therefore reaches the server at `http://127.0.0.2:<port>` (vault-sync accepts plain http only to a loopback host). `iptables` NAT rules on the device send that address on to `10.0.2.2`, the emulator's address for the host's loopback. That needs a root adb shell, so the workflow runs `adb root` after boot.
- **Specs.** `*.android.e2e.ts` run only on the Android app (`wdio.conf.mts` excludes them). Specs that need a vault's file-system path or the desktop `FileSystemAdapter` (`atomicity`, `basic-sync`, `offline-conflicts`, `connect`) skip themselves on Android. Platform checks read the platform that Obsidian reports (`obsidianPage.getPlatform()`), not the host's `process.platform`.
- **Failures.** The job uploads the WebdriverIO logs, the device's `logcat`, a screenshot and the emulator's log as the `android-e2e-logs` artifact.

## Writing e2e tests

- Put specs in `plugin/test/e2e/specs/` as `*.e2e.ts`. Functions passed to `browser.executeObsidian` are stringified and run inside Obsidian, so they cannot capture variables or imports. Pass inputs as extra arguments, and use the `obsidian` module from the first argument.
- If code must run inside Obsidian and is too big for one function, put it in the harness plugin as a method. Call it from the spec, as `conformance.e2e.ts` does.
- Do not name a field `status` in a script's result. Appium reads a numeric `status` as a legacy JSONWP error code.
- Do not depend on timing. Wait for conditions (`browser.waitUntil`), never for fixed delays.
- Every new assertion must fail when its behavior breaks. Break the behavior once before you commit, to make sure of this.
