#!/usr/bin/env bash
# Release steps of `make release` that tag and publish. Dry run unless
# PUSH_ALL is "true": every command that changes anything outside this
# checkout (the tag, its push, the GitHub release) is printed instead of run.
#
# Usage:
#   scripts/release.sh preflight VERSION PUSH_ALL
#       Checks VERSION, gh authentication and that CHANGELOG.md has a
#       non-empty "## VERSION" section; for a real release also that
#       the working tree is clean, that HEAD is the published master
#       (origin/master, fetched first) and that the tag does not exist yet.
#       Runs before anything is built or pushed.
#   scripts/release.sh check-assets VERSION PUSH_ALL ASSET_DIR
#       Checks the plugin release assets in ASSET_DIR (main.js,
#       manifest.json whose version is VERSION, styles.css). `make release`
#       runs it before the image and chart are pushed, so a broken asset
#       stops the release before anything is published.
#   scripts/release.sh publish VERSION PUSH_ALL ASSET_DIR
#       Checks the assets again, writes the "## VERSION" section of
#       CHANGELOG.md (heading excluded) to ASSET_DIR/release-notes.md, then
#       tags HEAD as VERSION, pushes the tag and creates the GitHub release
#       with those notes and the assets attached. A dry run prints the notes.
#
# The tag is VERSION exactly, without a "v": Obsidian and BRAT require the
# release tag, the release name and the version in the released
# manifest.json to be the same string.
set -euo pipefail

usage() {
	echo "usage: release.sh preflight VERSION PUSH_ALL | check-assets VERSION PUSH_ALL ASSET_DIR | publish VERSION PUSH_ALL ASSET_DIR" >&2
	exit 2
}

step="${1:-}"
version="${2:-}"
push_all="${3:-}"
[[ -n $step && -n $version && -n $push_all ]] || usage

dry_run=true
if [[ $push_all == "true" ]]; then
	dry_run=false
fi

die() {
	echo "release: $*" >&2
	exit 1
}

# run COMMAND...: runs the command for a real release, prints it otherwise.
run() {
	if $dry_run; then
		echo "dry run: $*"
	else
		"$@"
	fi
}

# Semantic version without build metadata: "+" is not allowed in image tags.
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
if ! [[ $version =~ $semver ]]; then
	die "VERSION must be a semantic version such as 1.2.3 or 1.2.3-beta.1 (no leading v, no build metadata), got '$version'"
fi

# check_assets ASSET_DIR: refuses missing or empty assets and a manifest
# whose version is not VERSION; sets the array assets.
check_assets() {
	local asset_dir="$1" asset manifest_version
	[[ -n $asset_dir ]] || usage
	assets=()
	for asset in main.js manifest.json styles.css; do
		[[ -s "$asset_dir/$asset" ]] || die "release asset $asset_dir/$asset is missing or empty"
		assets+=("$asset_dir/$asset")
	done
	manifest_version="$(jq -r .version "$asset_dir/manifest.json")"
	if [[ $manifest_version != "$version" ]]; then
		die "$asset_dir/manifest.json has version '$manifest_version', not '$version' (Obsidian and BRAT require them to match)"
	fi
}

# release_notes: prints the "## VERSION" section of the checkout's
# CHANGELOG.md, without its heading and surrounding blank lines, up to the
# next "## " heading; refuses a missing file, a missing section and one that
# is blank.
release_notes() {
	local changelog notes
	changelog="$(git rev-parse --show-toplevel)/CHANGELOG.md"
	[[ -f $changelog ]] || die "$changelog does not exist; it holds the release notes"
	if ! grep -qxF -- "## $version" "$changelog"; then
		die "CHANGELOG.md has no '## $version' section; add the release notes there first"
	fi
	notes="$(awk -v heading="## $version" '
		$0 == heading { in_section = 1; next }
		in_section && /^## / { exit }
		in_section { print }
	' "$changelog")"
	# Trim surrounding blank lines: $(...) drops trailing newlines, sed the
	# leading blank lines.
	notes="$(sed '/[^[:space:]]/,$!d' <<<"$notes")"
	[[ -n $notes ]] || die "the '## $version' section of CHANGELOG.md is empty; add the release notes there first"
	printf '%s\n' "$notes"
}

case "$step" in
preflight)
	# Unprefixed, so an unauthenticated gh stops the release before any
	# image is built or pushed.
	gh auth status
	release_notes >/dev/null
	if $dry_run; then
		echo "dry run: skipping the clean-tree and existing-tag checks (set PUSH_ALL=true to release)"
		exit 0
	fi
	if [[ -n "$(git status --porcelain)" ]]; then
		die "the working tree has uncommitted changes; release from a clean checkout"
	fi
	# Only reviewed, published code is released: the tag goes on HEAD.
	git fetch --quiet origin master
	head="$(git rev-parse HEAD)"
	published="$(git rev-parse FETCH_HEAD)"
	if [[ $head != "$published" ]]; then
		die "HEAD ($head) is not origin/master ($published); release from an up-to-date checkout of the published master"
	fi
	if git rev-parse -q --verify "refs/tags/$version" >/dev/null; then
		die "tag $version already exists locally"
	fi
	if [[ -n "$(git ls-remote --tags origin "refs/tags/$version")" ]]; then
		die "tag $version already exists on origin"
	fi
	;;
check-assets)
	check_assets "${4:-}"
	;;
publish)
	check_assets "${4:-}"

	# A pre-release is never marked "latest", so BRAT users who don't track
	# pre-releases (and anything else that follows the latest release) keep
	# the last promoted version.
	prerelease=()
	if [[ $version == *-* ]]; then
		prerelease=(--prerelease --latest=false)
	fi

	notes_file="$4/release-notes.md"
	release_notes >"$notes_file"
	if $dry_run; then
		echo "dry run: release notes ($notes_file, from CHANGELOG.md):"
		cat "$notes_file"
	fi

	run git tag -a "$version" -m "Release $version"
	run git push origin "refs/tags/$version"
	run gh release create "$version" --verify-tag --title "$version" --notes-file "$notes_file" "${prerelease[@]}" "${assets[@]}"
	if $dry_run; then
		echo "dry run complete: nothing was tagged, pushed or published (set PUSH_ALL=true to release)"
	fi
	;;
*)
	usage
	;;
esac
