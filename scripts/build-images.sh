#!/usr/bin/env bash
# Builds the server OCI image with Nix, checks its binary with govulncheck,
# loads it into the local Docker daemon and tags it (make build-images).
# Pushes only when PUSH_ALL=true.
#
# Usage: scripts/build-images.sh VERSION PUSH_ALL IMAGE
#   VERSION   stamped into the binary and used as the image tag
#   PUSH_ALL  "true" to also tag IMAGE:latest and push every tag
#   IMAGE     registry repository, e.g. ghcr.io/soliddowant/vault-sync
set -euo pipefail

version="${1:?usage: build-images.sh VERSION PUSH_ALL IMAGE}"
push_all="${2:?usage: build-images.sh VERSION PUSH_ALL IMAGE}"
image="${3:?usage: build-images.sh VERSION PUSH_ALL IMAGE}"

# The flake reads the release version from VAULT_SYNC_VERSION, which only an
# impure evaluation can see (flake.nix). Everything else stays pinned by
# flake.lock.
export VAULT_SYNC_VERSION="$version"
server="$(nix build --impure --no-link --print-out-paths .#server)"
image_script="$(nix build --impure --no-link --print-out-paths .#serverImage)"

# The image holds exactly this store path (nix/server-image.nix), so this
# checks the shipped binary: its Go toolchain and standard library as well as
# its modules.
echo "govulncheck -mode=binary $server/bin/vault-sync-server"
govulncheck -mode=binary "$server/bin/vault-sync-server"

"$image_script" | docker load
local_ref="vault-sync:$version"

tags=("$image:$version")
# A pre-release (a version with "-", e.g. 0.2.0-rc.1) never moves :latest:
# release candidates are cut by agents and promoted by a human.
if [[ $push_all == "true" && $version != *-* ]]; then
	tags+=("$image:latest")
fi
for tag in "${tags[@]}"; do
	echo "tagging $local_ref -> $tag"
	docker tag "$local_ref" "$tag"
done

if [[ $push_all == "true" ]]; then
	for tag in "${tags[@]}"; do
		echo "pushing $tag"
		docker push "$tag"
	done
else
	echo "Skipping registry push (set PUSH_ALL=true to push: ${tags[*]})"
fi
