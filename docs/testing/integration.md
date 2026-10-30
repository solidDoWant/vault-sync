# Integration tests

For: developers and agents. This page says how to run the server integration tests and how to write one.

Server integration tests run against a real PostgreSQL and a real S3-compatible object store. They are Go tests with the `integration` build tag, so `make test` never runs them.

## Running

```sh
make test-integration
```

This runs `scripts/test-integration.sh`. It uses `scripts/with-test-stack.sh` (shared with `make test-e2e`, see `e2e.md`) to:

1. Start the stack in `deploy/compose/compose.test.yaml` under a compose project name unique to the run, and wait until every service is healthy.
2. Export the connection details below.
3. Run `go test -race -count=1 -tags integration ./...`.
4. Remove the containers, network and volumes on exit, also when the tests fail or are interrupted.

To run a subset, give the script `go test` arguments, for example `./scripts/test-integration.sh -run TestMigrate -v ./internal/store/`.

Without Docker, the script prints a notice and still runs the tests. Every test that needs a dependency then skips with a message that names the missing variable.

## Stack

| Service | Image | Notes |
|---|---|---|
| `postgres` | `mirror.gcr.io/library/postgres:18.6-alpine`, pinned by digest | Data on tmpfs, `fsync` off. |
| `s3` | `mirror.gcr.io/versity/versitygw:v1.9.0`, pinned by digest | S3 gateway over a POSIX directory on tmpfs. MinIO no longer publishes images. |

Host ports are ephemeral and bound to `127.0.0.1`, so several runs can go on in parallel. Renovate keeps the tags and digests current.

No image comes from Docker Hub, because its outages and rate limits failed CI. Both come from Google's mirror of Docker Hub, `mirror.gcr.io`, which serves the same content with the same digests. ECR Public is not used, because GitHub's shared runner IPs use up its anonymous data limit. There is no fallback registry.

- `scripts/test-images.sh` pulls the images before the stack starts. It skips images that are already present, and retries a failed pull three times: after 5, 15 and 45 seconds, or after 60, 120 and 240 seconds when the registry answers with a rate limit (`toomanyrequests`, HTTP 429).
- In CI, every Linux job that starts the stack first runs `.github/actions/test-images`. It restores the images from an actions cache keyed on the compose files (`docker save`/`docker load`), so CI contacts the registry only when a digest changes. A failed pull there does not fail the job, because the stack's own pull retries. The action switches Docker to the containerd image store, the only store where a loaded image still answers to its digest reference.
- `mirror.gcr.io` lists only the tags that someone pulled through it, so Renovate can offer a new release later than Docker Hub has it.
- When you bump versitygw, also run `scripts/with-native-s3.sh --update-pin vX.Y.Z`. It rewrites the script's version and per-asset SHA-256s from the release's `checksums.txt`. On Renovate's pull requests, the `renovate-fixups` workflow does this.

## PostgreSQL 14, the minimum supported version

The server supports PostgreSQL 14 or newer (`SPEC.md` §3, §12), but the stack above runs the newest PostgreSQL. So that no migration or query needs a feature newer than 14, the tests that depend on the schema also run on PostgreSQL 14:

```sh
make test-integration-postgres14
```

This runs `scripts/test-integration-postgres14.sh`. It starts the stack with `VAULT_SYNC_TEST_POSTGRES_VERSION=14` and runs every test in `./internal/store/` plus `TestRollingUpgrade` in `./cmd/vault-sync-server/`. Unlike `make test-integration`, it fails without Docker. CI runs it as the `integration-postgres14` job, which the required `checks` job covers.

`VAULT_SYNC_TEST_POSTGRES_VERSION` works with any script built on `scripts/with-test-stack.sh`. It applies the compose override `deploy/compose/compose.test-postgres<version>.yaml`. Only `compose.test-postgres14.yaml` exists: it pins `mirror.gcr.io/library/postgres:14.24-alpine` by digest and changes nothing else. The script fails if the override does not exist or the server reports a different major version. Renovate updates the override's minor version and digest, but never proposes a new major version for it.

## Environment

The script exports these variables. Set them yourself to point the tests at other instances.

| Variable | Meaning |
|---|---|
| `VAULT_SYNC_TEST_DATABASE_URL` | `postgres://` URL of a role allowed to `CREATE DATABASE`. |
| `VAULT_SYNC_TEST_S3_ENDPOINT` | Base URL of the S3 API. |
| `VAULT_SYNC_TEST_S3_REGION` | S3 region. |
| `VAULT_SYNC_TEST_S3_ACCESS_KEY` | S3 access key id. |
| `VAULT_SYNC_TEST_S3_SECRET_KEY` | S3 secret access key. |

## Plugin protocol client against the real server

`TestPluginProtocolClient` (`cmd/vault-sync-server/client_integration_test.go`) starts a fake OIDC issuer (`internal/auth/authtest`) and a real server. It then runs the plugin's vitest suite `plugin/test/integration/*.integration.test.ts` with the locally installed `vitest` (never `npx`), and passes the server URL and tokens in `VAULT_SYNC_IT_SERVER_URL`, `VAULT_SYNC_IT_TOKEN` and `VAULT_SYNC_IT_FOREIGN_TOKEN`. It fails unless every test in that suite ran and passed. The vitest suite skips itself without those variables, and `plugin/vitest.config.ts` excludes it, so `make test` and `npm test` never touch the network. `make test-integration` installs the plugin's npm dependencies first.

## Multi-instance and rolling-upgrade tests

Tests that run several server processes against one database and one bucket prove the high-availability requirement (SPEC.md §12). Their helpers are in `cmd/vault-sync-server/instances_integration_test.go`.

`TestRollingUpgrade` (`upgrade_integration_test.go`) builds the previous release from git history and runs it beside this build on one database, with mixed traffic before and after the new migrations. A migration that the previous release cannot run against fails this test. The previous release is the merge base of `HEAD` and `origin/master`, or `HEAD^` when `HEAD` is on master. Set `VAULT_SYNC_TEST_PREVIOUS_RELEASE` to any git revision to override it. Without the git history, the test skips locally and fails in CI (`CI` set), so the workflow checks out with `fetch-depth: 0`.

## Writing integration tests

- Start the file with `//go:build integration`.
- Use `internal/testinfra`. `testinfra.PostgresConfig(t)` creates an empty database for the test (dropped at cleanup) and returns a `store.Config`. `testinfra.S3(t)` returns the object store's connection details. Both skip the test when their variables are unset.
- Apply the schema with `store.Migrate` on the test's own database. Never share a database between tests.
- Start child processes (the server binary, node) with `testinfra.NewChild` (`internal/testinfra/process.go`), not with a bare `exec.Command`, and build the server with `testinfra.BuildServer`. `go test -timeout` panics without running `t.Cleanup`, so a plain child, and anything it started, would outlive the test. A `NewChild` process is killed (SIGKILL) shortly before the test binary's deadline and at cleanup. On Linux the kill reaches the whole process group, and the kernel also kills the child if the test binary dies first (`Pdeathsig`).
