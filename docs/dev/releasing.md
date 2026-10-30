# Releasing

For: developers who make a release. You need the GitHub CLI signed in, a clean checkout of `master`, and the dev shell ([building.md](building.md)).

A release has a tag, a GitHub release with the plugin files, a server image and a Helm chart. `make release` makes the tag and the GitHub release. The tag starts a workflow that publishes the image and the chart.

## The version

`VERSION` is a semantic version without a `v`: `1.2.3`, or `1.2.3-beta.1` for a pre-release. The tag has no `v` because Obsidian and BRAT require the release tag, the release name and the version in the released `manifest.json` to be the same string.

## Release notes

The notes of the GitHub release are the `## <VERSION>` section of `CHANGELOG.md` in the released checkout, without its heading. Write and merge that section before you release. `make release` refuses a version whose section is missing or empty, in a dry run too, before it builds or pushes anything. A dry run prints the notes it would publish.

## Make the release

1. Do a dry run. It builds the plugin and prints what it would tag and release:

   ```sh
   make release VERSION=1.2.3
   ```

2. If the dry run is correct, release:

   ```sh
   make release VERSION=1.2.3 PUSH_ALL=true
   ```

First, `make release` checks the version, `gh auth status` and the `CHANGELOG.md` section. For a real release, it also checks that the tree is clean, that `HEAD` is the published `master` (`origin/master`, fetched first) and that the tag is new. Then it does these steps:

1. `make plugin-release-assets` builds the plugin and collects `main.js`, `manifest.json` (its `version` set to `<VERSION>`) and `styles.css` in `bin/release/`. It checks them, so a broken file stops the release before anything is tagged.
2. It tags `HEAD` as `<VERSION>`, pushes the tag, and creates the GitHub release `<VERSION>`. The notes are written to `bin/release/release-notes.md`, and the three plugin files are attached. A version with `-` is marked as a pre-release and never as the latest release. In a dry run, these commands are only printed.

## The release workflow

`make release` needs no registry credentials. The pushed tag starts the `release` workflow (`.github/workflows/release.yml`). It runs on every pushed tag of the form `X.Y.Z` or `X.Y.Z-…`, and publishes with the `GITHUB_TOKEN` of the workflow (`packages: write`). Through `scripts/publish-release.sh`, it does these steps:

1. `make build-images PUSH_ALL=true` builds the image with Nix and runs `govulncheck -mode=binary` on its binary. A known vulnerability fails the run. Then it pushes `ghcr.io/soliddowant/vault-sync:<VERSION>`, and also `:latest` if the version is not a pre-release.
2. `make helm PUSH_ALL=true` packages the chart as version `<VERSION>` and pushes it to `oci://ghcr.io/soliddowant/charts`.
3. It makes sure that both exist, with `docker manifest inspect ghcr.io/soliddowant/vault-sync:<VERSION>` and `helm show chart oci://ghcr.io/soliddowant/charts/vault-sync --version <VERSION>`.

So the GitHub release exists a few minutes before its image and chart. A release is complete when its `release` workflow run passed (`gh run list --workflow release.yml --branch <VERSION>`).

## When a step fails

- If the workflow run fails, fix the cause and run it again (`gh run rerun <run-id>`). Never move the tag.
- If tagging, the tag push or `gh release create` fails, finish by hand from the same checkout. Skip the commands that already succeeded:

  ```sh
  git tag -a <VERSION> -m "Release <VERSION>"
  git push origin refs/tags/<VERSION>
  gh release create <VERSION> --verify-tag --title <VERSION> --notes-file bin/release/release-notes.md bin/release/main.js bin/release/manifest.json bin/release/styles.css
  ```

  For a pre-release, add `--prerelease --latest=false` to `gh release create`. Do not run `make release` again: it stops at its first checks once the tag exists.

## Local image and chart builds

`make build-images helm VERSION=<VERSION>` builds the image and the chart without pushing them. With `PUSH_ALL=true` they are pushed. That needs credentials for `ghcr.io` in the Docker daemon (`docker login ghcr.io`) and for Helm (`helm registry login ghcr.io`).

## The Go vendor hash

`nix/server.nix` pins a hash of the Go module dependencies. After a change to `go.mod` or `go.sum`, `make build-images` fails with a hash mismatch until `vendorHash` is updated. Run `make update-vendor-hash`. It needs network access. It builds the vendored modules with a placeholder hash, writes the hash that Nix reports into `nix/server.nix`, and makes sure that the modules build with it. Commit the change with the `go.mod` or `go.sum` change. `make update-dependencies` runs it too. On pull requests from Renovate, the `renovate-fixups` workflow runs it and pushes the result.

## How users install a release

Users install the plugin from these releases with [BRAT](https://github.com/TfTHacker/obsidian42-brat). They add the beta plugin `solidDoWant/vault-sync`, and BRAT downloads the three files from the latest release.

## Releases by agents

The `release-manager` agent (`.claude/agents/release-manager.md`) makes releases: `0.N.0` when phase N closes, patch versions for fixes, and `-rc.K` candidates when asked. It starts on a `/pm release` instruction or when a phase closes. Before it releases, it runs its own gate checks: the milestone, open critical and high bugs, CI, the integration and upgrade tests, `govulncheck` and a dry run. A version of `1.0.0` or above needs an explicit `/pm` instruction.

Before each release, a person runs the manual Android checks in `docs/testing/android.md`.
