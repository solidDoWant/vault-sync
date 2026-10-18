# Sync simulation

The simulation harness (`sim/`, SPEC.md §13) checks sync correctness with seeded, multi-client schedules and fault injection, run against a real `vault-sync-server` backed by real PostgreSQL and S3. In Phase 1 the clients are scripted protocol clients and the invariants are server-side. Phase 2 plugs the real `plugin/src/core` engine in and adds engine-level invariants such as convergence.

## Running

```sh
make test-sim                                   # default: 10 seeds × 1000 steps, 3 clients
make test-sim SIM_SEEDS=200 SIM_STEPS=2000      # longer
make test-sim SIM_SEED=1234                     # replay one seed
```

| Variable | Default | Meaning |
|---|---|---|
| `SIM_SEEDS` | `10` | Number of seeds to run, starting at `SIM_FIRST_SEED`. |
| `SIM_FIRST_SEED` | `1` | First seed. |
| `SIM_SEED` | unset | Run only this seed (overrides the two above). |
| `SIM_STEPS` | `1000` | Steps per seeded schedule. |
| `SIM_CLIENTS` | `3` | Simulated clients (devices of one user) per run. |
| `SIM_SHRINK_RUNS` | `150` | Most re-runs spent minimizing a failing seed. |
| `SIM_REGRESSION_DIR` | `sim/regressions` | Where minimized failing seeds are written, and which regression cases are replayed. |
| `SIM_TIMEOUT` | `60m` | `go test -timeout` for the whole run. |

`make test-sim` exits non-zero on any violation. The output names the seed (`SIM FAILURE: seed N ...`), lists the violations, gives the replay command, and shows the end of the minimized schedule's trace. Docker is required. Unlike `make test-integration`, the simulation never skips.

CI runs a short simulation (`SIM_SEEDS=5 SIM_STEPS=1000`) on every pull request, as the `Simulation` step of the required `checks` job. Nightly long runs are tracked in #22.

## How it fits together

- **Driver** (`sim/*_test.go`, Go, build tag `sim`). `scripts/test-sim.sh` starts the compose stack (`scripts/with-test-stack.sh`) and runs `go test -tags sim ./sim/`. The driver creates a database and a bucket, starts a fake OIDC issuer, builds and starts the real server (`VAULT_SYNC_SHUTDOWN_DELAY=0s`, 64 KiB chunks so large contents span several chunks), and serves a loopback **control endpoint** for the harness. That endpoint mints a token for a fresh user for every run, which keeps runs below the per-user vault and device limits. It also checks the invariants directly in PostgreSQL and records failing seeds. The driver then runs `plugin/node_modules/.bin/vitest run --config vitest.sim.config.ts`.
- **Harness** (`sim/*.ts`, TypeScript). It is type-checked with `plugin/src/core` (`plugin/tsconfig.core.json`), so it may not use Node APIs or reach `obsidian`. `plugin/vitest.sim.config.ts` reads the environment and the regression cases and passes them in with vitest `provide`/`inject`. There is no `sim/package.json`. `sim/node_modules` is a committed symlink to `../plugin/node_modules`, so `sim/` resolves the plugin's packages (the same files `src/core` resolves, with their `exports` maps intact), and `scripts/check-core-program.ts` checks its imports against `plugin/package.json`. The pure unit tests (`sim/*.test.ts`) run in `make test`. The networked suite (`sim/*.sim.test.ts`) runs only from `make test-sim`.

## The simulated network and fault injector

Each client reaches the server through a `Transport` from `SimNetwork` (`sim/network.ts`). A call does not go out by itself. It waits until a schedule step delivers it to the server, and its response then waits until a step delivers it back. Time is the step counter, and only one message is in transit to the server at a time, so a run is deterministic. Concurrency is modelled by interleaving. True parallel load on the server is the integration tests' job.

