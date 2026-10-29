SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -euc

PROJECT_DIR := $(shell dirname $(realpath $(firstword $(MAKEFILE_LIST))))
BIN_DIR := $(PROJECT_DIR)/bin
PLUGIN_DIR := plugin

VERSION ?= 0.0.1-dev
LDFLAGS := -s -w -X github.com/solidDoWant/vault-sync/internal/version.version=$(VERSION)

GO_SOURCE_FILES := $(shell find cmd internal gen \( -name '*.go' ! -name '*_test.go' \) 2>/dev/null)

##@ General

.PHONY: help
help: ## Display this help.
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_0-9-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

##@ Development

.PHONY: fmt
fmt: ## Run go fmt against code.
	go fmt ./...

.PHONY: vet
vet: ## Run go vet against code.
	go vet ./...

.PHONY: lint
lint: plugin-lint ## Run golangci-lint, buf lint and buf breaking vs master (Go/proto) plus eslint + tsc (plugin).
	golangci-lint run ./...
	buf lint
	./scripts/buf-breaking.sh

.PHONY: lint-fix
lint-fix: ## Run golangci-lint and perform fixes.
	golangci-lint run --fix ./...

.PHONY: test
test: fmt vet plugin-test ## Run unit tests: Go (race detector) + plugin vitest + buf breaking check tests + flake source check + acceptance scoreboard tests + release script tests + test-image pull/cache script tests + agent wait-ci script and scheduler tests + native versitygw pin check + test-guard tests.
	go test -race -count=1 ./...
	./scripts/buf-breaking_test.sh
	./scripts/flake-source_test.sh
	./scripts/acceptance-scoreboard_test.py
	./scripts/npm-audit_test.sh
	./scripts/test-images_test.sh
	./scripts/release_test.sh
	./scripts/build-images_test.sh
	./scripts/agents/wait-ci_test.sh
	./scripts/agents/scheduler_test.py
	./scripts/with-native-s3.sh --check-pin
	./scripts/ci/test-guard_test.py

.PHONY: test-guard
test-guard: ## Fail if HEAD deletes or skips an [AC-nn]/[Pn-nn] scenario test or removes a crypto/path vector since its merge base with BASE (default origin/master; CI passes the PR body and labels).
	./scripts/ci/test-guard.py --base $(or $(BASE),origin/master)

.PHONY: test-integration
test-integration: $(PLUGIN_DIR)/node_modules/.package-lock.json ## Run integration tests against PostgreSQL + S3 (docker compose; skipped without Docker), incl. the plugin protocol client vs the real server.
	./scripts/test-integration.sh

.PHONY: test-integration-postgres14
test-integration-postgres14: ## Run the store/migration integration tests and the rolling-upgrade test against PostgreSQL 14, the minimum supported version (docker compose; needs Docker).
	./scripts/test-integration-postgres14.sh

.PHONY: test-e2e
test-e2e: plugin-build ## Run the plugin e2e suite in a pinned real Obsidian (wdio-obsidian-service; headless via xvfb) against a real server (docker compose; VAULT_SYNC_E2E_MOBILE=1 emulates mobile).
	./scripts/test-e2e.sh

.PHONY: acceptance
acceptance: plugin-build ## Run every acceptance test ([AC-nn] and [P3-nn] e2e and integration tests and Go subtests, Go TestACnn) and print the scoreboards for docs/acceptance/phase-2.md and phase-3.md (docker compose; written to build/acceptance/).
	./scripts/acceptance.sh

.PHONY: vulncheck
vulncheck: $(PLUGIN_DIR)/node_modules/.package-lock.json ## Report known vulnerabilities in Go and npm dependencies.
	govulncheck ./...
	cd $(PLUGIN_DIR) && npm audit --omit=dev

.PHONY: npm-audit
npm-audit: $(PLUGIN_DIR)/node_modules/.package-lock.json ## Fail on fixable moderate+ vulnerabilities in shipped plugin dependencies; warn on the rest (run in CI).
	./scripts/npm-audit.sh

##@ Code Generation

.PHONY: generate
generate: $(PLUGIN_DIR)/node_modules/.package-lock.json ## Regenerate protobuf/ConnectRPC code (Go into gen/, TS into plugin/src/gen/).
	buf generate

.PHONY: check-generate
check-generate: generate ## Fail if committed generated protobuf code differs from a fresh generation.
	@git diff --exit-code -- gen $(PLUGIN_DIR)/src/gen || { echo "generated code is stale: run 'make generate' and commit the result" >&2; exit 1; }
	@test -z "$$(git ls-files --others --exclude-standard -- gen $(PLUGIN_DIR)/src/gen)" || { echo "untracked generated files: run 'make generate' and commit the result" >&2; exit 1; }

##@ Plugin

$(PLUGIN_DIR)/node_modules/.package-lock.json: $(PLUGIN_DIR)/package.json $(PLUGIN_DIR)/package-lock.json
	cd $(PLUGIN_DIR) && npm ci
	@touch $@

.PHONY: plugin-build
plugin-build: $(PLUGIN_DIR)/node_modules/.package-lock.json ## Build the plugin bundle (main.js, manifest.json, styles.css) into plugin/dist/.
	cd $(PLUGIN_DIR) && npm run build
	cp $(PLUGIN_DIR)/manifest.json $(PLUGIN_DIR)/styles.css $(PLUGIN_DIR)/dist/

