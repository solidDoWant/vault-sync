#!/usr/bin/env bash
# Publishes the server image and the Helm chart of a release; run by the
# release workflow (.github/workflows/release.yml) when a release tag is
# pushed, after it has logged Docker and Helm into ghcr.io.
#
# Usage: scripts/publish-release.sh VERSION
#
# Builds and pushes the image (`make build-images`, which runs govulncheck on
# the binary and moves :latest only for a final version) and the chart
# (`make helm`), then checks that ghcr.io serves both at VERSION.
set -euo pipefail

version="${1:?usage: publish-release.sh VERSION}"
registry="${CONTAINER_REGISTRY:-ghcr.io/soliddowant}"

# Same rule as scripts/release.sh: the tag is the version, without a "v" and
# without build metadata ("+" is not allowed in image tags).
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
if ! [[ $version =~ $semver ]]; then
	echo "publish-release: '$version' is not a release version such as 1.2.3 or 1.2.3-rc.1" >&2
	exit 1
fi

make build-images helm VERSION="$version" PUSH_ALL=true CONTAINER_REGISTRY="$registry"

echo "checking $registry/vault-sync:$version"
docker manifest inspect "$registry/vault-sync:$version" >/dev/null
echo "checking oci://$registry/charts/vault-sync --version $version"
helm show chart "oci://$registry/charts/vault-sync" --version "$version" >/dev/null
echo "published $registry/vault-sync:$version and chart vault-sync $version"
