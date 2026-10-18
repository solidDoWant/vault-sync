#!/usr/bin/env bash
# Tests scripts/buf-breaking.sh end to end with the real buf.yaml and proto/
# schema. Each case builds a throwaway git repository (plus a bare "origin")
# in a temporary directory from copies of the committed files, mutates the
# copy, and runs the breaking check there. The committed schema is never
# touched.
#
# The throwaway repositories are isolated from the developer's git setup: the
# global and system config (commit.gpgsign, core.hooksPath, ...) and any
# config, repository or index exported through the environment (e.g. when
# `make test` runs from a git hook) are ignored. The last case re-runs the
# suite with a hostile config and GIT_DIR to prove it.
set -euo pipefail

# `git rev-parse --local-env-vars` lists every repository-local variable
# (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_PARAMETERS, ...).
# shellcheck disable=SC2046 # one variable name per word
unset $(git rev-parse --local-env-vars)
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
check="$repo_root/scripts/buf-breaking.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
pass() { echo "ok   - $1"; }
fail() {
	echo "FAIL - $1" >&2
	failures=$((failures + 1))
}

git_quiet() { git -c init.defaultBranch=master -c advice.detachedHead=false "$@" >/dev/null 2>&1; }

# new_repo DIR: a clone of a bare origin whose master holds the committed
# schema, checked out on a feature branch.
new_repo() {
	local dir="$1" seed="$work/seed-$RANDOM$RANDOM"
	mkdir -p "$seed"
	cp "$repo_root/buf.yaml" "$seed/"
	cp -R "$repo_root/proto" "$seed/"
	git_quiet -C "$seed" init
	git_quiet -C "$seed" -c user.name=test -c user.email=test@example.com add buf.yaml proto
	git_quiet -C "$seed" -c user.name=test -c user.email=test@example.com commit -m base
	git_quiet clone --bare "$seed" "$dir.origin.git"
	git_quiet clone "$dir.origin.git" "$dir"
	git_quiet -C "$dir" checkout -b feature
}

commit_all() {
	git_quiet -C "$1" -c user.name=test -c user.email=test@example.com commit -am "$2"
}

# add_field_on_master DIR: commits and pushes a new field on master (after the
# last field of $target_file, away from the first one the cases edit), then
# returns to the feature branch.
add_field_on_master() {
	local dir="$1"
	git_quiet -C "$dir" checkout master
	sed -i -E "${last_field_line_number}a\\  // Added on master by the compatibility test.\\n  string compatibility_test_master_added = 4998;" "$dir/$target_file"
	commit_all "$dir" "add a field on master"
	git_quiet -C "$dir" push origin master
	git_quiet -C "$dir" checkout feature
}

# shallow_pr_merge DIR CLONE: emulates a pull_request CI run. Merges the
# feature branch of DIR into master as refs/pull/1/merge on its origin, then
# advances master with a new field, and checks the merge ref out in CLONE the
# way actions/checkout does (depth 1, detached, no origin/master ref).
shallow_pr_merge() {
	local dir="$1" clone="$2"
	git_quiet -C "$dir" checkout -b pr-merge master
	git_quiet -C "$dir" -c user.name=test -c user.email=test@example.com merge --no-ff --no-edit feature
	git_quiet -C "$dir" push origin HEAD:refs/pull/1/merge
	git_quiet -C "$dir" checkout feature
	add_field_on_master "$dir"
	git_quiet init "$clone"
	git_quiet -C "$clone" remote add origin "file://$dir.origin.git"
	git_quiet -C "$clone" fetch --depth=1 --no-tags origin +refs/pull/1/merge:refs/remotes/pull/1/merge
	git_quiet -C "$clone" checkout --detach refs/remotes/pull/1/merge
}

# run_check DIR: runs the check in DIR, capturing combined output in $output
# and the exit status in $status. JSON errors include the violated rule ID.
run_check() {
	local dir="$1"
	set +e
	output="$(cd "$dir" && "$check" --error-format=json 2>&1)"
	status=$?
	set -e
}

# The first scalar field declaration in sync.proto, e.g. "  string vault_id = 1;".
target_file=proto/vaultsync/v1/sync.proto
field_line="$(grep -nE '^  [a-z0-9_.]+ [a-z0-9_]+ = [0-9]+;' "$repo_root/$target_file" | head -n 1)"
field_line_number="${field_line%%:*}"
last_field_line="$(grep -nE '^  [a-z0-9_.]+ [a-z0-9_]+ = [0-9]+;' "$repo_root/$target_file" | tail -n 1)"
last_field_line_number="${last_field_line%%:*}"
[[ -n "$field_line_number" && $((last_field_line_number - field_line_number)) -gt 3 ]] || {
	echo "could not find two field declarations far enough apart in $target_file" >&2
	exit 1
}

# Case: the unmodified schema passes.
repo="$work/unchanged"
new_repo "$repo"
run_check "$repo"
if [[ $status -eq 0 ]]; then pass "unchanged schema passes"; else fail "unchanged schema passes: $output"; fi

