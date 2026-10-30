# Deploying vault-sync

This introduction moved to [Requirements](admin/requirements.md#the-reference-setup) and [Install](admin/install.md#what-you-deploy).

## The image

This section moved to [Install](admin/install.md#the-image).

## PostgreSQL (CloudNativePG)

This section moved to [PostgreSQL and S3](admin/postgresql-and-s3.md#postgresql).

## S3 (Ceph RGW)

This section moved to [PostgreSQL and S3](admin/postgresql-and-s3.md#s3).

## Authentik (the device-flow application)

This section moved to [Identity provider](admin/identity-provider.md#example-authentik).

## The WAF body limit (Istio and Coraza)

How the request limits of the server relate to the limits of the WAF moved to [Request size and the WAF](admin/security.md#request-size-and-the-waf).

The rest of the ingress moved to [Install](admin/install.md#the-ingress).

## The export job

This section moved to [Backup and restore](admin/backup-and-restore.md#the-export-job).

## Installing the chart

This section moved to [Install](admin/install.md#install-the-chart).

## Upgrading

This section moved to [Upgrades and high availability](admin/upgrades.md#upgrade-the-server).

## Per-vault retention

This section moved to [History and retention](admin/history-and-retention.md#per-vault-overrides).

## Undeleting a vault

This section moved to [Backup and restore](admin/backup-and-restore.md#undelete-a-vault).

## Chart values

This section moved to [Chart values](admin/chart-values.md), which is generated from the comments in the chart's `values.yaml`.

### Shared settings

This section moved to [Chart values](admin/chart-values.md#shared-settings).

### PostgreSQL

This section moved to [Chart values](admin/chart-values.md#postgresql).

### S3

This section moved to [Chart values](admin/chart-values.md#s3).

### OIDC

This section moved to [Chart values](admin/chart-values.md#oidc).

### Server

This section moved to [Chart values](admin/chart-values.md#server) and, for the ServiceMonitor values, [Metrics](admin/chart-values.md#metrics).

### Export

This section moved to [Chart values](admin/chart-values.md#export).

### Route

This section moved to [Chart values](admin/chart-values.md#route).

### Grafana dashboards

This section moved to [Chart values](admin/chart-values.md#grafana-dashboards).

### Alerts

This section moved to [Chart values](admin/chart-values.md#alerts).

### Overriding the computed resources

This section moved to [Chart values](admin/chart-values.md#overriding-the-computed-resources).

## High availability

This section moved to [Upgrades and high availability](admin/upgrades.md#high-availability).

## Monitoring

This section moved to [Monitoring](admin/monitoring.md).

## Releasing

How a release is made is in [`dev/releasing.md`](dev/releasing.md).

