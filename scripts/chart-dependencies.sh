#!/usr/bin/env bash
# Fetches a chart's dependencies exactly as pinned by its Chart.lock
# (`helm dependency build`), without touching the user's Helm repository
# configuration: `helm dependency build` only resolves repositories that are
# added, so they are added to a throwaway repository config. Skips the fetch
# when charts/ already holds every locked dependency.
#
# Usage: scripts/chart-dependencies.sh CHART_DIR
set -euo pipefail

chart="${1:?usage: chart-dependencies.sh CHART_DIR}"

missing=0
while IFS=$'\t' read -r name version; do
	[[ -f "$chart/charts/$name-$version.tgz" ]] || missing=1
done < <(yq -r '.dependencies[] | [.name, .version] | @tsv' "$chart/Chart.lock")
if [[ $missing -eq 0 ]]; then
	exit 0
fi

helm_home="$(mktemp -d)"
trap 'rm -rf "$helm_home"' EXIT
export HELM_REPOSITORY_CONFIG="$helm_home/repositories.yaml"
export HELM_REPOSITORY_CACHE="$helm_home/cache"

index=0
for repository in $(yq -r '.dependencies[].repository' "$chart/Chart.lock" | sort -u); do
	index=$((index + 1))
	helm repo add "dependency-$index" "$repository" >/dev/null
done
helm dependency build "$chart" >/dev/null
