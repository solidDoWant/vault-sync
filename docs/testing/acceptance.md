# Acceptance scoreboard

`make acceptance` runs the acceptance tests of `docs/acceptance/phase-2.md` and prints one line per scenario, then the number passing, for example:

```
AC-02  no test
AC-03  pass
...
AC-26  no test
passing 1/25
```

## Naming a test for its scenario

A test belongs to a scenario by its name:

- e2e (`plugin/test/e2e/specs/`), plugin integration (`plugin/test/integration/`) and plugin acceptance (`plugin/test/acceptance/`) tests: the `it` title starts with the id, `it("[AC-04] a note created on A appears on B", …)`;
- Go integration tests: the function name starts with `TestAC` and the number, `func TestAC22OfflineRestore(t *testing.T)` (Go function names cannot hold brackets), or a subtest's name starts with the id, `t.Run("[AC-23] a device syncs exactly the imported notes", …)`. A tagged subtest counts by its own result.

A scenario may have several tests.

## What runs

`scripts/acceptance.sh` runs, each against a real server on PostgreSQL and S3 (docker compose, so it needs Docker):

1. the `integration`-tagged Go tests named `TestAC…`, the top-level Go tests that hold an `[AC-nn]` subtest (run whole, with their other subtests), and the plugin integration suite (`TestPluginProtocolClient`), whose report it keeps. `TestAC22OfflineRestore` and `TestAC25Convergence` (`cmd/vault-sync-server/acceptance_integration_test.go`) each start the server and run one plugin acceptance suite (`plugin/test/acceptance/*.acceptance.test.ts`, `vitest.acceptance.config.ts`): the real sync engine on in-memory vaults against that server. For AC-22 the Go test also plays the operator, stopping the server, snapshotting and restoring PostgreSQL and S3, and starting it again behind a proxy at a fixed address. AC-25 runs ten fixed seeds; `VAULT_SYNC_AC25_SEED=n` runs only seed `n`, for example to replay a failure (`VAULT_SYNC_AC25_SEED=7 ./scripts/test-integration.sh -run TestAC25 ./cmd/vault-sync-server/`);
2. the desktop e2e spec files that hold an `[AC-nn]` test. Whole files run, because a spec's tests build on the ones before them; `plugin/wdio.conf.mts` records each test's result when `VAULT_SYNC_ACCEPTANCE_RESULTS` names a directory.

Android-only specs (`*.android.e2e.ts`) need a device and run only in the `android-e2e` workflow, so their scenarios show as `not run` here.

A failing suite does not stop the others. Everything lands in `build/acceptance/`: `scoreboard.txt`, the suites' logs and the raw results.

## Statuses

- `pass`: the scenario's tests ran and all passed.
- `fail`: at least one of its tests failed.
- `not run`: it has a test, but none failed and not all of them passed (skipped, or not run at all, e.g. an Android-only spec or a suite that could not start).
- `no test`: no test is named for it.

## CI

The `acceptance` workflow (`.github/workflows/acceptance.yml`) runs `make acceptance` every night on `master` and uploads `build/acceptance/` as the `acceptance-scoreboard` artifact; the scoreboard is also in the run's summary. It is not a required check.
