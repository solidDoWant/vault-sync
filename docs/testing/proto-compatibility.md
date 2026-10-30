# Protobuf compatibility check

For: developers and agents. This page says why `buf breaking` runs, which base it compares against, and what to do when it fails.

`make lint` (and so CI) runs `buf breaking` against `master`. A change to `proto/` that would break existing clients or servers on the wire fails the build. `buf.yaml` uses the `FILE` rule set, the strictest one. Besides wire and JSON compatibility, it also keeps every type in the file that declared it, because the generated Go and TypeScript code depend on that layout.

## How the base is chosen

`scripts/buf-breaking.sh` compares the working tree (`buf.yaml` and `proto/`, with uncommitted changes) against a base commit:

- The base ref is `origin/master`, or `BUF_BREAKING_AGAINST` if it is set (any ref or commit, for example `BUF_BREAKING_AGAINST=HEAD~1`).
- If `origin/master` does not exist locally (a shallow CI checkout, a fork PR, a fresh worktree), the script fetches `master` from `origin` with `--depth=1`. If the base still cannot be resolved, the check fails with a message that says how to fix it. It never skips.
- With full history, the script uses the merge base of `HEAD` and the base, so a branch that is only behind `master` is not blamed for fields that `master` added. A branch that removes a field still fails. In a shallow clone, the script uses the base tip.
- On `pull_request` runs, CI checks out a shallow merge commit that GitHub built on some `master` commit, and `master` can have moved on since. So when `GITHUB_EVENT_NAME` is `pull_request`, the clone is shallow, `HEAD` is a merge commit and `BUF_BREAKING_AGAINST` is not set, the base is the merge commit's first parent. If that cannot be fetched, the script falls back to the `master` tip, which can only fail closed. Outside `pull_request` runs a merge commit's first parent need not be `master`, so this rule is not used there.
- On the `push` run after a merge, the check compares `master` with itself and passes. The `pull_request` run is the gate.

Locally, the script uses `origin/master` as last fetched. Run `git fetch origin master` to compare against the latest `master`.

## Deliberate breaking changes

Do not weaken the rule set. In the PR that needs it, add a narrow `ignore_only` entry under `breaking` in `buf.yaml` (a rule ID mapped to file paths relative to `buf.yaml`), and give the reason in the PR description. Remove the entry in a later PR once the change is on `master`. `buf config ls-breaking-rules` lists the rule IDs, and `./scripts/buf-breaking.sh --error-format=json` shows the rule of each violation.

A known planned case: Phase 5 adds the Yjs realtime frames with field numbers from `reserved 100 to 199` in `ClientFrame` and `ServerFrame` (`proto/vaultsync/v1/realtime.proto`). Shrinking a reserved range trips `RESERVED_MESSAGE_NO_DELETE`, so that PR adds:

```yaml
breaking:
  use:
    - FILE
  ignore_only:
    RESERVED_MESSAGE_NO_DELETE:
      - proto/vaultsync/v1/realtime.proto
```

## Tests

`make test` runs `scripts/buf-breaking_test.sh`. It builds throwaway git repositories from copies of `buf.yaml` and `proto/`, and checks each base rule above and the Phase 5 exception. It never changes the committed schema. The throwaway repositories ignore the global and system git configuration and `GIT_DIR`-style variables, and the suite runs itself once more under a hostile configuration to prove it.
