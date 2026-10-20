#!/usr/bin/env bash
# Tests scripts/release.sh, the tagging and publishing steps of
# `make release`, without touching GitHub or this checkout. Each case runs in
# a throwaway git repository with a bare "origin" in a temporary directory,
# and `gh` is a stub on PATH that records its arguments. Cases:
#
#   - a dry run (the default) prints the tag, push and release commands, with
#     main.js, manifest.json and styles.css attached, and changes nothing;
#   - a real run (PUSH_ALL=true) tags HEAD, pushes the tag to origin and
#     creates the release with the three assets; a pre-release version is
#     marked as one;
#   - invalid versions, missing or empty assets, a manifest whose version
#     differs (by check-assets and publish), a dirty tree, a HEAD that is
#     not origin/master (an unpushed commit, or an origin that moved on), an
#     existing tag and a failing `gh auth status` are refused before
#     anything is tagged or published.
set -euo pipefail

# Same isolation from the developer's git setup as buf-breaking_test.sh.
# shellcheck disable=SC2046 # one variable name per word
unset $(git rev-parse --local-env-vars)
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release="$repo_root/scripts/release.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
pass() { echo "ok   - $1"; }
fail() {
	echo "FAIL - $1" >&2
	failures=$((failures + 1))
}

# The gh stub logs every call to $GH_LOG and fails `auth status` when
# GH_AUTH_FAILS is set.
mkdir -p "$work/bin"
cat >"$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
if [[ $1 == auth && -n ${GH_AUTH_FAILS:-} ]]; then
	echo "not logged in" >&2
	exit 1
fi
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"

# new_case NAME: a fresh repository (one commit, pushed to a bare origin), a
# fresh gh log and a valid asset directory for version 1.2.3; cds into it.
new_case() {
	local dir="$work/$1"
	git init -q --bare "$dir/origin.git"
	git init -q -b master "$dir/repo"
	cd "$dir/repo"
	echo content >file
	git add file
	git commit -q -m initial
	git remote add origin "$dir/origin.git"
	git push -q origin master
	export GH_LOG="$dir/gh.log"
	: >"$GH_LOG"
	unset GH_AUTH_FAILS
	assets="$dir/assets"
	mkdir -p "$assets"
	echo 'module.exports = {};' >"$assets/main.js"
	echo '.vault-sync {}' >"$assets/styles.css"
	echo '{"id":"vault-sync","version":"1.2.3"}' >"$assets/manifest.json"
}

# expect_refused LABEL MESSAGE ARGS...: passes if release.sh ARGS fails with
# MESSAGE on stderr, creating no tag and no GitHub release.
expect_refused() {
	local label="$1" message="$2" status=0
	shift 2
	"$release" "$@" >"$work/out" 2>"$work/err" || status=$?
	if [[ $status -eq 0 ]]; then
		fail "$label (succeeded)"
	elif ! grep -qF -- "$message" "$work/err"; then
		fail "$label (stderr does not mention '$message': $(cat "$work/err"))"
	elif [[ -n "$(git tag)" ]] || grep -q '^release' "$GH_LOG"; then
		fail "$label (tagged or published anyway)"
	else
		pass "$label"
	fi
}

# --- dry run ----------------------------------------------------------------

new_case dry-run
if "$release" preflight 1.2.3 false >"$work/out" 2>&1 && "$release" publish 1.2.3 false "$assets" >>"$work/out" 2>&1; then
	if grep -qxF "dry run: gh release create 1.2.3 --verify-tag --title 1.2.3 --generate-notes $assets/main.js $assets/manifest.json $assets/styles.css" "$work/out" &&
		grep -qxF 'dry run: git tag -a 1.2.3 -m Release 1.2.3' "$work/out" &&
		grep -qxF 'dry run: git push origin refs/tags/1.2.3' "$work/out"; then
		pass "a dry run prints the tag, push and release commands with all three assets"
	else
		fail "a dry run prints the tag, push and release commands with all three assets: $(cat "$work/out")"
	fi
	if [[ -z "$(git tag)" && -z "$(git ls-remote --tags origin)" ]] && ! grep -q '^release' "$GH_LOG"; then
		pass "a dry run creates no tag and no release"
	else
		fail "a dry run creates no tag and no release (tags: $(git tag), gh: $(cat "$GH_LOG"))"
	fi
	if grep -qx 'auth status' "$GH_LOG"; then
		pass "a dry run checks gh authentication"
	else
		fail "a dry run checks gh authentication"
	fi
else
	fail "a dry run succeeds: $(cat "$work/out")"
fi

new_case dry-run-dirty
echo change >>file
if "$release" preflight 1.2.3 false >"$work/out" 2>&1; then
	pass "a dry run tolerates a dirty tree"
else
	fail "a dry run tolerates a dirty tree: $(cat "$work/out")"
fi

# --- real run ---------------------------------------------------------------

