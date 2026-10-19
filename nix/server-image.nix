# OCI image for the vault-sync server and its export job (SPEC.md §12).
#
# One image serves both: the Helm chart runs the binary as the API server
# (Deployment) and as `vault-sync-server export` (CronJob). It holds only the
# static server binary and CA roots (for the OIDC issuer, S3 and PostgreSQL
# TLS); there is no shell or package manager. streamLayeredImage emits a
# script that streams the image tarball to stdout, which `make build-images`
# pipes into `docker load`.
{
  dockerTools,
  cacert,
  server,
  # The image tag: the release version, or the git revision for local builds.
  # `make build-images` re-tags it for the registry.
  tag,
}:
dockerTools.streamLayeredImage {
  name = "vault-sync";
  inherit tag;

  contents = [
    server
    cacert
  ];

  config = {
    Entrypoint = [ "/bin/vault-sync-server" ];
    # A fixed non-root user (the conventional "nonroot" id). The image has no
    # /etc/passwd entry for it, which the server does not need.
    User = "65532:65532";
    Env = [
      "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
    ];
    ExposedPorts = {
      # API (ConnectRPC + realtime WebSocket), VAULT_SYNC_LISTEN_ADDRESS.
      "8080/tcp" = { };
      # Metrics and health, VAULT_SYNC_METRICS_LISTEN_ADDRESS.
      "9090/tcp" = { };
    };
    Labels = {
      "org.opencontainers.image.title" = "vault-sync";
      "org.opencontainers.image.description" =
        "vault-sync server: self-hosted Obsidian sync on PostgreSQL and S3";
      "org.opencontainers.image.source" = "https://github.com/solidDoWant/vault-sync";
      "org.opencontainers.image.licenses" = "AGPL-3.0-only";
      "org.opencontainers.image.version" = tag;
    };
  };
}