# Case: removing a field fails.
repo="$work/remove"
new_repo "$repo"
sed -i "${field_line_number}d" "$repo/$target_file"
commit_all "$repo" "remove a field"
run_check "$repo"
if [[ $status -ne 0 && "$output" == *FIELD_NO_DELETE* ]]; then
	pass "field removal fails"
else
	fail "field removal fails (status $status): $output"
fi

# Case: renumbering a field fails.
repo="$work/renumber"
new_repo "$repo"
sed -i -E "${field_line_number}s/= [0-9]+;/= 4999;/" "$repo/$target_file"
commit_all "$repo" "renumber a field"
run_check "$repo"
if [[ $status -ne 0 && "$output" == *FIELD_NO_DELETE* ]]; then
	pass "field renumbering fails"
else
	fail "field renumbering fails (status $status): $output"
fi

# Case: adding a field (backward compatible) passes. Uncommitted changes are
# checked too, since buf reads the working tree.
repo="$work/add"
new_repo "$repo"
sed -i -E "${field_line_number}a\\  // Added by the compatibility test.\\n  string compatibility_test_added = 4999;" "$repo/$target_file"
run_check "$repo"
if [[ $status -eq 0 ]] && ! git -C "$repo" diff --quiet; then
	pass "field addition passes"
else
	fail "field addition passes (status $status): $output"
fi

# Case: a branch that is merely behind master (master gained a field after
# the branch point) is compared against the merge-base, so it passes.
repo="$work/behind"
new_repo "$repo"
git_quiet -C "$repo" checkout master
sed -i -E "${field_line_number}a\\  // Added on master by the compatibility test.\\n  string compatibility_test_added = 4999;" "$repo/$target_file"
commit_all "$repo" "add a field on master"
git_quiet -C "$repo" push origin master
git_quiet -C "$repo" checkout feature
run_check "$repo"
if [[ $status -eq 0 ]]; then
	pass "branch behind master is compared against the merge-base"
else
	fail "branch behind master is compared against the merge-base (status $status): $output"
fi

# Case: a branch behind master that also removes a field still fails, both as
# is and after merging master back in (no conflict: the edits are far apart).
repo="$work/behind-remove"
new_repo "$repo"
add_field_on_master "$repo"
sed -i "${field_line_number}d" "$repo/$target_file"
commit_all "$repo" "remove a field"
run_check "$repo"
if [[ $status -ne 0 && "$output" == *FIELD_NO_DELETE* ]]; then
	pass "branch behind master that removes a field fails"
else
	fail "branch behind master that removes a field fails (status $status): $output"
fi
git_quiet -C "$repo" fetch origin
git_quiet -C "$repo" -c user.name=test -c user.email=test@example.com merge --no-edit origin/master
if [[ -z "$(git -C "$repo" rev-parse --verify --quiet HEAD^2)" ]]; then
	fail "behind-remove setup: merging master back in did not create a merge commit"
fi
run_check "$repo"
if [[ $status -ne 0 && "$output" == *FIELD_NO_DELETE* ]]; then
	pass "branch that removes a field and merges master back in fails"
else
	fail "branch that removes a field and merges master back in fails (status $status): $output"
fi

# Case: CI-style shallow clone of a PR head with no origin/master ref; the
# check fetches the base itself and still detects a removal.
repo="$work/shallow"
new_repo "$repo"
sed -i "${field_line_number}d" "$repo/$target_file"
commit_all "$repo" "remove a field"
git_quiet -C "$repo" push origin feature
shallow="$work/shallow-clone"
git_quiet clone --depth=1 --branch feature "file://$repo.origin.git" "$shallow"
git_quiet -C "$shallow" update-ref -d refs/remotes/origin/master || true
if git -C "$shallow" rev-parse --verify --quiet refs/remotes/origin/master >/dev/null; then
	fail "shallow clone setup: origin/master unexpectedly present"
fi
run_check "$shallow"
if [[ $status -ne 0 && "$output" == *FIELD_NO_DELETE* ]]; then
	pass "shallow clone without origin/master fetches the base and detects a removal"
else
	fail "shallow clone without origin/master fetches the base and detects a removal (status $status): $output"
fi

# Case: CI-style shallow checkout of a PR merge commit (refs/pull/N/merge)
# after master moved on and gained a field. The merge commit's first parent is
# the master commit it was built on; comparing against the newer master tip
# would report master's addition as a deletion.
repo="$work/pr-merge"
new_repo "$repo"
sed -i -E "${field_line_number}i\\  // Comment-only change on the PR branch." "$repo/$target_file"
commit_all "$repo" "comment-only change"
shallow_pr_merge "$repo" "$work/pr-merge-clone"
run_check "$work/pr-merge-clone"
if [[ $status -eq 0 ]]; then
	pass "shallow PR merge commit is compared against its first parent, not a newer master"
else
	fail "shallow PR merge commit is compared against its first parent, not a newer master (status $status): $output"
fi

