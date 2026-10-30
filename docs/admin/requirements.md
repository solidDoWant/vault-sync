# Requirements

For: admins. You plan to run the vault-sync server, and you know Kubernetes, Helm, PostgreSQL, S3 and OIDC.

This page lists what the server needs before you install it. [Install](install.md) then takes you through the installation with the Helm chart.

## What the server needs

- **Kubernetes and Helm.** The server runs on Kubernetes. You install it with the Helm chart in `deploy/charts/vault-sync`.
- **PostgreSQL 14 or newer.** On an older version the schema migrations fail and the server exits. Give vault-sync its own database and role. [PostgreSQL and S3](postgresql-and-s3.md) tells you how to set them up.
- **An S3 bucket.** The server keeps file content in one bucket of an S3-compatible object store. [PostgreSQL and S3](postgresql-and-s3.md) has the bucket and its credentials.
- **An OIDC sign-in provider.** Users sign in through your OIDC provider. [Identity provider](identity-provider.md) says what the provider must offer.
- **TLS in front of the server.** Clients connect over HTTPS. Your ingress or gateway ends TLS and sends the traffic to the server. It must also pass WebSocket upgrades. [Install](install.md#the-ingress) has what the ingress needs.

The server keeps all of its state in PostgreSQL and S3. The Helm chart creates no database, no bucket, no Secret and no client in the sign-in provider. You create them first, and the chart refers to them.

## The reference setup

vault-sync is built for one setup. It is a Kubernetes cluster on Talos with these parts:

- **PostgreSQL** run by CloudNativePG. The server signs in to PostgreSQL with a client certificate. CloudNativePG rotates the certificates, so the server reads them again and never keeps one for the life of the process.
- **Object storage** from Ceph RGW, through its S3 API.
- **Sign-in** through Authentik, an OIDC provider.
- **An Istio gateway** with a Coraza WAF (web application firewall) in front of the server. The WAF rejects inspected request bodies above 1 MiB. So the plugin uploads every file in chunks of a size that you can change, 768 KiB by default. [The WAF body limit](../deployment.md#the-waf-body-limit-istio-and-coraza) explains how the server limits fit under the WAF limit.

The examples in these pages use this setup.

## Replicas and sizing

The server runs as two or more identical replicas behind one Service. The replicas share one PostgreSQL database and one S3 bucket and keep no state of their own. So you can stop any replica at any time, for example for node maintenance, and clients see no effect. Do not give the server a volume that it writes to.

The chart sets no container resources, no PodDisruptionBudget and no topology spread constraints. You set them yourself under `resources` ([Overriding the computed resources](../deployment.md#overriding-the-computed-resources) has the value paths). As a starting point, earlier chart versions requested 100m CPU and 128Mi memory for the server and for the export job. Their limits were 1 CPU and 512Mi memory for the server, and 1Gi memory for the export job. The memory of a server grows with the number of requests that it serves at the same time. Each request holds up to `VAULT_SYNC_MAX_REQUEST_BYTES` ([configuration reference](configuration-reference.md)). To serve more users, add replicas with `resources.controllers.main.replicas`.
