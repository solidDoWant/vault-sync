#!/usr/bin/env bash
# Tests that the flake's source never lands in the Nix store with gitignored
# caches in it (#158). Nix copies a flake's source to the store before
# evaluating it: as a git flake only tracked files are copied, as a path flake
# the whole directory is, including plugin/node_modules and the ~800 MB
# plugin/.wdio-obsidian-cache. flake.nix therefore refuses to evaluate the dev
# shell from a path-flake source.
#
# Cases:
#   1. This checkout (or worktree) resolves as a git flake whose store copy
#      holds none of its gitignored directories.
#   2. `nix develop` in a git worktree containing both caches succeeds, and
#      the store copy of the source excludes them.
#   3. Evaluating that worktree as a path flake -- `nix develop path:...` and
#      `builtins.getFlake (toString ./.)`, the call that copied the cache in
#      #158 -- fails with the flake's explanation.
#
# Cases 2 and 3 run on a throwaway repository holding only flake.nix,
# flake.lock and .gitignore, so the path copies they make are a few KB. Its
# locked inputs are the ones already in the store for the dev shell, so no
# network is needed and nothing is built.
set -euo pipefail

# Same isolation from the developer's git setup as buf-breaking_test.sh.
# shellcheck disable=SC2046 # one variable name per word
unset $(git rev-parse --local-env-vars)
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v nix >/dev/null 2>&1; then
	echo "flake-source_test: nix is required (run inside the dev shell host)" >&2
	exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
pass() { echo "ok   - $1"; }
fail() {
	echo "FAIL - $1" >&2
	failures=$((failures + 1))
}

# quiet ARGS...: runs a command, hiding its output unless it fails.
quiet() {
	local output status=0
	output="$("$@" 2>&1)" || status=$?
	if [[ $status -ne 0 ]]; then
		printf 'command failed (status %d): %s\n%s\n' "$status" "$*" "$output" >&2
	fi
	return "$status"
}

# store_copy_has_no_ignored_dirs STORE_PATH LABEL: fails LABEL if the store
# copy holds any of the gitignored cache directories.
store_copy_has_no_ignored_dirs() {
	local store_path="$1" label="$2" dir found=0
	for dir in plugin/node_modules plugin/.wdio-obsidian-cache plugin/dist node_modules; do
		if [[ -e "$store_path/$dir" ]]; then
			fail "$label: store copy $store_path contains gitignored $dir"
			found=1
		fi
	done
	return "$found"
}

# metadata DIR: `nix flake metadata --json` for the flake in DIR, referenced
# the way `nix develop` run inside DIR references it.
metadata() {
	local status=0
	(cd "$1" && nix flake metadata --json . 2>"$work/metadata.err") || status=$?
	if [[ $status -ne 0 ]]; then
		printf 'nix flake metadata failed in %s (status %d):\n' "$1" "$status" >&2
		cat "$work/metadata.err" >&2
	fi
	return "$status"
}

# Case 1: this checkout.
checkout_meta="$(metadata "$repo_root")"
checkout_type="$(jq -r .resolved.type <<<"$checkout_meta")"
checkout_path="$(jq -r .path <<<"$checkout_meta")"
if [[ "$checkout_type" != git ]]; then
	fail "checkout resolves as a $checkout_type flake, not git"
elif store_copy_has_no_ignored_dirs "$checkout_path" "checkout"; then
	pass "checkout resolves as a git flake without gitignored directories"
fi

# A throwaway repository with the committed flake, and a worktree of it (how
# agents check out issues) with both caches planted in it.
origin="$work/origin"
mkdir -p "$origin"
cp "$repo_root/flake.nix" "$repo_root/flake.lock" "$repo_root/.gitignore" "$origin/"
quiet git -C "$origin" -c init.defaultBranch=master init
quiet git -C "$origin" add flake.nix flake.lock .gitignore
quiet git -C "$origin" -c user.name=test -c user.email=test@example.com commit -m base
worktree="$work/worktree"
quiet git -C "$origin" worktree add --detach "$worktree"
mkdir -p "$worktree/plugin/.wdio-obsidian-cache" "$worktree/plugin/node_modules"
echo cache >"$worktree/plugin/.wdio-obsidian-cache/marker"
echo module >"$worktree/plugin/node_modules/marker"
if [[ -n "$(git -C "$worktree" status --porcelain)" ]]; then
	fail "planted caches are not gitignored"
fi

# Case 2: nix develop in the worktree.
if (cd "$worktree" && quiet nix develop -c true); then
	worktree_meta="$(metadata "$worktree")"
	worktree_type="$(jq -r .resolved.type <<<"$worktree_meta")"
	worktree_path="$(jq -r .path <<<"$worktree_meta")"
	if [[ "$worktree_type" != git ]]; then
		fail "worktree resolves as a $worktree_type flake, not git"
	elif store_copy_has_no_ignored_dirs "$worktree_path" "worktree"; then
		pass "nix develop in a worktree copies no gitignored caches"
	fi
else
	fail "nix develop in a git worktree failed"
fi

# Case 3: path-flake evaluation is refused.
expected="evaluated as a path flake"
# expect_refused LABEL COMMAND...: COMMAND must fail and explain why.
expect_refused() {
	local label="$1" output status=0
	shift
	output="$(cd "$worktree" && "$@" 2>&1)" || status=$?
	if [[ $status -eq 0 ]]; then
		fail "$label: succeeded; a path-flake evaluation must be refused"
	elif [[ "$output" != *"$expected"* ]]; then
		fail "$label: failed without the path-flake explanation:"$'\n'"$output"
	else
		pass "$label is refused"
	fi
}
expect_refused "nix develop path:" nix develop "path:$worktree" -c true
# shellcheck disable=SC2016 # Nix expression, not shell
expect_refused "builtins.getFlake (toString ./.)" nix eval --impure --raw --expr \
	'(builtins.getFlake (toString ./.)).devShells.${builtins.currentSystem}.default.drvPath'

if [[ $failures -ne 0 ]]; then
	echo "flake-source_test: $failures failure(s)" >&2
	exit 1
fi
