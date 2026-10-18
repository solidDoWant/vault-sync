#!/usr/bin/env bash
# Tests scripts/buf-breaking.sh end to end with the real buf.yaml and proto/
# schema. Each case builds a throwaway git repository (plus a bare "origin")
# in a temporary directory from copies of the committed files, mutates the
# copy, and runs the breaking check there. The committed schema is never
# touched.
set -euo pipefail

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
[[ -n "$field_line_number" ]] || {
	echo "could not find a field declaration in $target_file" >&2
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

if [[ $failures -ne 0 ]]; then
	echo "buf-breaking tests: $failures failure(s)" >&2
	exit 1
fi
echo "buf-breaking tests: all passed"
