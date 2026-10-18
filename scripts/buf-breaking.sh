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
#     additions. In a shallow clone the base tip is used instead.
#   - Shallow pull_request CI checkouts: HEAD is the PR merge commit GitHub
#     built on top of some master commit, its first parent. master may have
#     moved on since, and comparing against the newer tip would report
#     master's additions as deletions. So when GITHUB_EVENT_NAME is
#     pull_request (set by GitHub Actions), the repository is shallow, HEAD is
#     a merge commit and BUF_BREAKING_AGAINST is unset, the first parent is the
#     base (fetched by SHA from the remote if missing). If it cannot be
#     fetched, the master tip is used as above, which can only fail closed.
#     Anywhere else a merge commit's first parent need not be master (merging
#     master into a feature branch makes it the feature branch's previous
#     commit, hiding that branch's earlier changes), so the rule is not used.
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

# shallow_merge_first_parent prints the first parent of HEAD when the
# repository is shallow and HEAD is a merge commit, fetching it from the
# remote if it is missing. Prints nothing otherwise, or if it cannot be had.
# Only used on pull_request runs, where HEAD is GitHub's refs/pull/N/merge and
# its first parent is the base branch.
shallow_merge_first_parent() {
	[[ "${GITHUB_EVENT_NAME:-}" == pull_request ]] || return 0
	[[ "$(git rev-parse --is-shallow-repository)" == true ]] || return 0
	# Read the parents from the raw commit header: a shallow clone grafts HEAD
	# to have none, so HEAD^1 does not resolve.
	local parents
	mapfile -t parents < <(git cat-file commit HEAD 2>/dev/null | sed -n '/^$/q; s/^parent //p')
	[[ ${#parents[@]} -ge 2 ]] || return 0
	if ! resolve "${parents[0]}" >/dev/null; then
		echo "buf-breaking: HEAD is a shallow merge commit; fetching its first parent ${parents[0]} from $remote" >&2
		if ! git fetch --quiet --no-tags --depth=1 "$remote" "${parents[0]}" >&2; then
			echo "buf-breaking: cannot fetch ${parents[0]}; falling back to $against" >&2
			return 0
		fi
	fi
	resolve "${parents[0]}" || true
}

base=""
[[ -n "${BUF_BREAKING_AGAINST:-}" ]] || base="$(shallow_merge_first_parent)"
if [[ -n "$base" ]]; then
	against="the first parent of merge commit HEAD"
else
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
fi

if ! git cat-file -e "$base:proto" 2>/dev/null; then
	die "base $base has no proto/ directory; nothing to compare against"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git archive --format=tar "$base" -- buf.yaml proto | tar -x -C "$tmp"

echo "buf-breaking: comparing proto/ against $against ($(git rev-parse --short "$base"))" >&2
buf breaking --against "$tmp" "$@"
