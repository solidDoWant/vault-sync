# Sync simulation

The simulation harness (`sim/`, SPEC.md §13) checks sync correctness with seeded, multi-client schedules and fault injection, run against a real `vault-sync-server` backed by real PostgreSQL and S3. In Phase 1 the clients are scripted protocol clients and the invariants are server-side. Phase 2 plugs the real `plugin/src/core` engine in. Its pull side already runs as the engine observer (below), with convergence invariants. The full engine-level invariants are #22.

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

## The engine observer

Each run also has one client driven by the real sync engine (`sim/engine-observer.ts`), with its own registered device. It is labelled `e<N>`, where N is the number of scripted clients, and it reaches the server through the same simulated network, so drops, reordering and delays hit its `ListChanges`, `DownloadBlob` and `GetRevision` calls too. It starts a pull whenever a schedule step asks any client to pull (if it is idle), and it crashes whenever client 0 crashes. A crash discards the engine and its in-flight calls but keeps its in-memory vault and journal, as a killed app keeps its disk. In seeded schedules it never edits locally. Only scripted scenarios edit its vault and make it push (random engine edits are #22), and their edits are excluded from the `engine-echo` check. A scenario may also start more than one engine (`RunOptions.engines`). Every engine pulls when a step asks a client to pull, and every engine is checked at the end. Only the first one crashes with client 0. The revisions its pushes get acknowledged are recorded like the scripted clients' ones, so the `history` invariant covers them. Adding it did not change the schedule format, so committed regression cases replay unchanged, though their traces now include its calls.

At the end of the run it pulls once more without faults, and the harness checks it against the server's live heads, which it reads itself with fault-free `ListChanges` calls, independently of the engine:

| Invariant | Check |
|---|---|
| `engine-convergence` | The observer's vault holds exactly the live documents' paths with their head content (by hash), and its cursor is the feed's last `seq`. |
| `engine-deferred` | It deferred no revision. It has no local changes, so every deferral would be a bug. |
| `engine-echo` | It reported none of its own writes, renames or deletes as local changes. |

An `engine` violation means one of its pulls failed with something other than a network fault.

## Invariants

After the schedule, the run heals every fault, delivers everything still in flight, and has every client pull. The driver then checks the vault in PostgreSQL (`sim/invariants_test.go`):

| Invariant | Check |
|---|---|
| `history` | Every acknowledged revision is in history, stored exactly as acknowledged. |
| `seq` | The vault's `seq` values are exactly `1..head_seq`: gapless, unique and monotonic. |
| `path-key` | No two live documents share a `path_key`. This is checked directly, not only through the unique index. |
| `path-folder` | No live document's `path_key` is a folder (a proper prefix ending before a `/`) of another live document's (SPEC.md §5). |
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
- **Engine push under faults (#17).** The engine edits a document c0 created and pushes three times. First, its `CommitRevision` response is lost, and the retry with the same revision id must be acknowledged once and never conflict. Second, c1 moves the head between the engine's pull and its commit. The engine must pull, merge (the scenario's hook keeps both sides) and commit on top of c1's revision. Third, a 150 KiB upload loses its second chunk and the engine crashes. After the restart, the upload must resume at the server's received size without sending the first chunk again. The run must end with no violations, and the engine's copy must equal the server's head.
- **Engines edit concurrently (#18).** Two engines (`e1` and `e2`, after one scripted client) use their default three-way merge hook. Their clocks are fixed, so conflict-copy names replay identically. Each phase starts with both engines changing their vaults. `e2`'s push runs until its `CommitRevision` is next. Then `e1`'s push commits, and only after that does `e2`'s commit reach the server, which refuses it. `e2` then pulls, merges and commits again. The phases cover: non-overlapping edits of a note (merged, and the merged commit's response is lost once); overlapping edits (a conflict copy, and `e2` crashes after the merge, before it uploads the copy); concurrent edits of a binary file; a CRLF conversion against a line edit (merged); two creates at one path; and two creates at paths that differ only by case. The run must end with no violations, every phase's first commit from `e2` must have been refused, both vaults must be identical and hold the expected files (no conflict markers), and `e2`'s conflict log must list the four conflicts.
- **Remote rename onto an unsynced local file (#18, review of #173).** `e1` renames a synced note from `notes/a.md` to `notes/c.md` and appends a line, while `e2` has created an unrelated note of its own at `notes/c.md` and not pushed it. `e2` pulls, crashes, and pushes after the restart. Its own note must never be merged into the renamed one: both vaults must hold the renamed note, with `e1`'s line, at `notes/c.md` and `e2`'s note whole as a conflict copy next to it. `e2`'s conflict log must list one `concurrent-create` conflict, and the run must end with no violations.
- **Structural operations (#19).** Two engines, raced as in the #18 scenario, rename, delete, create and move folders: a rename on `e1` against an edit on `e2` (the merged commit's response is lost once), a delete against an edit and an edit against a delete (`e2` crashes after the refusal), creates at one path (with a crash), a folder of twelve notes renamed (`InMemoryVault.renameFolder` reports it as one rename per file, as Obsidian does), a folder renamed while `e2` edits a note in it, a rename chain across the engines (`A` to `B` on `e1`, then `B` to `C` on `e2`), and a chain on one engine (`b` to `c`, then `a` to `b`) while the other edits both notes, a file created on one engine at a path where the other created a folder of notes, both ways (the server refuses file/folder collisions, #134: the notes move into a conflict-named folder, or the file gets the conflict name), and an untracked file that `e2`'s user renames off a path the merge path holds while `e2`'s hook defers the document `e1` renamed there (review of #196: the file must reach the server under its new name before the hook merges the document). Both vaults must end identical with the expected files: every edit kept, a delete never winning over an edit, one conflict copy for the two creates, the conflict log listing each. Every document must keep its id through its renames, delete and edits (nothing is re-created), the server must hold exactly the expected documents, and the folder rename must upload and download no content. The run must end with no violations.
