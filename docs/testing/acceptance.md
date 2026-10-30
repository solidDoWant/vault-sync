# Acceptance scoreboard

`make acceptance` runs the acceptance tests of `docs/acceptance/phase-2.md`, `docs/acceptance/phase-3.md` and `docs/acceptance/phase-4.md` and prints, for each checklist, one line per scenario, then the number passing, for example:

```
Phase 2 (docs/acceptance/phase-2.md)
AC-02  no test
AC-03  pass
...
AC-26  no test
passing 1/25

Phase 3 (docs/acceptance/phase-3.md)
P3-01  pass
...
P3-13  pass
passing 6/13

Phase 4 (docs/acceptance/phase-4.md)
P4-01  no test
...
P4-23  no test
passing 5/23
```

The Phase 2 checklist lists its scenarios as `- **AC-nn** …` items, the Phase 3 and Phase 4 ones as `| P3-nn | … |` and `| P4-nn | … |` table rows.

## Naming a test for its scenario

A test belongs to a scenario by its name:

- e2e (`plugin/test/e2e/specs/`), plugin integration (`plugin/test/integration/`), plugin acceptance (`plugin/test/acceptance/`) and plugin unit (`plugin/src/**/*.test.ts`) tests: the `it` title starts with the id, `it("[AC-04] a note created on A appears on B", …)` or `it("[P3-01] …", …)`;
- Go integration tests: the function name starts with `TestAC` and the number, `func TestAC22OfflineRestore(t *testing.T)` (Go function names cannot hold brackets), or a subtest's name starts with the id, `t.Run("[AC-23] a device syncs exactly the imported notes", …)` or `t.Run("[P3-13] …", …)`. A tagged subtest counts by its own result.

A scenario may have several tests.

## What runs

`scripts/acceptance.sh` runs, each against a real server on PostgreSQL and S3 (docker compose, so it needs Docker):

1. the `integration`-tagged Go tests named `TestAC…`, the top-level Go tests that hold an `[AC-nn]`, `[P3-nn]` or `[P4-nn]` subtest (run whole, with their other subtests), and the plugin integration suite (`TestPluginProtocolClient`), whose report it keeps. `TestAC22OfflineRestore` and `TestAC25Convergence` (`cmd/vault-sync-server/acceptance_integration_test.go`) each start the server and run one plugin acceptance suite (`plugin/test/acceptance/*.acceptance.test.ts`, `vitest.acceptance.config.ts`): the real sync engine on in-memory vaults against that server. For AC-22 the Go test also plays the operator, stopping the server, snapshotting and restoring PostgreSQL and S3, and starting it again behind a proxy at a fixed address. AC-25 runs ten fixed seeds; `VAULT_SYNC_AC25_SEED=n` runs only seed `n`, for example to replay a failure (`VAULT_SYNC_AC25_SEED=7 ./scripts/test-integration.sh -run TestAC25 ./cmd/vault-sync-server/`);
2. the plugin unit test files (`plugin/src/**/*.test.ts`) that hold a `[P4-nn]` test, with vitest's JSON report;
3. the desktop e2e spec files that hold an `[AC-nn]`, `[P3-nn]` or `[P4-nn]` test. Whole files run, because a spec's tests build on the ones before them; `plugin/wdio.conf.mts` records each test's result when `VAULT_SYNC_ACCEPTANCE_RESULTS` names a directory.

Android-only specs (`*.android.e2e.ts`) need a device and run only in the `android-e2e` workflow. With `VAULT_SYNC_ACCEPTANCE_RESULTS` set, `plugin/wdio.android.conf.mts` records their tests' results (not those of the specs shared with desktop, which the desktop run reports) in `android-e2e.jsonl`; the workflow uploads it as the `android-e2e-results` artifact. When `VAULT_SYNC_ACCEPTANCE_ANDROID_RESULTS` names a directory holding that file, `scripts/acceptance.sh` adds it to the results, so the scoreboard shows that run's outcome for AC-21 and for P4-15's emulator check (`unlock.android.e2e.ts`). Without it, those scenarios show as `not run`.

A failing suite does not stop the others. Everything lands in `build/acceptance/`: `scoreboard.txt`, the suites' logs and the raw results.

## Statuses

- `pass`: the scenario's tests ran and all passed.
- `fail`: at least one of its tests failed.
- `not run`: it has a test, but none failed and not all of them passed (skipped, or not run at all, e.g. an Android-only spec or a suite that could not start).
- `no test`: no test is named for it.

## CI

The `acceptance` workflow (`.github/workflows/acceptance.yml`) runs `make acceptance` every night on `master` and uploads `build/acceptance/` as the `acceptance-scoreboard` artifact; the scoreboard is also in the run's summary. Before it, it downloads the `android-e2e-results` artifact of the latest completed `android-e2e` run on `master` and names that run (link, time, conclusion) in the summary; both workflows are scheduled at the same time, so that is usually the previous night's run. It is not a required check.

## Removed or skipped scenario tests and vectors

The `test-guard` job of the `ci` workflow, part of the required `checks`, runs `make test-guard` (`scripts/ci/test-guard.py`) on every pull request. It compares the pull request with its merge base and fails, naming each test or vector, when:

- a scenario test that exists at the base is gone: every `[AC-nn]` or `[Pn-nn]` test title (`it`, `test` and `describe`, also with `.each`, and Go `t.Run` subtests) and every `func TestACnn…` must still exist as often as before, in any file. Renaming one counts as deleting it, and so does commenting it out;
- a scenario test is newly skipped: `.skip`, `.skipIf`, `.runIf` or `.todo`, `xit` or `xdescribe`, a skipped `describe` around it, a new `.only` in its file, or more skip calls (`t.Skip`, `t.Skipf`, `t.SkipNow`, `this.skip()`, `ctx.skip()`) in its body than before, for a Go subtest also in its parent test before it. A skip the base already had, such as a platform condition, stays allowed;
- an entry of `testdata/crypto/vectors.json` or `testdata/paths/vectors.json` is gone, rejected sets included. Entries are identified by where they are and their `name` (or `seq`, or position), so regenerated values are fine. A line `Vectors-removed: <reason>` in the pull request body allows removing vectors.

The label `test-removal-approved`, which only the owner applies, turns the check off. The job reads the body and labels when it runs: after adding either, re-run the job.
