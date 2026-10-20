#!/usr/bin/env bash
# Release steps of `make release` that tag and publish. Dry run unless
# PUSH_ALL is "true": every command that changes anything outside this
# checkout (the tag, its push, the GitHub release) is printed instead of run.
#
# Usage:
#   scripts/release.sh preflight VERSION PUSH_ALL
#       Checks VERSION and gh authentication; for a real release also that
#       the working tree is clean and the tag does not exist yet. Runs before
#       anything is built or pushed.
#   scripts/release.sh publish VERSION PUSH_ALL ASSET_DIR
#       Checks the plugin release assets in ASSET_DIR (main.js,
#       manifest.json whose version is VERSION, styles.css), then tags HEAD
#       as VERSION, pushes the tag and creates the GitHub release with the
#       assets attached.
#
# The tag is VERSION exactly, without a "v": Obsidian and BRAT require the
# release tag, the release name and the version in the released
# manifest.json to be the same string.
set -euo pipefail

usage() {
	echo "usage: release.sh preflight VERSION PUSH_ALL | publish VERSION PUSH_ALL ASSET_DIR" >&2
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

case "$step" in
preflight)
	# Unprefixed, so an unauthenticated gh stops the release before any
	# image is built or pushed.
	gh auth status
	if $dry_run; then
		echo "dry run: skipping the clean-tree and existing-tag checks (set PUSH_ALL=true to release)"
		exit 0
	fi
	if [[ -n "$(git status --porcelain)" ]]; then
		die "the working tree has uncommitted changes; release from a clean checkout"
	fi
	if git rev-parse -q --verify "refs/tags/$version" >/dev/null; then
		die "tag $version already exists locally"
	fi
	if [[ -n "$(git ls-remote --tags origin "refs/tags/$version")" ]]; then
		die "tag $version already exists on origin"
	fi
	;;
publish)
	asset_dir="${4:-}"
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

	# A pre-release is never marked "latest", so BRAT users who don't track
	# pre-releases (and anything else that follows the latest release) keep
	# the last promoted version.
	prerelease=()
	if [[ $version == *-* ]]; then
		prerelease=(--prerelease --latest=false)
	fi

	run git tag -a "$version" -m "Release $version"
	run git push origin "refs/tags/$version"
	run gh release create "$version" --verify-tag --title "$version" --generate-notes "${prerelease[@]}" "${assets[@]}"
	if $dry_run; then
		echo "dry run complete: nothing was tagged, pushed or published (set PUSH_ALL=true to release)"
	fi
	;;
*)
	usage
	;;
esac
