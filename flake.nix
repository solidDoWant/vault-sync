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
      in
      {
        # Package and OCI image derivations (nix/*.nix) are added by the
        # release-tooling issue, following tape-archiver's streamLayeredImage
        # pattern.

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.go
            pkgs.golangci-lint
            pkgs.govulncheck
            pkgs.gnumake
            # gh is deliberately NOT provided here: the coder VM ships a gh
            # wrapper in ~/.local/bin that fetches a fresh (8h) GitHub App token
            # per call, and a dev-shell gh would shadow it on PATH and fall back
            # to a stale token.
            pkgs.jq

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

            pkgs.kubernetes-helm
          ];
        };
      });
}
