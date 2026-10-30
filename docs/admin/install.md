# Install

For: admins. You have everything that [Requirements](requirements.md) lists, and you know Helm.

This page installs the vault-sync server and its plaintext export job on Kubernetes with the Helm chart in `deploy/charts/vault-sync`. The examples use the [reference setup](requirements.md#the-reference-setup): PostgreSQL run by CloudNativePG, Ceph RGW for S3, Authentik for sign-in, and an Istio gateway with a Coraza WAF in front. [Configuration](configuration.md) describes the server settings that the chart sets, and the [configuration reference](configuration-reference.md) lists every environment variable. [Chart values](chart-values.md) lists every chart value.

## What you deploy

- **The server.** This is a Deployment of two or more identical replicas behind one Service. It is the only part that faces the internet. The replicas share one PostgreSQL database and one S3 bucket and keep no state of their own, so you can stop any replica at any time ([Upgrades](upgrades.md) has more about high availability).
- **The export job.** This is a CronJob that runs `vault-sync-server export`. It writes a plaintext copy of every vault to a volume that your tape-archival tooling reads. It has its own credentials. It is the only part that can ever hold the escrow private key. It is off by default. Turn it on with `config.export.enabled: true` ([The export job](backup-and-restore.md#the-export-job)), because it is the plaintext disaster-recovery copy of every vault.
- **Nothing else.** The chart creates no database, no bucket, no Secret and no client in the sign-in provider. It refers to the ones that you create in the steps below.

## The image

The image `ghcr.io/soliddowant/vault-sync:<version>` holds one static binary, `/bin/vault-sync-server`, and CA roots. It has no shell and no package manager. It runs as user and group `65532`. It needs no writable path, except the output volume of the export job.

The same image runs three things:

- The server, with no arguments.
- The export, with `export -out DIR`.
- The Markdown import, with `import VAULT_ID DIR` ([import.md](backup-and-restore.md#import-markdown)).

The image is built reproducibly with Nix (`nix/server.nix`, `nix/server-image.nix`, `dockerTools.streamLayeredImage`), with the pinned Go toolchain of the flake. Every build checks the binary with `govulncheck -mode=binary` ([Releasing](../deployment.md#releasing)).

## Before you install

1. Create the PostgreSQL database, the role and its client certificate, and the S3 bucket and its credentials Secret. [PostgreSQL and S3](postgresql-and-s3.md) has the steps.
2. Create the client in your sign-in provider. [Identity provider](identity-provider.md) has the steps. Note its issuer URL and its client ID.
3. If you turn on the export job, create its output volume, for example a PersistentVolumeClaim named `vault-sync-export`.

## Install the chart

The chart is published to `oci://ghcr.io/soliddowant/charts/vault-sync`. It has the same version as the image.

1. Write a values file, `values.yaml`. This is a minimal file for the reference setup:

   ```yaml
   config:
     database:
       url:
         value: host=vault-sync-postgres-rw dbname=vault_sync user=vault_sync sslmode=verify-full
       tls:
         clientCertificate:
           secretName: vault-sync-postgres-client
         caCert:
           secretKeyRef:
             name: vault-sync-postgres-ca
             key: ca.crt
     s3:
       bucket: vault-sync-0b7c…
       endpoint: http://rook-ceph-rgw-objectstore.rook-ceph.svc
       credentials:
         secretName: vault-sync
     oidc:
       issuerUrl: https://auth.example.com/application/o/vault-sync/
       audience: <client id>
     export:
       enabled: true
       output:
         persistence:
           type: persistentVolumeClaim
           existingClaim: vault-sync-export
     route:
       enabled: true
       parentRefs:
         - name: public-gateway
           namespace: istio-ingress
       hostnames:
         - sync.example.com
   ```

2. Install the chart into the namespace `vault-sync`. Replace the version with the release that you install:

   ```sh
   helm install vault-sync oci://ghcr.io/soliddowant/charts/vault-sync --version <version> -n vault-sync -f values.yaml
   ```

## What the chart creates

The chart names each resource after the release, here `vault-sync`. It creates:

- The server Deployment.
- One Service with the ports `http` (8080), `metrics` (9090) and `service-metrics` (9091).
- An HTTPRoute.
- A ServiceAccount without an API token.
- The export CronJob `vault-sync-export`.

Some values add more resources:

- `config.server.metrics.serviceMonitor.enabled: true` adds a ServiceMonitor. With `config.server.metrics.serviceWide.enabled: true` as well, that ServiceMonitor also scrapes the port `service-metrics`.
- `config.alerts.prometheusRule.enabled: true` adds a PrometheusRule with the alerting rules ([Alerts](chart-values.md#alerts)).

The chart creates no Secrets. It sets no PodDisruptionBudget, no container resources and no spread constraints. [Replicas and sizing](requirements.md#replicas-and-sizing) and [High availability](upgrades.md#high-availability) say what to add.

The chart never puts the chart name twice in a resource name. For example, a release `obsidian-vault-sync` creates the Deployment, Service, ServiceAccount, ServiceMonitor, HTTPRoute and PodDisruptionBudget `obsidian-vault-sync`, and the CronJob `obsidian-vault-sync-export`. The chart sets the bjw-s `global.nameOverride` to the release name, unless you set it yourself.

## The ingress

Your ingress or gateway must meet these needs:

- **Route only the port `http`.** Route the host to the port `http` (8080) of the Service. You can use `config.route`, a Gateway API HTTPRoute ([Route](chart-values.md#route)), or `resources.ingress`. Never expose the port `metrics` (9090) or `service-metrics` (9091) outside the cluster.
- **Allow WebSocket upgrades on `/v1/realtime`.** Each device keeps one WebSocket open at `GET /v1/realtime` on the API listener. It tells the device about new changes. It carries binary protobuf frames of a few bytes each. Without it, changes from other devices still arrive, but only at the next periodic sync of the plugin, within 30 seconds.
- **Do not close idle connections faster than every 30 seconds.** The server pings each client every 30 seconds. It disconnects a client that does not answer within 10 seconds.
- **Do not limit request time below what the chart route sets.** The route allows 15 minutes for a request, because a `CommitBlob` response starts only after the server composes the whole blob. That can take up to 10 minutes (SPEC.md §6.2). The route sets no time limit for `/v1/realtime`, because the WebSocket stays open for a long time.
- **Do not log the `Sec-WebSocket-Protocol` header.** It carries the access token. This applies to the WAF and to any proxy that logs request headers.
- **Keep the CORS headers.** The server sends the CORS headers for the app origins of Obsidian itself. Do not remove them.
- **Keep the WAF body limit.** If a WAF inspects request bodies, read [Request size and the WAF](security.md#request-size-and-the-waf).

The chart renders one Service. So the backend of an ingress resolves to the port `http` without the name of a Service:

```yaml
resources:
  ingress:
    main:
      hosts:
        - host: sync.example.com
          paths:
            - path: /
              service:
                port: http
```

## First sign-in check

Do these steps after the install to make sure that the server works.

1. Make sure that the rollout is complete:

   ```sh
   kubectl -n vault-sync rollout status deployment/vault-sync
   ```

   A replica becomes ready only after it connects to PostgreSQL, applies the schema migrations and reaches the bucket. If the rollout does not complete, read the logs of a pod (`kubectl -n vault-sync logs deployment/vault-sync`) and see [The server does not start](troubleshooting.md#the-server-does-not-start).
2. On a device, install the plugin and open **Settings → Vault Sync**. In **Server URL**, enter the address of your route, for example `https://sync.example.com`. [Getting started](../user/getting-started.md) shows the plugin steps.
3. Click **Sign in**. Sign in with your sign-in provider on the page that the dialog links to, and enter the code. If the sign-in fails, see [Identity provider](identity-provider.md).
4. In **Remote vault**, click **Create a vault**. The status shows `syncing` and then `idle`.
5. Connect a second device to the same vault, and change a note on the first device. The change arrives on the second device within seconds. If it arrives only after about 30 seconds, the ingress does not pass WebSocket upgrades on `/v1/realtime`. See [The ingress](#the-ingress).
