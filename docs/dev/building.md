# Building

For: developers. You know Go, TypeScript and Nix flakes. Read [architecture.md](architecture.md) first.

## The dev shell

The Nix flake (`flake.nix`) provides every tool: Go, Node and npm, `buf`, `golangci-lint`, Helm and the test tools. Enter the shell in the checkout or worktree:

```sh
nix develop      # or: direnv allow
make help
make lint test
```

With `direnv`, `.envrc` loads the shell when you enter the directory.

Always evaluate the flake as a git flake. Run `nix develop` inside the checkout or worktree. In Nix expressions, use `builtins.getFlake "git+file://${toString ./.}"`, not `builtins.getFlake (toString ./.)`. A path flake (`path:...`, or a bare path passed to `builtins.getFlake`) makes Nix copy the whole directory into the store. That includes gitignored caches such as `plugin/node_modules` and `plugin/.wdio-obsidian-cache`, which are over 1 GB. The dev shell and the packages refuse to evaluate from such a source, and `scripts/flake-source_test.sh` (part of `make test`) tests this.

Nothing in `flake.nix` can refuse access to the `inputs` or `outPath` of a path flake, for example `(builtins.getFlake (toString ./.)).inputs.nixpkgs.rev`. Nix attaches them itself, so such an expression still succeeds after it copies the whole tree. Never write it.

## The modules

The Go code is one module at the repository root, `github.com/solidDoWant/vault-sync`. `plugin/` is an npm project. `plugin/go.mod` is a deliberately empty nested Go module: it keeps the npm project and its `node_modules` out of `./...`.

## Make targets

`make help` lists every target with its description. The ones you use most:

| Target | What it does |
|---|---|
| `make build` | Builds the server binary into `bin/` and the plugin bundle (`main.js`, `manifest.json`, `styles.css`) into `plugin/dist/`. |
| `make fmt`, `make vet` | Formats and vets the Go code. |
| `make lint` | Runs `golangci-lint`, `buf lint` and `buf breaking` against `master`, and eslint and `tsc` over the plugin. `make lint-fix` applies the fixes it can. |
| `make test` | Runs the Go unit tests with `-race`, the plugin's vitest tests and the tests of the scripts. |
| `make test-integration` | Runs the `integration`-tagged Go tests against a real PostgreSQL and S3 in `docker compose`. |
| `make test-e2e` | Runs the plugin in a pinned real Obsidian against a real server. |
| `make acceptance` | Runs every acceptance test and prints the scoreboard. |
| `make generate`, `make check-generate` | Regenerates the protobuf code, or fails when the committed code differs. |
| `make chart-lint` | Lints the Helm chart and tests its rendered manifests. No cluster is needed. |
| `make build-images` | Builds the server OCI image with Nix and runs `govulncheck` on its binary. |
| `make vulncheck` | Reports known vulnerabilities in the Go and npm dependencies. |

The test targets are explained in the guides in `docs/testing/`, linked from [the developer README](README.md#testing).

## Generated code

The API is defined in `proto/vaultsync/v1/`. `buf` generates the Go code into `gen/` and the TypeScript code into `plugin/src/gen/`. The generated code is committed. Never edit it by hand. After you change a `.proto` file, run `make generate` and commit the result. CI runs `make check-generate` and fails when the committed code is out of date.

Schema changes must stay backward compatible. `make lint` runs `buf breaking` against `master`. If it fails, read `docs/testing/proto-compatibility.md`.

## Dependencies

- `make update-dependencies` updates the Nix flake inputs, the Go modules and the plugin's npm packages.
- After a change to `go.mod` or `go.sum`, run `make update-vendor-hash`. It refreshes `vendorHash` in `nix/server.nix`, which `make build-images` needs. See [releasing.md](releasing.md#the-go-vendor-hash).
