#!/usr/bin/env bash
# Pulls, saves and loads the digest-pinned images of the docker compose test
# stack (deploy/compose/compose.test*.yaml), so CI does not depend on a
# rate-limited public registry on every run (#606, #727).
#
#   test-images.sh pull [compose-file ...]   pull the images the given compose
#       files (merged, as `docker compose --file` does) reference; default:
#       every variant scripts/with-test-stack.sh can start. Images already
#       present locally are not pulled again, so images restored from a cache
#       never touch the registry.
#   test-images.sh save archive              pull every variant's images (as
#       above) and `docker save` them into archive, under their tags.
#   test-images.sh load archive              `docker load` archive, then report
#       on stderr which images it did not provide (they are pulled later).
#       The loaded images answer to their digest references only with
#       Docker's containerd image store; .github/actions/test-images enables
#       it on CI runners.
#
# A failed pull is retried with backoff: 5, 15 and 45 seconds, or 60, 120 and
# 240 seconds when the registry answered with a rate limit (HTTP 429,
# "toomanyrequests"), whose quotas are counted per minute. Images stay pinned
# by digest and there is no fallback registry (in particular not Docker Hub).
#
# Used by scripts/with-test-stack.sh and .github/actions/test-images.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

base=deploy/compose/compose.test.yaml

usage() {
	echo "usage: $0 pull [compose-file ...] | save archive | load archive" >&2
	exit 2
}

# images file... prints the images the merged compose files reference.
images() {
	local args=() file
	for file in "$@"; do
		args+=(--file "$file")
	done
	docker compose "${args[@]}" config --images
}

# all_images prints the images of the base stack and of every override.
all_images() {
	local override
	{
		images "$base"
		for override in deploy/compose/compose.test-*.yaml; do
			[[ -e $override ]] || continue
			images "$base" "$override"
		done
	} | sort -u
}

present() {
	docker image inspect "$1" >/dev/null 2>&1
}

# pull_image image pulls one image, retrying with backoff.
pull_image() {
	local image=$1 attempt=1 attempts=4 delay output
	while true; do
		if output=$(docker pull --quiet "$image" 2>&1); then
			return 0
		fi
		printf '%s\n' "$output" >&2
		if ((attempt >= attempts)); then
			echo "test-images: pulling ${image} failed ${attempt} times; giving up" >&2
			return 1
		fi
		if grep -qiE 'toomanyrequests|too many requests' <<<"$output"; then
			delay=$((60 * 2 ** (attempt - 1)))
			echo "test-images: pulling ${image} was rate-limited (attempt ${attempt}); retrying in ${delay}s" >&2
		else
			delay=$((5 * 3 ** (attempt - 1)))
			echo "test-images: pulling ${image} failed (attempt ${attempt}); retrying in ${delay}s" >&2
		fi
		sleep "$delay"
		attempt=$((attempt + 1))
	done
}

# pull_missing image... pulls the images not present locally.
pull_missing() {
	local image
	for image in "$@"; do
		if present "$image"; then
			echo "test-images: ${image} is present; not pulling" >&2
			continue
		fi
		pull_image "$image"
	done
}

[[ $# -ge 1 ]] || usage
command=$1
shift

case $command in
pull)
	if [[ $# -eq 0 ]]; then
		mapfile -t wanted < <(all_images)
	else
		mapfile -t wanted < <(images "$@")
	fi
	[[ ${#wanted[@]} -gt 0 ]] || { echo "test-images: the compose files reference no image" >&2; exit 1; }
	pull_missing "${wanted[@]}"
	;;
save)
	[[ $# -eq 1 ]] || usage
	mapfile -t wanted < <(all_images)
	[[ ${#wanted[@]} -gt 0 ]] || { echo "test-images: the compose files reference no image" >&2; exit 1; }
	pull_missing "${wanted[@]}"
	# `docker save` does not record a digest reference's name, so a loaded
	# image would not answer to it. Save each under its tag instead: with
	# Docker's containerd image store, name:tag@digest then resolves to the
	# loaded image when the tag points at that digest.
	tagged=()
	for image in "${wanted[@]}"; do
		docker tag "$image" "${image%@*}"
		tagged+=("${image%@*}")
	done
	docker save --output "$1" "${tagged[@]}"
	;;
load)
	[[ $# -eq 1 ]] || usage
	docker load --quiet --input "$1" >&2
	mapfile -t wanted < <(all_images)
	missing=0
	for image in "${wanted[@]}"; do
		if ! present "$image"; then
			echo "test-images: ${image} is not in ${1}; it will be pulled" >&2
			missing=1
		fi
	done
	if ((missing == 0)); then
		echo "test-images: every test image loaded from ${1}" >&2
	fi
	;;
*)
	usage
	;;
esac