| Step | Effect |
|---|---|
| `operation` | A client starts create, edit, rename, delete or pull, if it is idle. A client that has not pulled since it (re)started pulls first. |
| `deliver-request` / `deliver-response` | The oldest deliverable request reaches the server, or the oldest response reaches its client. |
| `reorder` | A request other than the oldest reaches the server. |
| `delay` | A request is held back for N steps. |
| `drop-request` | A request is lost before the server sees it. The client gets `UNAVAILABLE`. |
| `drop-response` | A response is lost after the server applied the request. The client gets `UNAVAILABLE`. |
| `partition` | A client is cut off for N steps. Everything it has in flight is lost, and new calls wait. |
| `crash` | A client loses all in-memory state and restarts. Requests it already sent may still reach the server, and it never hears their replies. |

The schedule is a pure function of the seed (`sim/schedule.ts`), so the same seed always replays the same operation and fault schedule. Steps choose their targets relative to what is pending at that moment, so any subsequence of a schedule is still valid. Raw ids are random, because one database serves every run. Traces use symbolic labels instead (`c1.d3`: client 1's third document), so a replayed seed produces the identical trace. The determinism test re-runs a seed and compares the two traces.

## Scripted clients

The scripted clients (`sim/client.ts`) follow the protocol's commit discipline (SPEC.md §6.2–6.3):

- They upload content in chunks, resuming from `BeginBlob` after any interruption.
- They commit against the head they know.
- After a lost call they retry with the same revision id.
- On `FAILED_PRECONDITION` they rebase onto the head the error reports.
- On `ALREADY_EXISTS` they retry under a conflict path.

Paths come from a small pool with case and Unicode collisions (`a.md`/`A.md`, `straße.md`/`STRASSE.md`). Contents are often shared between clients, so clients upload identical blobs, and a content is occasionally larger than one chunk. The harness, not the clients, records every revision the server acknowledged, so acknowledgements survive crashes.

## Invariants

After the schedule, the run heals every fault, delivers everything still in flight, and has every client pull. The driver then checks the vault in PostgreSQL (`sim/invariants_test.go`):

| Invariant | Check |
|---|---|
| `history` | Every acknowledged revision is in history, stored exactly as acknowledged. |
| `seq` | The vault's `seq` values are exactly `1..head_seq`: gapless, unique and monotonic. |
| `path-key` | No two live documents share a `path_key`. This is checked directly, not only through the unique index. |
| `stale-base` | Each document's revisions, in `seq` order, form one chain, each based on the previous head. A commit accepted against a stale base forks the chain. |
| `document-head` | Each document row mirrors its head revision (`head_rev_id`, `deleted`, `path_key`). |

The clients also report `protocol` violations: a gap or reordering seen in `ListChanges`, an idempotent retry rejected as stale, or an error code the protocol does not allow for the call. A `liveness` violation means the clients did not quiesce. `TestInvariantChecksDetectEachViolation` corrupts a valid vault in each of these ways and proves that each check catches it.

## The harness has teeth

`TestSimulationDetectsBrokenServer` builds the server with the `simfault` build tag. In that build `internal/store` skips CommitRevision's base-revision check (`skipBaseRevisionCheck`, `internal/store/simfault_on.go`). The test always runs the schedule of CI's short run (seeds 1 to 5, 1000 steps, 3 clients), whatever the `SIM_*` variables say, and requires a `stale-base` violation. Pinning it means a local replay of one seed or a shorter run cannot make the check fail. It then replays the minimized case the harness wrote and requires that the case reproduces the violation. The switch exists only as a build tag. No flag or environment variable reaches it, and `TestDefaultBuildChecksBaseRevision` proves the default build keeps the check. The driver also verifies from each binary's build info that it was built with exactly the tags it asked for.

## Failing seeds and regression cases

A failing seed is minimized (`sim/shrink.ts`): the harness deletes chunks of steps for as long as a violation of the same kind remains, within `SIM_SHRINK_RUNS` re-runs. It then writes the result to `sim/regressions/seed-<seed>.json` with its violations. Every `make test-sim` replays every committed case.

Following CLAUDE.md, a sync bug gets its simulation regression before it is fixed. Commit the case with the fix.

## Scripted scenarios

`sim/scenarios.ts` holds hand-written interleavings that random schedules rarely hit:

- **Lost response after the head moved (#12).** The server applies a commit from c0, but the response is lost. c1 pulls and commits on top of it. c0 then retries with the same revision id and must get its own revision back, not `FAILED_PRECONDITION`.