# Case: the same CI-style PR merge commit, but the PR removes a field: fails.
repo="$work/pr-merge-remove"
new_repo "$repo"
sed -i "${field_line_number}d" "$repo/$target_file"
commit_all "$repo" "remove a field"
shallow_pr_merge "$repo" "$work/pr-merge-remove-clone"
run_check "$work/pr-merge-remove-clone"
if [[ $status -ne 0 && "$output" == *FIELD_NO_DELETE* ]]; then
	pass "shallow PR merge commit that removes a field fails"
else
	fail "shallow PR merge commit that removes a field fails (status $status): $output"
fi

# Case: the base is unreachable (no remote at all): fail loudly, never skip.
repo="$work/unreachable"
new_repo "$repo"
git_quiet -C "$repo" remote remove origin
run_check "$repo"
if [[ $status -ne 0 && "$output" == *"cannot resolve the base"* ]]; then
	pass "unreachable base fails with a clear message"
else
	fail "unreachable base fails with a clear message (status $status): $output"
fi

# Case: a shallow PR merge commit whose first parent and master are both
# unreachable fails loudly too.
repo="$work/pr-merge-unreachable"
new_repo "$repo"
sed -i -E "${field_line_number}i\\  // Comment-only change on the PR branch." "$repo/$target_file"
commit_all "$repo" "comment-only change"
shallow_pr_merge "$repo" "$work/pr-merge-unreachable-clone"
git_quiet -C "$work/pr-merge-unreachable-clone" remote remove origin
run_check "$work/pr-merge-unreachable-clone"
if [[ $status -ne 0 && "$output" == *"cannot resolve the base"* ]]; then
	pass "shallow PR merge commit with an unreachable base fails with a clear message"
else
	fail "shallow PR merge commit with an unreachable base fails with a clear message (status $status): $output"
fi

# Case: BUF_BREAKING_AGAINST overrides the base ref.
repo="$work/override"
new_repo "$repo"
sed -i "${field_line_number}d" "$repo/$target_file"
commit_all "$repo" "remove a field"
BUF_BREAKING_AGAINST=HEAD run_check "$repo"
if [[ $status -eq 0 ]]; then
	pass "BUF_BREAKING_AGAINST overrides the base"
else
	fail "BUF_BREAKING_AGAINST overrides the base (status $status): $output"
fi

# Case: shrinking the reserved realtime range (the Phase 5 change) fails by
# default, and passes with the deliberate exception documented in buf.yaml.
repo="$work/reserved"
new_repo "$repo"
sed -i -E 's/reserved 100 to 199;/reserved 101 to 199;/' "$repo/proto/vaultsync/v1/realtime.proto"
run_check "$repo"
if [[ $status -ne 0 && "$output" == *RESERVED_MESSAGE_NO_DELETE* ]]; then
	pass "shrinking the reserved realtime range fails by default"
else
	fail "shrinking the reserved realtime range fails by default (status $status): $output"
fi
cat >>"$repo/buf.yaml" <<'EOF'
  ignore_only:
    RESERVED_MESSAGE_NO_DELETE:
      - proto/vaultsync/v1/realtime.proto
EOF
run_check "$repo"
if [[ $status -eq 0 ]]; then
	pass "documented RESERVED_MESSAGE_NO_DELETE exception allows the Phase 5 change"
else
	fail "documented RESERVED_MESSAGE_NO_DELETE exception allows the Phase 5 change (status $status): $output"
fi

# Case: the suite is isolated from the developer's git setup. Re-run it once
# with a global config that signs commits with a failing program and installs
# a failing hook, a config set through the environment, and an exported
# GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE (as when `make test` runs from a git
# hook). Without the isolation above, every commit in the suite would fail.
if [[ -z "${BUF_BREAKING_TEST_NESTED:-}" ]]; then
	hostile="$work/hostile"
	mkdir -p "$hostile/hooks"
	printf '#!/bin/sh\nexit 1\n' >"$hostile/hooks/pre-commit"
	chmod +x "$hostile/hooks/pre-commit"
	cat >"$hostile/gitconfig" <<EOF
[commit]
	gpgsign = true
[gpg]
	program = false
[core]
	hooksPath = $hostile/hooks
EOF
	set +e
	output="$(
		BUF_BREAKING_TEST_NESTED=1 \
			GIT_CONFIG_GLOBAL="$hostile/gitconfig" \
			GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=true \
			GIT_DIR="$hostile/not-a-repo.git" GIT_WORK_TREE="$hostile" GIT_INDEX_FILE="$hostile/index" \
			"$repo_root/scripts/buf-breaking_test.sh" 2>&1
	)"
	status=$?
	set -e
	if [[ $status -eq 0 ]]; then
		pass "suite passes with a hostile global git config and an exported GIT_DIR"
	else
		fail "suite passes with a hostile global git config and an exported GIT_DIR (status $status): $output"
	fi
fi

if [[ $failures -ne 0 ]]; then
	echo "buf-breaking tests: $failures failure(s)" >&2
	exit 1
fi
echo "buf-breaking tests: all passed"
