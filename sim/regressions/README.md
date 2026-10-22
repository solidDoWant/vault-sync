# Simulation regression cases

Each `*.json` file here is a minimized schedule that once violated an invariant. `make test-sim` replays every one of them on each run, and each must pass. When a seed fails, the harness minimizes it and writes it to this directory. Fix the bug, then commit the file in the same change as the fix. Seeded runs use the faithful filesystem by default, so a failing seed is written as `seed-<seed>-faithful-fs.json` with `"faithfulFilesystem": true` and is replayed on the faithful filesystem. A seed that failed with `SIM_FAITHFUL_FS=0` (the plain path pool, the default before refactor step R7) is written as `seed-<seed>.json`, and every case without the field is replayed with the plain pool (on the faithful vault, as every case is since #797). See `docs/testing/simulation.md`.

## Notes on each case

Every case's notes live in a Markdown file of their own next to it, named after the case: `seed-100069.json`'s are in `seed-100069.md`. Notes that cover several cases are in the file of the first one they name, and an issue reproduced by a scripted scenario instead of a committed seed has its notes in `issue-<number>.md`. When you commit a case, add its notes as a new file; never append them to this README. Two pull requests that each add a case then touch different files, and merge cleanly in either order (#822).
