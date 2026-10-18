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
test: fmt vet plugin-test ## Run unit tests: Go (race detector) + plugin vitest + buf breaking check tests.
	go test -race -count=1 ./...
	./scripts/buf-breaking_test.sh

.PHONY: test-integration
test-integration: $(PLUGIN_DIR)/node_modules/.package-lock.json ## Run integration tests against PostgreSQL + S3 (docker compose; skipped without Docker), incl. the plugin protocol client vs the real server.
	./scripts/test-integration.sh

.PHONY: test-sim
test-sim: ## TODO(phase 1): multi-client sync simulation (SIM_SEEDS, SIM_STEPS).
	@echo "test-sim: not yet implemented" >&2; exit 1

.PHONY: test-e2e
test-e2e: ## TODO(phase 2): plugin e2e in real Obsidian via wdio-obsidian-service.
	@echo "test-e2e: not yet implemented" >&2; exit 1

.PHONY: vulncheck
vulncheck: $(PLUGIN_DIR)/node_modules/.package-lock.json ## Report known vulnerabilities in Go and npm dependencies.
	govulncheck ./...
	cd $(PLUGIN_DIR) && npm audit --omit=dev

##@ Code Generation

.PHONY: generate
generate: $(PLUGIN_DIR)/node_modules/.package-lock.json ## Regenerate protobuf/ConnectRPC code (Go into gen/, TS into plugin/src/gen/).
	buf generate

.PHONY: check-generate
check-generate: generate ## Fail if committed generated code differs from a fresh generation.
	@git diff --exit-code -- gen $(PLUGIN_DIR)/src/gen || { echo "generated code is stale: run 'make generate' and commit the result" >&2; exit 1; }
	@test -z "$$(git ls-files --others --exclude-standard -- gen $(PLUGIN_DIR)/src/gen)" || { echo "untracked generated files: run 'make generate' and commit the result" >&2; exit 1; }

##@ Plugin

$(PLUGIN_DIR)/node_modules/.package-lock.json: $(PLUGIN_DIR)/package.json $(PLUGIN_DIR)/package-lock.json
	cd $(PLUGIN_DIR) && npm ci
	@touch $@

.PHONY: plugin-build
plugin-build: $(PLUGIN_DIR)/node_modules/.package-lock.json ## Build the plugin bundle into plugin/dist/.
	cd $(PLUGIN_DIR) && npm run build
	cp $(PLUGIN_DIR)/manifest.json $(PLUGIN_DIR)/dist/

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
	@rm -rf $(BIN_DIR) $(PLUGIN_DIR)/dist

##@ Dependencies

.PHONY: update-dependencies
update-dependencies: ## Update Nix flake inputs, Go modules, and plugin npm packages.
	nix flake update
	go get -u ./...
	go mod tidy
	cd $(PLUGIN_DIR) && npx --yes npm-check-updates -u --peer && npm install
