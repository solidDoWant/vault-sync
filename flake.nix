{
  description = "vault-sync development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Nix copies a flake's source into the store before evaluating it. As
        # a git flake (`nix develop` in a checkout or worktree) only tracked
        # files are copied. As a path flake (`path:...`, or
        # `builtins.getFlake (toString ./.)`, which treats a bare path as
        # `path:`) the whole directory is copied, including the gitignored
        # plugin/node_modules and plugin/.wdio-obsidian-cache (over 1 GB),
        # once per evaluation of a changed tree (#158). That copy cannot be
        # prevented from in here, so evaluating the dev shell or the packages
        # from a path flake fails instead of silently repeating it. Git
        # sources carry rev (clean) or dirtyRev (dirty); path sources carry
        # neither. Only outputs can be guarded: Nix attaches `inputs` and
        # `outPath` itself, so for example
        # `(builtins.getFlake (toString ./.)).inputs.nixpkgs.rev` still
        # evaluates, after making the copy (#222). Documentation (README.md,
        # CLAUDE.md) is the only mitigation for that.
        requireGitSource = value:
          if self ? rev || self ? dirtyRev then
            value
          else
            throw ''
              vault-sync: this flake was evaluated as a path flake, so Nix copied the whole directory, gitignored caches included, to ${self.outPath}.
              Evaluate it as a git flake instead: run `nix develop` inside the checkout or worktree, or use builtins.getFlake "git+file://''${toString ./.}" rather than builtins.getFlake (toString ./.).
              Reclaim the space with: nix store delete ${self.outPath}
              See README.md (Development).
            '';

        # The Go toolchain for the dev shell and every Go build (the OCI
        # image derivations must build with this, e.g. via
        # `pkgs.buildGoModule.override { inherit go; }`). nixpkgs-unstable
        # still ships go 1.26.8, which has standard-library vulnerabilities
        # fixed in 1.26.9 (#140) and in 1.26.10 (GO-2026-6809, crypto/x509,
        # #603), so the pinned Go is overridden to 1.26.10 (the hash is the
        # sha256 go.dev publishes for go1.26.10.src.tar.gz) until nixpkgs
        # catches up; once the pinned Go is at least the go.mod toolchain
        # version it is used as is and this override can be deleted.
        #
        # The minimum is the toolchain go.mod selects: its `toolchain`
        # directive, or its `go` line when there is none (`go mod tidy` drops
        # a toolchain equal to the go version); setup-go in CI reads go.mod
        # the same way. Raising it there without a nixpkgs Go or a patched Go
        # below that is at least as new makes every evaluation of the flake
        # fail with a message saying so.
        goMod = builtins.readFile ./go.mod;
        goModToolchain = builtins.match ".*\ntoolchain go([0-9.]+)\n.*" goMod;
        goModGo = builtins.match ".*\ngo ([0-9.]+)\n.*" goMod;
        minimumGoVersion =
          if goModToolchain != null then
            builtins.head goModToolchain
          else if goModGo != null then
            builtins.head goModGo
          else
            throw "vault-sync: go.mod has neither a `toolchain goX.Y.Z` nor a `go X.Y.Z` line; flake.nix reads the minimum Go version from it";
        patchedGoVersion = "1.26.10";
        go =
          if pkgs.lib.versionAtLeast pkgs.go.version minimumGoVersion then
            pkgs.go
          else if pkgs.lib.versionAtLeast patchedGoVersion minimumGoVersion then
            pkgs.go.overrideAttrs (finalAttrs: _: {
              version = patchedGoVersion;
              src = pkgs.fetchurl {
                url = "https://go.dev/dl/go${finalAttrs.version}.src.tar.gz";
                hash = "sha256-/WPog7ovK/ypPBZGsx6+9j4rHk0rMXyXidl2po2B828=";
              };
            })
          else
            throw "vault-sync: go.mod requires toolchain go${minimumGoVersion}, but nixpkgs has Go ${pkgs.go.version} and flake.nix patches in ${patchedGoVersion}; update patchedGoVersion and its source hash in flake.nix (or nixpkgs).";

        # Shared libraries of the Obsidian (Electron) build and chromedriver
        # that the plugin e2e suite downloads (make test-e2e). They are
        # generic Linux binaries, so on NixOS they run through nix-ld, which
        # loads them with NIX_LD and resolves their libraries from
        # NIX_LD_LIBRARY_PATH; on other Linux distributions the system's own
        # loader and libraries are used and both are ignored.
        electronLibraries = with pkgs; [
          alsa-lib
          at-spi2-atk
          at-spi2-core
          cairo
          cups
          dbus
          expat
          glib
          gtk3
          libdrm
          libgbm
          libGL
          libxkbcommon
          nspr
          nss
          pango
          systemd
          libx11
          libxcomposite
          libxdamage
          libxext
          libxfixes
          libxrandr
          libxcb
          libxshmfence
        ];

        # The version stamped into the server binary and used as the image
        # tag. `make build-images` and `make release` pass the release version
        # as VAULT_SYNC_VERSION and evaluate with --impure so it can be read
        # here; it is a build argument, never committed. A pure evaluation
        # (`nix build .#server`) reads "" and falls back to the git revision.
        releaseVersion = builtins.getEnv "VAULT_SYNC_VERSION";
        revision = self.shortRev or self.dirtyShortRev or "";
        version = if releaseVersion != "" then releaseVersion else revision;

        # The server binary, built with the patched `go` above rather than
        # nixpkgs' default Go, so the shipped binary carries the same
        # standard-library fixes as the dev shell (#140). `make build-images`
        # checks it with `govulncheck -mode=binary`.
        server = pkgs.callPackage ./nix/server.nix {
          buildGoModule = pkgs.buildGoModule.override { inherit go; };
          inherit version;
        };

        # The OCI image (streamLayeredImage, as in tape-archiver): the server
        # binary and CA roots.
        serverImage = pkgs.callPackage ./nix/server-image.nix {
          inherit server;
          tag = if version != "" then version else "dev";
        };
      in
      {
        packages = requireGitSource {
          inherit server serverImage;
          default = server;
        };

        devShells.default = requireGitSource (pkgs.mkShell {
          packages = [
            go
            pkgs.golangci-lint
            pkgs.govulncheck
            pkgs.gnumake
            # git pinned by flake.lock, so local runs and CI (which runs make
            # through `nix develop -c`) use the same version instead of the
            # host's. Versions differ in behavior: since 2.55 detached
            # auto-maintenance keeps objects/maintenance.lock after the command
            # returns, which broke scripts/buf-breaking_test.sh on CI (#104).
            pkgs.git
            # gh is deliberately NOT provided here: the coder VM ships a gh
            # wrapper in ~/.local/bin that fetches a fresh (8h) GitHub App token
            # per call, and a dev-shell gh would shadow it on PATH and fall back
            # to a stale token.
            pkgs.jq
            # Agents reach for python3 for ad-hoc scripting; the VM image has none.
            pkgs.python3

            # Protobuf/ConnectRPC code generation (make generate). The TS
            # generator (protoc-gen-es) comes from plugin/node_modules so it
            # stays in lockstep with the @bufbuild/protobuf runtime version.
            pkgs.buf
            pkgs.protoc-gen-go
            pkgs.protoc-gen-connect-go

            # Plugin toolchain (npm ships with node; package-lock.json is
            # committed).
            pkgs.nodejs_24

            # Integration dependencies (PostgreSQL, S3-compatible store) run
            # under docker compose.
            pkgs.docker
            pkgs.docker-compose

            # Headless X server for the plugin e2e suite (real Obsidian via
            # wdio-obsidian-service).
            pkgs.xvfb-run

            # Helm chart lint, render and packaging (make chart-lint, make
            # helm), and yq for the rendered-manifest assertions in
            # scripts/chart_test.sh, and promtool for the alerting rules'
            # checks and unit tests there.
            pkgs.kubernetes-helm
            pkgs.yq-go
            pkgs.prometheus.cli
          ];

          # The loader comes from the same nixpkgs as the libraries, so that
          # they agree on the glibc version.
          shellHook = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
            export NIX_LD="${pkgs.stdenv.cc.bintools.dynamicLinker}"
            export NIX_LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath electronLibraries}''${NIX_LD_LIBRARY_PATH:+:$NIX_LD_LIBRARY_PATH}"
          '';
        });
      });
}
