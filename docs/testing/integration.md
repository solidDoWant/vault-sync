# Integration tests

Server integration tests run against a real PostgreSQL and a real S3-compatible object store. They are Go tests guarded by the `integration` build tag, so `make test` never runs them.

## Running

```sh
make test-integration
```

This runs `scripts/test-integration.sh`, which uses `scripts/with-test-stack.sh` (shared with `make test-sim`, see `simulation.md`) to:

1. start the stack in `deploy/compose/compose.test.yaml` under a compose project name unique to the run, waiting until every service is healthy;
2. export the connection details below;
3. run `go test -race -count=1 -tags integration ./...`;
4. remove the containers, network, and volumes on exit, whether the tests passed, failed, or were interrupted.

To run a subset, call the script with `go test` arguments, for example `./scripts/test-integration.sh -run TestMigrate -v ./internal/store/`.

Without Docker the script prints a notice and still runs the tests; every test that needs a dependency skips with a message naming the missing environment variable.

## Stack

| Service | Image | Notes |
|---|---|---|
| `postgres` | `postgres:18.6-alpine`, pinned by digest | Data on tmpfs, `fsync` off. |
| `s3` | `versity/versitygw:v1.9.0`, pinned by digest | S3 gateway over a POSIX directory on tmpfs. MinIO no longer publishes images. |

Host ports are ephemeral and bound to `127.0.0.1`, so several runs can proceed in parallel. Renovate keeps the tags and digests current.

## Environment

The script exports these variables; set them yourself to point the tests at other instances.

| Variable | Meaning |
|---|---|
| `VAULT_SYNC_TEST_DATABASE_URL` | `postgres://` URL of a role allowed to `CREATE DATABASE`. |
| `VAULT_SYNC_TEST_S3_ENDPOINT` | Base URL of the S3 API. |
| `VAULT_SYNC_TEST_S3_REGION` | S3 region. |
| `VAULT_SYNC_TEST_S3_ACCESS_KEY` | S3 access key id. |
| `VAULT_SYNC_TEST_S3_SECRET_KEY` | S3 secret access key. |

## Plugin protocol client against the real server

`cmd/vault-sync-server/client_integration_test.go` (`TestPluginProtocolClient`) checks that the plugin's protocol client (`plugin/src/core/protocol`) works against a real server. The Go test:

1. creates a database with `testinfra.PostgresConfig` (so it skips without Docker, like the other tests);
2. starts a fake OIDC issuer (`internal/auth/authtest`) on a loopback port and mints a valid access token and one signed by a key the issuer never published;
3. builds the server binary and starts it on ephemeral loopback ports, pointed at the database and the fake issuer;
4. runs the locally installed `node_modules/.bin/vitest run --config vitest.integration.config.ts` in `plugin/` (not `npx`, so it never fetches a package), passing the server URL and tokens in `VAULT_SYNC_IT_SERVER_URL`, `VAULT_SYNC_IT_TOKEN` and `VAULT_SYNC_IT_FOREIGN_TOKEN`, and fails unless every test in that suite ran and passed.

The vitest suite (`plugin/test/integration/*.integration.test.ts`) skips itself when those variables are unset, and `plugin/vitest.config.ts` excludes it, so `make test` and plain `npm test` never touch the network. `make test-integration` installs the plugin's npm dependencies first, since the Go test needs `vitest`. To run only this test: `./scripts/test-integration.sh -run TestPluginProtocolClient -v ./cmd/vault-sync-server/`.

## Multi-instance and rolling-upgrade tests

The high-availability requirement (SPEC.md §12) is proven by tests that run several server processes against one test database and one test bucket. The helpers live in `cmd/vault-sync-server/instances_integration_test.go`.

- `ha_integration_test.go` covers three cases. In the first, consecutive requests, including the chunks and commit of one upload, alternate between instances. In the second, an instance is `SIGKILL`ed mid-chunk and another mid-commit, and the client retries on a third. In the third, an instance receives `SIGTERM` while a client alternates between it and another instance.
- `upgrade_integration_test.go` (`TestRollingUpgrade`) builds the **previous release** from git history (`git archive` of that revision, then `go build`). It runs that build beside this one on one database: the previous release migrates first, then the new one migrates while the previous one is serving. Both then serve mixed traffic, and the previous release is restarted on the newer schema. A migration that the previous release cannot run against fails this test. The previous release is the merge base of `HEAD` and `origin/master`, or `HEAD^` when `HEAD` is on master. Set `VAULT_SYNC_TEST_PREVIOUS_RELEASE` to any git revision to override it. Without the needed git history the test skips locally and fails in CI (`CI` set), which is why the workflow checks out with `fetch-depth: 0`.
- `internal/blobstore/ha_integration_test.go` runs the upload cleaner of four simulated instances at once. It checks that every abandoned session is removed exactly once and that no instance logs a warning or an error.

## Writing integration tests

- Start the file with `//go:build integration`.
- Use `internal/testinfra`: `testinfra.PostgresConfig(t)` creates an empty database for the test (dropped at cleanup) and returns a `store.Config`; `testinfra.S3(t)` returns the object store's connection details. Both skip the test when their variables are unset.
- Apply the schema with `store.Migrate` on the test's own database; never share databases between tests.
- Start child processes (the server binary, node) with `newChild` in `cmd/vault-sync-server/process_integration_test.go` (or its exported twin `testinfra.NewChild`, which tests outside that package use), not bare `exec.Command`. `go test -timeout` panics without running `t.Cleanup`, so a plain child, and anything it spawned, would outlive the test. A `newChild` process is SIGKILLed shortly before the test binary's deadline and at cleanup. On Linux this kill reaches its whole process group, so grandchildren die too, and the kernel also kills the child if the test binary dies first (`Pdeathsig`).
