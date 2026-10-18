#!/usr/bin/env bash
# Fails if the working-tree protobuf schema (buf.yaml + proto/) has
# wire-incompatible changes relative to master, using the `breaking` rules in
# buf.yaml. Run from anywhere inside the repository (`make lint` runs it).
# Extra arguments (e.g. --error-format=json) are passed to `buf breaking`.
#
# Base selection:
#   - BUF_BREAKING_AGAINST (default: origin/master) names the base ref.
#   - If that ref does not exist locally (shallow CI clones, fork PRs, fresh
#     worktrees), master is fetched from the `origin` remote with --depth=1.
#     actions/checkout points `origin` at the base repository, so this also
#     works for pull requests from forks.
#   - If the base still cannot be resolved, the check fails. It never skips.
#   - When history allows, the merge-base of HEAD and the base is used, so a
#     branch that is merely behind master is not blamed for master's newer
#     additions. In a shallow clone (CI checks out the PR merge commit, whose
#     schema already contains master) the base tip is used instead.
#
# The base schema is extracted with `git archive` into a temporary directory,
# so buf never needs to clone the (possibly shallow) repository itself.
set -euo pipefail

against="${BUF_BREAKING_AGAINST:-origin/master}"
remote="${BUF_BREAKING_REMOTE:-origin}"
branch="${BUF_BREAKING_BRANCH:-master}"

die() {
	echo "buf-breaking: $*" >&2
	exit 1
}

top="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
cd "$top"

resolve() { git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null; }

base="$(resolve "$against" || true)"
if [[ -z "$base" && "$against" == "$remote/$branch" ]]; then
	echo "buf-breaking: $against not found locally; fetching $branch from $remote" >&2
	if git fetch --quiet --no-tags --depth=1 "$remote" "+refs/heads/$branch:refs/remotes/$remote/$branch" >&2; then
		base="$(resolve "$against" || true)"
	fi
fi
[[ -n "$base" ]] || die "cannot resolve the base ref '$against' to compare the proto schema against.
Fetch it (git fetch $remote $branch) or set BUF_BREAKING_AGAINST to a local ref or commit."

if merge_base="$(git merge-base HEAD "$base" 2>/dev/null)"; then
	base="$merge_base"
fi

if ! git cat-file -e "$base:proto" 2>/dev/null; then
	die "base $base has no proto/ directory; nothing to compare against"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git archive --format=tar "$base" -- buf.yaml proto | tar -x -C "$tmp"

echo "buf-breaking: comparing proto/ against $against ($(git rev-parse --short "$base"))" >&2
buf breaking --against "$tmp" "$@"
