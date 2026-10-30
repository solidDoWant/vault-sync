# Monitoring

For admins who run the server. This page explains the health checks, the metrics, how to scrape them, and the Grafana dashboards. [Alerts](alerts.md) has the alert rules and one runbook per alert. [metrics-reference.md](metrics-reference.md) lists every metric.

## Health checks and metrics endpoints

The server has two metrics listeners. [Endpoints](configuration.md#endpoints) lists every listener and its address variable.

The per-instance metrics listener (port `metrics`, 9090 in the chart) serves these paths:

| Path | Meaning |
|---|---|
| `/healthz` | Liveness. Returns 200 while the process is serving. |
| `/readyz` | Readiness. Returns 200 when PostgreSQL answers a ping within 2 seconds, and 503 when it does not or while the server is shutting down. Concurrent checks share one ping, so a burst of probes against a slow database holds at most one pool connection. No result is reused after its ping ends, and each replica checks only its own connection pool. |
| `/metrics` | The Prometheus metrics of this replica ([per-replica metrics](metrics-reference.md#per-replica-metrics)). |

The chart uses `/healthz` for the startup and liveness probes and `/readyz` for the readiness probe.

## Service-wide metrics

Service-wide metrics describe the whole deployment, not one replica. The server serves them only on `VAULT_SYNC_SERVICE_METRICS_LISTEN_ADDRESS` (path `/metrics`, port `service-metrics`, 9091 in the chart), never on the per-instance metrics port. [metrics-reference.md](metrics-reference.md#service-wide-metrics) lists them.

Every replica serves the same values, so a scrape configuration can scrape them from a single replica. A scrape never queries the database. Each replica reads the values from PostgreSQL in the background every `VAULT_SYNC_SERVICE_METRICS_INTERVAL`, each query bounded by a 10-second timeout, and serves the last values that it read. When a query fails, the server logs `service metrics query failed` and keeps the previous values of its metrics. Alert when `vault_sync_service_metrics_last_refresh_success_timestamp_seconds` falls behind (the [VaultSyncServiceMetricsStale](alerts.md#vaultsyncservicemetricsstale) alert does this).

No metric has a per-user, per-vault or per-device label.

## Scraping with the chart

`config.server.metrics.serviceMonitor.enabled` scrapes the per-instance port with a prometheus-operator ServiceMonitor. `config.server.metrics.serviceWide.enabled` adds the service-wide port ([Chart values](../deployment.md#server)).

The service-wide alerts (retention, export, backlogs) read the service-wide metrics. If you do not scrape port `service-metrics`, with the chart or with your own scrape configuration, these alerts never fire. [Alerts](../deployment.md#alerts) shows how to turn on the alert rules.

## Grafana dashboards

The chart ships three Grafana dashboards. Their JSON is in `deploy/charts/vault-sync/dashboards/` and is packaged with the chart. Links in each dashboard lead to the others. Their UIDs are stable, so links and bookmarks survive upgrades.

| Dashboard | UID | What it is for |
|---|---|---|
| vault-sync / Overview | `vault-sync-overview` | The service-wide view: a row of alert states (stale service-wide metrics, commit listeners down, retention and OIDC key failures, RPC error ratio, S3 errors), users, devices and vaults (by encryption and sharing), stored blobs and bytes and their daily growth, documents and revisions, the upload, garbage collection, E2EE re-key and escrow re-wrap backlogs, the schema version, and when retention, the export and the service-wide metrics last succeeded. Needs the service-wide metrics. |
| vault-sync / Server | `vault-sync-server` | Per instance (`pod` variable): RPC rate, errors by code and p50, p95 and p99 latency by procedure, RPCs and users in flight and per-user concurrency rejections, realtime connections, refused upgrades, disconnects, notifications and the commit listener's status and reconnects, blob transfer, retention work, and Go runtime and process memory, CPU, goroutines and file descriptors. |
| vault-sync / Dependencies | `vault-sync-dependencies` | Per instance: PostgreSQL pool usage, acquire latency and query errors, the commit listener, S3 operation rates, outcomes and latency, and OIDC key set refresh failures and age. |

Every dashboard has these variables:

- `datasource`: any Prometheus data source.
- `namespace`: the namespace of the release.
- `job`: the Service name. This is the release name, for both endpoints of the ServiceMonitor.

So one copy of a dashboard serves any release name and several deployments. Service-wide panels take the `max` over replicas, so they are correct when you scrape one replica or all of them.

### Install the dashboards with grafana-operator

Set `config.grafana.dashboards.enabled` and an `instanceSelector` that matches the labels of your `Grafana` resource. The operator imports one `GrafanaDashboard` per dashboard:

```yaml
config:
  grafana:
    dashboards:
      enabled: true
      instanceSelector:
        matchLabels:
          dashboards: grafana
      folder: vault-sync
      # allowCrossNamespaceImport: true   # when Grafana runs in another namespace
```

### Install the dashboards with the Grafana chart's sidecar

If you do not use the operator, set `config.grafana.dashboards.configMaps.enabled`. The chart renders one ConfigMap per dashboard with the label that the sidecar watches (`grafana_dashboard: "1"`, its default). If your sidecar searches only its own namespace, set its `sidecar.dashboards.searchNamespace` to `ALL` or to the release namespace:

```yaml
config:
  grafana:
    dashboards:
      configMaps:
        enabled: true
        # label: grafana_dashboard
        # labelValue: "1"
```

[Grafana dashboards](../deployment.md#grafana-dashboards) lists every value of `config.grafana.dashboards`.

### Import the dashboards by hand

The dashboards come from the chart's own files. To import them by hand, upload the JSON files and select the Prometheus data source in the `datasource` variable.