.PHONY: plugin-test
plugin-test: $(PLUGIN_DIR)/node_modules/.package-lock.json ## Run the plugin's vitest unit tests.
	cd $(PLUGIN_DIR) && npm test

.PHONY: plugin-lint
plugin-lint: $(PLUGIN_DIR)/node_modules/.package-lock.json ## Run eslint and tsc --noEmit over the plugin.
	cd $(PLUGIN_DIR) && npm run lint
	cd $(PLUGIN_DIR) && npm run typecheck

##@ Build

$(BIN_DIR)/vault-sync-server: $(GO_SOURCE_FILES) go.mod
	@mkdir -p "$(BIN_DIR)"
	CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)" -o "$@" ./cmd/vault-sync-server

.PHONY: build
build: $(BIN_DIR)/vault-sync-server plugin-build ## Build the server binary into bin/ and the plugin into plugin/dist/.

.PHONY: clean
clean: ## Remove build artifacts.
	@rm -rf $(BIN_DIR) $(PLUGIN_DIR)/dist $(CHART_DIR)/charts

##@ Container Images

# VERSION (above) is the one place a release is versioned: it is stamped into
# the binary and tags the image, the packaged chart, the plugin manifest and
# the git tag. PUSH_ALL=true also tags :latest and pushes; the default only
# builds and loads into the local Docker daemon. Registry credentials are
# taken from the Docker daemon / Helm registry login (no login step here).
CONTAINER_REGISTRY ?= ghcr.io/soliddowant
PUSH_ALL ?= false
IMAGE := $(CONTAINER_REGISTRY)/vault-sync

.PHONY: build-images
build-images: ## Build the server OCI image with Nix (patched Go), check its binary with govulncheck, load it into Docker and tag it ghcr.io/soliddowant/vault-sync:VERSION (PUSH_ALL=true also tags :latest and pushes).
	./scripts/build-images.sh "$(VERSION)" "$(PUSH_ALL)" "$(IMAGE)"

##@ Helm

CHART_DIR := deploy/charts/vault-sync
HELM_REGISTRY := $(CONTAINER_REGISTRY)/charts
HELM_PUSH ?= $(PUSH_ALL)

.PHONY: chart-lint
chart-lint: ## Lint the Helm chart and check its rendered manifests (Deployment, export CronJob, ServiceMonitor, Secret references, escrow never in the server); no cluster needed.
	./scripts/chart_test.sh

.PHONY: helm
helm: ## Package the Helm chart into bin/helm/, versioned VERSION (PUSH_ALL=true also pushes it to oci://ghcr.io/soliddowant/charts).
	@mkdir -p "$(BIN_DIR)/helm"
	./scripts/chart-dependencies.sh "$(CHART_DIR)"
	helm package "$(CHART_DIR)" --version "$(VERSION)" --app-version "$(VERSION)" --destination "$(BIN_DIR)/helm"
	$(if $(filter true,$(HELM_PUSH)),helm push "$(BIN_DIR)/helm/vault-sync-$(VERSION).tgz" oci://$(HELM_REGISTRY),@echo "Skipping chart push (set PUSH_ALL=true to push to oci://$(HELM_REGISTRY))")

##@ Release

RELEASE_ASSET_DIR := $(BIN_DIR)/release

.PHONY: plugin-release-assets
plugin-release-assets: plugin-build ## Collect the plugin release assets (main.js, manifest.json stamped with VERSION, styles.css) into bin/release/.
	@mkdir -p "$(RELEASE_ASSET_DIR)"
	cp $(PLUGIN_DIR)/dist/main.js $(PLUGIN_DIR)/dist/styles.css "$(RELEASE_ASSET_DIR)/"
	jq --arg version "$(VERSION)" '.version = $$version' $(PLUGIN_DIR)/dist/manifest.json > "$(RELEASE_ASSET_DIR)/manifest.json"

# Dry run by default: the tag, tag push and GitHub release are printed.
# PUSH_ALL=true releases for real. The preflight (version, gh auth, a non-empty
# CHANGELOG.md section for the version, and for a real release a clean tree,
# HEAD equal to origin/master and a new tag) runs first, and the plugin
# assets are built and checked before anything is tagged. Pushing the tag
# starts the release workflow
# (.github/workflows/release.yml), which publishes the image and chart, so
# this target needs no registry credentials.
.PHONY: release
release: ## Release VERSION: tag VERSION and create a GitHub release whose notes are VERSION's CHANGELOG.md section, with the plugin's main.js, manifest.json and styles.css for BRAT; the tag starts the workflow that publishes the image and chart. Dry run unless PUSH_ALL=true. Requires gh.
	./scripts/release.sh preflight "$(VERSION)" "$(PUSH_ALL)"
	$(MAKE) plugin-release-assets VERSION="$(VERSION)"
	./scripts/release.sh publish "$(VERSION)" "$(PUSH_ALL)" "$(RELEASE_ASSET_DIR)"

##@ Dependencies

.PHONY: update-vendor-hash
update-vendor-hash: ## Refresh vendorHash in nix/server.nix after go.mod or go.sum changed (needs nix and network).
	./scripts/update-vendor-hash.sh

.PHONY: update-dependencies
update-dependencies: ## Update Nix flake inputs, Go modules, and plugin npm packages.
	nix flake update
	go get -u ./...
	go mod tidy
	./scripts/update-vendor-hash.sh
	cd $(PLUGIN_DIR) && npx --yes npm-check-updates -u --peer && npm install
