# Simulation regression cases

Each `*.json` file here is a minimized schedule that once violated an invariant. `make test-sim` replays every one of them on each run, and each must pass. When a seed fails, the harness minimizes it and writes `seed-<seed>.json` to this directory. Fix the bug, then commit the file in the same change as the fix. See `docs/testing/simulation.md`.

`simfault-stale-base.json` is the exception: it is seed 1 of CI's short run, minimized against the deliberately broken `simfault` server (see "The harness has teeth" in `docs/testing/simulation.md`), where it commits against a stale base. Against the real server the commit is rejected and rebased, so it keeps the base-revision check covered by a short committed case.
