# Nix build of the vault-sync server binary (`cmd/vault-sync-server`, which
# also carries the `export` subcommand).
#
# CGO is disabled so the binary is a self-contained static executable: the
# image (nix/server-image.nix) needs nothing but the binary and CA roots.
{
  lib,
  buildGoModule,
  # The version stamped into internal/version via -ldflags. flake.nix passes
  # the release version (make build-images / make release) or the git
  # revision. The source below is a fileset copy without .git, so the binary
  # cannot recover its revision from Go's embedded build info.
  version ? "",
}:
buildGoModule {
  pname = "vault-sync-server";
  # The derivation label only; the version the binary reports comes from the
  # -X stamp below.
  version = if version != "" then version else "0-dev";

  # Only the Go module's sources, so edits to docs, the plugin, the chart or
  # Nix files do not rebuild the binary or change the vendor hash. The plugin
  # directory is a separate (empty) Go module and is deliberately left out.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../go.mod
      ../go.sum
      ../cmd
      ../gen
      ../internal
    ];
  };

  # Hash of the vendored Go module dependencies. Refresh it whenever go.mod or
  # go.sum change with `make update-vendor-hash` (scripts/update-vendor-hash.sh),
  # which rewrites this line; it expects exactly one `vendorHash = "...";` line.
  vendorHash = "sha256-fWTPYAWf9psUQajM9sJHEuf1ea9N/usPQYO+p6zO7Pc=";

  subPackages = [ "cmd/vault-sync-server" ];

  env.CGO_ENABLED = 0;

  # No "-s": the symbol table must stay so that govulncheck -mode=binary
  # (make build-images) can tell which symbols are linked. A stripped binary
  # makes it match whole modules, so it flags any advisory in a linked
  # module, such as golang.org/x/crypto/openpgp (GO-2026-5932), even when
  # the vulnerable package is never imported.
  ldflags = [
    "-w"
  ]
  ++ lib.optionals (version != "") [
    "-X github.com/solidDoWant/vault-sync/internal/version.version=${version}"
  ];

  # Tests run in `make test` / `make test-integration` (they need Docker,
  # PostgreSQL and S3), not in the image build.
  doCheck = false;

  meta = {
    description = "vault-sync sync server and plaintext export job";
    mainProgram = "vault-sync-server";
    license = lib.licenses.agpl3Only;
    platforms = lib.platforms.linux;
  };
}
