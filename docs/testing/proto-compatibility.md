# Protobuf compatibility check

`make lint` (and therefore CI) runs `buf breaking` against `master`, so a change to `proto/` that would break existing clients or servers on the wire fails the build. The rules come from the `breaking` section of `buf.yaml`, which uses the `FILE` rule set: the strictest one, which besides wire and JSON compatibility also keeps every type in the file that declared it, as the generated Go and TypeScript code depend on that layout.

## How the base is chosen

`scripts/buf-breaking.sh` compares the working tree (`buf.yaml` + `proto/`, including uncommitted changes) against a base commit:

- The base ref is `origin/master`, or `BUF_BREAKING_AGAINST` if set (any ref or commit, e.g. `BUF_BREAKING_AGAINST=HEAD~1`).
- If `origin/master` does not exist locally (a shallow CI checkout, a fork PR, a fresh worktree), the script fetches `master` from `origin` with `--depth=1`. For pull requests, including ones from forks, `actions/checkout` points `origin` at the base repository, so no workflow configuration is needed.
- If the base still cannot be resolved (no network, no `origin` remote), the check fails with a message saying how to fix it. It never skips.
- When the history is available, the merge-base of `HEAD` and the base is used, so a branch that is merely behind `master` is not blamed for fields added on `master` since. A branch that removes a field still fails, whether or not it is behind `master` or has `master` merged back in. In a shallow clone the base tip is used.
- On `pull_request` runs, CI checks out a shallow PR merge commit that GitHub built on top of some `master` commit (its first parent). `master` may have moved on since, and comparing the merge commit against the newer tip would report fields added on `master` as deletions. So when the repository is shallow, `HEAD` is a merge commit and `BUF_BREAKING_AGAINST` is not set, the base is the merge commit's first parent, fetched from `origin` by SHA if needed. If it cannot be fetched, the script falls back to the `master` tip, which can only fail closed, and it still fails if no base can be resolved.
- On the `push` run after a PR merges, `HEAD` is the new `master` commit and `origin/master` points at it, so the check compares `master` with itself and passes trivially. That is intended: the `pull_request` run is the gate, and the `push` run only re-runs the rest of CI.

Locally, `origin/master` is used as last fetched; run `git fetch origin master` to compare against the latest `master`.

## Deliberate breaking changes

Do not weaken the rule set. Add a narrowly scoped `ignore_only` entry under `breaking` in `buf.yaml` (rule ID mapped to file paths relative to `buf.yaml`) in the PR that needs it, justify it in the PR description, and remove the entry in a follow-up PR once the change is on `master`. Rule IDs are listed by `buf config ls-breaking-rules`, and `./scripts/buf-breaking.sh --error-format=json` shows the rule each violation came from.

Known planned case: Phase 5 adds the Yjs realtime frames using field numbers from `reserved 100 to 199` in `ClientFrame` and `ServerFrame` (`proto/vaultsync/v1/realtime.proto`). Shrinking a reserved range trips `RESERVED_MESSAGE_NO_DELETE`, so that PR adds:

```yaml
breaking:
  use:
    - FILE
  ignore_only:
    RESERVED_MESSAGE_NO_DELETE:
      - proto/vaultsync/v1/realtime.proto
```

## Tests

`make test` runs `scripts/buf-breaking_test.sh`, which builds throwaway git repositories from copies of `buf.yaml` and `proto/` and checks that removing or renumbering a field fails, adding a field passes, a branch behind `master` passes, a branch behind `master` that removes a field fails (also after merging `master` back in), a shallow clone without `origin/master` fetches the base and still detects a removal, a shallow PR merge commit passes after `master` gained a field but fails when the PR removes one, an unreachable base fails, and the Phase 5 exception above works. The committed schema is never modified. The throwaway repositories ignore the global and system git config and any `GIT_DIR`-style environment variables, and the suite re-runs itself once under a hostile config (`commit.gpgsign=true`, a failing hook, an exported `GIT_DIR`) to prove it.