new_case real
if "$release" preflight 1.2.3 true >"$work/out" 2>&1 && "$release" publish 1.2.3 true "$assets" >>"$work/out" 2>&1; then
	if [[ "$(git rev-parse '1.2.3^{commit}')" == "$(git rev-parse HEAD)" && "$(git cat-file -t 1.2.3)" == tag ]]; then
		pass "a release creates an annotated tag 1.2.3 on HEAD"
	else
		fail "a release creates an annotated tag 1.2.3 on HEAD"
	fi
	if [[ -n "$(git ls-remote --tags origin refs/tags/1.2.3)" ]]; then
		pass "a release pushes the tag to origin"
	else
		fail "a release pushes the tag to origin"
	fi
	if grep -qxF "release create 1.2.3 --verify-tag --title 1.2.3 --generate-notes $assets/main.js $assets/manifest.json $assets/styles.css" "$GH_LOG"; then
		pass "a release creates the GitHub release with main.js, manifest.json and styles.css"
	else
		fail "a release creates the GitHub release with main.js, manifest.json and styles.css: $(cat "$GH_LOG")"
	fi
else
	fail "a release succeeds: $(cat "$work/out")"
fi

new_case prerelease
echo '{"id":"vault-sync","version":"1.2.3-beta.1"}' >"$assets/manifest.json"
if "$release" publish 1.2.3-beta.1 true "$assets" >"$work/out" 2>&1 &&
	grep -q -- '^release create 1.2.3-beta.1 .*--prerelease' "$GH_LOG"; then
	pass "a pre-release version is published as a pre-release"
else
	fail "a pre-release version is published as a pre-release: $(cat "$work/out" "$GH_LOG")"
fi

# --- refusals ---------------------------------------------------------------

for version in v1.2.3 1.2 1.2.3+build.1 01.2.3 1.2.3- ''; do
	new_case "version-${version:-empty}"
	if [[ -z $version ]]; then
		expect_refused "refuses an empty version" "usage" publish "" true "$assets"
	else
		expect_refused "refuses version '$version'" "semantic version" publish "$version" true "$assets"
	fi
done

for asset in main.js manifest.json styles.css; do
	new_case "missing-$asset"
	rm "$assets/$asset"
	expect_refused "refuses a release without $asset" "$asset" publish 1.2.3 true "$assets"
	new_case "empty-$asset"
	: >"$assets/$asset"
	expect_refused "refuses a release with an empty $asset" "$asset" publish 1.2.3 true "$assets"
done

new_case dry-run-missing-asset
rm "$assets/styles.css"
expect_refused "a dry run refuses missing assets too" "styles.css" publish 1.2.3 false "$assets"

new_case manifest-mismatch
expect_refused "refuses a manifest.json whose version differs" "has version '1.2.3', not '1.2.4'" publish 1.2.4 true "$assets"

new_case dirty
echo change >>file
expect_refused "refuses a real release from a dirty tree" "uncommitted changes" preflight 1.2.3 true

new_case unpushed
echo change >>file
git commit -q -am unpushed
expect_refused "refuses a real release of a commit that is not on origin/master" "is not origin/master" preflight 1.2.3 true

new_case behind
git clone -q "$work/behind/origin.git" "$work/behind/other"
git -C "$work/behind/other" commit -q --allow-empty -m newer
git -C "$work/behind/other" push -q origin master
expect_refused "refuses a real release from a checkout behind origin/master" "is not origin/master" preflight 1.2.3 true

new_case check-assets
if "$release" check-assets 1.2.3 true "$assets" >"$work/out" 2>&1 && [[ -z "$(git tag)" ]] && ! grep -q '^release' "$GH_LOG"; then
	pass "check-assets accepts valid assets without tagging or publishing"
else
	fail "check-assets accepts valid assets without tagging or publishing: $(cat "$work/out")"
fi
rm "$assets/main.js"
expect_refused "check-assets refuses a missing asset" "main.js" check-assets 1.2.3 true "$assets"
new_case check-assets-manifest
expect_refused "check-assets refuses a manifest.json whose version differs" "has version '1.2.3', not '1.2.4'" check-assets 1.2.4 true "$assets"

new_case local-tag
git tag 1.2.3
"$release" preflight 1.2.3 true >"$work/out" 2>"$work/err" && fail "refuses an existing local tag (succeeded)" ||
	{ grep -qF "already exists locally" "$work/err" && pass "refuses an existing local tag" || fail "refuses an existing local tag: $(cat "$work/err")"; }

new_case remote-tag
git tag 1.2.3
git push -q origin 1.2.3
git tag -d 1.2.3 >/dev/null
expect_refused "refuses a tag that exists on origin" "already exists on origin" preflight 1.2.3 true

new_case unauthenticated
export GH_AUTH_FAILS=1
expect_refused "refuses to start when gh is not authenticated" "not logged in" preflight 1.2.3 false

cd "$repo_root"
if [[ $failures -ne 0 ]]; then
	echo "release_test: $failures case(s) failed" >&2
	exit 1
fi
echo "release_test: all cases passed"
