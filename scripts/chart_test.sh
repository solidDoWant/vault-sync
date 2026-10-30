#!/usr/bin/env bash
# Lints the Helm chart and checks its rendered manifests (make chart-lint).
#
# Every case renders deploy/charts/vault-sync with `helm template` (no
# cluster needed) and asserts on the resulting objects with jq (via yq), so the checks
# hold for whatever the bjw-s common library makes of the chart's values:
#
#   - the server Deployment, export CronJob, the one Service (ports http,
#     metrics and service-metrics), and on request the ServiceMonitor (with
#     its service-wide endpoint when toggled), HTTPRoute and ingress are
#     rendered, named after the release, with the Secret references for the
#     database client certificate and CA, the S3 credentials and CA, and the
#     escrow key;
#   - by default the chart sets no policy (no PodDisruptionBudget, container
#     resources or spread constraint) and renders no ServiceMonitor or
#     export CronJob, and caller overrides render exactly as given;
#   - values.schema.json rejects unknown keys, wrong types and bad durations;
#   - the escrow Secret is mounted into the export job and named nowhere
#     else, and every override that would put it into the server fails;
#   - replicas, the optional OIDC client id, the export overrides and the
#     security context render as configured, and the
#     server mounts nothing but Secrets (no per-replica state);
#   - missing required values fail with a message naming them;
#   - nothing Grafana is rendered by default; with the operator option one
#     GrafanaDashboard per dashboard file with the given instanceSelector,
#     with ConfigMaps the sidecar label, and the dashboards themselves pass
#     scripts/dashboard_test.py (parse, unique UIDs, documented metrics only);
#   - the PrometheusRule (config.alerts) renders only on request, with its
#     matchers, per-alert overrides and runbook links; promtool accepts it and
#     its unit tests (ci/alerts-test.yaml) pass; every metric it reads is in
#     docs/admin/metrics-reference.md and every alert has a docs/admin/alerts.md section
#     (and a heading in the docs/alerts.md stub);
#   - every VAULT_SYNC_* variable in docs/configuration.md can be set through
#     the chart, and every config value is documented in docs/deployment.md.
#
# Needs helm, yq, jq and promtool (all in the dev shell) and, on the first run, network
# access to fetch the pinned bjw-s common chart (Chart.lock).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chart="$repo_root/deploy/charts/vault-sync"
base_values="$chart/ci/test-values.yaml"
release="vault-sync"
escrow_secret="vault-sync-escrow-key"

for tool in helm yq jq; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "chart_test: $tool is required (run inside the dev shell: nix develop -c make chart-lint)" >&2
		exit 1
	fi
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
pass() { echo "ok   - $1"; }
fail() {
	echo "FAIL - $1" >&2
	failures=$((failures + 1))
}

# render ARGS...: renders the chart with the placeholder values plus ARGS
# into $work/out.json, one JSON object per manifest (stderr in $work/err).
render() {
	helm template "$release" "$chart" -f "$base_values" "$@" >"$work/out.yaml" 2>"$work/err" &&
		yq eval-all --output-format=json --indent=0 'select(. != null)' "$work/out.yaml" >"$work/out.json"
}

# query EXPRESSION: evaluates a jq expression with every rendered manifest
# in the array $docs.
query() {
	jq --slurp ". as \$docs | $1" "$work/out.json"
}

# check LABEL EXPRESSION: passes LABEL if the jq expression is true.
check() {
	local result
	result="$(query "$2" 2>&1)" || true
	if [[ $result == "true" ]]; then
		pass "$1"
	else
		fail "$1 (got: $result)"
	fi
}

# rejects LABEL MESSAGE ARGS...: passes LABEL if rendering with ARGS fails
# with an error containing MESSAGE.
rejects() {
	local label="$1" message="$2"
	shift 2
	if render "$@"; then
		fail "$label (rendered without error)"
	elif grep -qF -- "$message" "$work/err"; then
		pass "$label"
	else
		fail "$label (error does not mention '$message': $(cat "$work/err"))"
	fi
}

deployment='($docs[] | select(.kind == "Deployment"))'
cronjob='($docs[] | select(.kind == "CronJob"))'
server='('"$deployment"' | .spec.template.spec)'
export_pod='('"$cronjob"' | .spec.jobTemplate.spec.template.spec)'
service_monitors='[$docs[] | select(.kind == "ServiceMonitor")]'
pdbs='[$docs[] | select(.kind == "PodDisruptionBudget")]'
routes='[$docs[] | select(.kind == "HTTPRoute")]'
prometheus_rules='[$docs[] | select(.kind == "PrometheusRule")]'
# Every alerting rule of the PrometheusRule.
alert_rules='[$docs[] | select(.kind == "PrometheusRule") | .spec.groups[].rules[]]'

# env_value POD NAME: the value of env var NAME in POD's first container.
env_value() { echo "($1 | .containers[0].env[] | select(.name == \"$2\") | .value)"; }
# mounted_secret POD PATH: the Secret mounted at PATH in POD's first container.
mounted_secret() {
	echo "($1 as \$pod | \$pod.containers[0].volumeMounts[] | select(.mountPath == \"$2\") | .name as \$volume | \$pod.volumes[] | select(.name == \$volume) | .secret.secretName)"
}

"$repo_root/scripts/chart-dependencies.sh" "$chart"

# --- lint -------------------------------------------------------------------

if helm lint --strict "$chart" -f "$base_values" >"$work/lint" 2>&1; then
	pass "helm lint --strict passes"
else
	fail "helm lint --strict passes: $(cat "$work/lint")"
fi

# --- rendered objects -------------------------------------------------------

if render; then
	pass "renders with the placeholder values"
else
	fail "renders with the placeholder values: $(cat "$work/err")"
fi

check "renders the server Deployment" "[$deployment] | length == 1 and .[0].metadata.name == \"vault-sync\""
check "renders the export CronJob running the export subcommand" \
	"[$cronjob] | length == 1 and (.[0].spec.jobTemplate.spec.template.spec.containers[0].args == [\"export\", \"-out\", \"/export/vaults\"])"
check "renders one Service with ports http (8080), metrics (9090) and service-metrics (9091)" \
	"[\$docs[] | select(.kind == \"Service\")] | length == 1 and (.[0].spec.ports | map({name, port, targetPort}) | sort_by(.port)) == [{\"name\": \"http\", \"port\": 8080, \"targetPort\": 8080}, {\"name\": \"metrics\", \"port\": 9090, \"targetPort\": 9090}, {\"name\": \"service-metrics\", \"port\": 9091, \"targetPort\": 9091}] and .[0].spec.selector[\"app.kubernetes.io/controller\"] == \"main\""
check "creates no Secrets" "[\$docs[] | select(.kind == \"Secret\")] | length == 0"

# --- defaults set no policy -------------------------------------------------

# The minimal install: only the database, S3 and OIDC settings.
cat >"$work/minimal.yaml" <<'MINIMAL'
config:
  database:
    url:
      secretKeyRef: {name: vault-sync-database, key: dsn}
  s3:
    bucket: vault-sync
    credentials: {secretName: vault-sync-bucket}
  oidc:
    issuerUrl: https://auth.example.com/application/o/vault-sync/
    audience: vault-sync
MINIMAL
if helm template vault-sync "$chart" -f "$work/minimal.yaml" >"$work/out.yaml" 2>"$work/err" &&
	yq eval-all --output-format=json --indent=0 'select(. != null)' "$work/out.yaml" >"$work/out.json"; then
	pass "renders a minimal install (database, S3 and OIDC only)"
else
	fail "renders a minimal install (database, S3 and OIDC only): $(cat "$work/err")"
fi
check "by default renders no export CronJob" "[$cronjob] | length == 0"
check "by default renders no ServiceMonitor" "$service_monitors | length == 0"
check "by default renders no PrometheusRule" "$prometheus_rules | length == 0"
check "by default renders no PodDisruptionBudget" "$pdbs | length == 0"
check "by default renders no HTTPRoute" "$routes | length == 0"
check "by default sets no container resources" "($server | .containers[0] | has(\"resources\") | not) or ($server | .containers[0].resources) == {}"
check "by default sets no topology spread constraints" "($server | has(\"topologySpreadConstraints\") | not) or ($server | .topologySpreadConstraints) == []"

# --- names -------------------------------------------------------------------

# Every resource is named after the release, never with the chart name
# twice, and the server's resources carry no suffix.
for release in vs vault-sync obsidian-vault-sync; do
	render --set config.server.metrics.serviceMonitor.enabled=true --set config.route.enabled=true \
		--set resources.controllers.main.podDisruptionBudget.maxUnavailable=1 --set config.alerts.prometheusRule.enabled=true
	check "release $release: names every resource after the release" \
		"([\$docs[] | select(.kind != \"CronJob\") | .kind + \"/\" + .metadata.name] | sort) == ([\"Deployment\", \"HTTPRoute\", \"PodDisruptionBudget\", \"PrometheusRule\", \"Service\", \"ServiceAccount\", \"ServiceMonitor\"] | map(. + \"/$release\")) and ([$cronjob | .metadata.name] == [\"$release-export\"])"
	check "release $release: the Pods' ServiceAccount is the release's" "($server | .serviceAccountName) == \"$release\""
done
release="vault-sync"

# Secret references: each *_FILE variable points into a mount of the
# referenced Secret.
check "server reads the database client certificate from its Secret" \
	"$(env_value "$server" VAULT_SYNC_DATABASE_TLS_CERT_FILE) == \"/etc/vault-sync/database-client-cert/tls.crt\" and $(env_value "$server" VAULT_SYNC_DATABASE_TLS_KEY_FILE) == \"/etc/vault-sync/database-client-cert/tls.key\" and $(mounted_secret "$server" /etc/vault-sync/database-client-cert) == \"vault-sync-database-client\""
check "server reads the database CA from its Secret" \
	"$(env_value "$server" VAULT_SYNC_DATABASE_TLS_CA_FILE) == \"/etc/vault-sync/database-ca/ca.crt\" and $(mounted_secret "$server" /etc/vault-sync/database-ca) == \"postgres-ca\""
check "server reads the database URL from its Secret" \
	"($server | .containers[0].env[] | select(.name == \"VAULT_SYNC_DATABASE_URL\") | .valueFrom.secretKeyRef) == {\"key\": \"dsn\", \"name\": \"vault-sync-database\"}"
check "server reads the S3 credentials from their Secret" \
	"$(env_value "$server" VAULT_SYNC_S3_ACCESS_KEY_ID_FILE) == \"/etc/vault-sync/s3-credentials/AWS_ACCESS_KEY_ID\" and $(env_value "$server" VAULT_SYNC_S3_SECRET_ACCESS_KEY_FILE) == \"/etc/vault-sync/s3-credentials/AWS_SECRET_ACCESS_KEY\" and $(mounted_secret "$server" /etc/vault-sync/s3-credentials) == \"vault-sync-bucket\""
check "server reads the S3 CA from its Secret" \
	"$(env_value "$server" VAULT_SYNC_S3_TLS_CA_FILE) == \"/etc/vault-sync/s3-ca/ca.crt\" and $(mounted_secret "$server" /etc/vault-sync/s3-ca) == \"rgw-ca\""
check "Secret mounts project only the keys the server reads (a CA Secret's private key stays out)" \
	"[$server | .volumes[] | {(.name): [.secret.items[].key]}] | add == {\"database-ca\": [\"ca.crt\"], \"database-client-cert\": [\"tls.crt\", \"tls.key\"], \"escrow-job-token\": [\"token\"], \"s3-ca\": [\"ca.crt\"], \"s3-credentials\": [\"AWS_ACCESS_KEY_ID\", \"AWS_SECRET_ACCESS_KEY\"]}"
check "server sets the OIDC issuer and audience" \
	"$(env_value "$server" VAULT_SYNC_OIDC_ISSUER_URL) == \"https://auth.example.com/application/o/vault-sync/\" and $(env_value "$server" VAULT_SYNC_OIDC_AUDIENCE) == \"vault-sync\""
check "server listens where its ports and probes point" \
	"$(env_value "$server" VAULT_SYNC_LISTEN_ADDRESS) == \":8080\" and $(env_value "$server" VAULT_SYNC_METRICS_LISTEN_ADDRESS) == \":9090\" and $(env_value "$server" VAULT_SYNC_SERVICE_METRICS_LISTEN_ADDRESS) == \":9091\" and ($server | .containers[0].ports | map({name, containerPort}) | sort_by(.containerPort)) == [{\"name\": \"http\", \"containerPort\": 8080}, {\"name\": \"metrics\", \"containerPort\": 9090}, {\"name\": \"service-metrics\", \"containerPort\": 9091}] and ($server | .containers[0].readinessProbe.httpGet) == {\"path\": \"/readyz\", \"port\": \"metrics\"} and ($server | .containers[0].livenessProbe.httpGet) == {\"path\": \"/healthz\", \"port\": \"metrics\"}"
check "export reads the database and S3 credentials from their Secrets" \
	"$(env_value "$export_pod" VAULT_SYNC_DATABASE_TLS_CERT_FILE) == \"/etc/vault-sync/export-database-client-cert/tls.crt\" and $(mounted_secret "$export_pod" /etc/vault-sync/export-database-client-cert) == \"vault-sync-database-client\" and $(mounted_secret "$export_pod" /etc/vault-sync/export-s3-credentials) == \"vault-sync-bucket\" and $(mounted_secret "$export_pod" /etc/vault-sync/database-ca) == \"postgres-ca\" and $(env_value "$export_pod" VAULT_SYNC_S3_BUCKET) == \"vault-sync\""
check "export writes to its volume" \
	"($export_pod as \$pod | \$pod.containers[0].volumeMounts[] | select(.mountPath == \"/export\") | .name as \$volume | \$pod.volumes[] | select(.name == \$volume) | .persistentVolumeClaim.claimName) == \"vault-sync-export\""

# --- escrow (SPEC.md §9.4) --------------------------------------------------

check "export job mounts the escrow Secret read-only" \
	"$(mounted_secret "$export_pod" /etc/vault-sync/escrow) == \"$escrow_secret\" and ($export_pod | .containers[0].volumeMounts[] | select(.mountPath == \"/etc/vault-sync/escrow\") | .readOnly) == true"
check "export job reads the escrow identity from the mounted Secret" \
	"$(env_value "$export_pod" VAULT_SYNC_ESCROW_IDENTITY_FILE) == \"/etc/vault-sync/escrow/escrow.key\" and ([$server | .containers[0].env[] | select(.name == \"VAULT_SYNC_ESCROW_IDENTITY_FILE\")] | length) == 0"
check "the server Deployment never names the escrow Secret" \
	"[$deployment | .. | strings | select(contains(\"$escrow_secret\"))] | length == 0"
check "nothing but the export CronJob names the escrow Secret" \
	"[\$docs[] | select(.kind != \"CronJob\") | .. | strings | select(contains(\"$escrow_secret\"))] | length == 0"
check "no pod receives an escrow signing key file" \
	"[\$docs[] | .. | strings | select(contains(\"VAULT_SYNC_ESCROW_SIGNING_KEY_FILE\"))] | length == 0"
check "the export job mounts only the escrow identity from the escrow Secret" \
	"[$export_pod | .volumes[] | select(.secret.secretName == \"$escrow_secret\") | .secret.items[].key] == [\"escrow.key\"]"
rejects "rejects the removed signingKeysKey value" "signingKeysKey" \
	--set config.export.escrow.signingKeysKey=signing.keys
rejects "rejects an escrow signing key file on the export job" "escrow signing key" \
	--set resources.controllers.export.containers.main.env.VAULT_SYNC_ESCROW_SIGNING_KEY_FILE=/etc/vault-sync/escrow/signing.keys
rejects "rejects an escrow signing key file on the server" "escrow signing key" \
	--set resources.controllers.main.containers.main.env.VAULT_SYNC_ESCROW_SIGNING_KEY_FILE=/leak/signing.keys
rejects "rejects an escrow signing key file in the default pod options" "escrow signing key" \
	--set resources.defaultPodOptions.annotations.leak=VAULT_SYNC_ESCROW_SIGNING_KEY_FILE
rejects "rejects running the escrow key rotation in a controller" "escrow signing key" \
	--set resources.controllers.export.containers.main.args[0]=export --set resources.controllers.export.containers.main.args[1]=rotate-escrow

check "the server and the export job read the escrow job token from the mounted Secret" \
	"$(env_value "$server" VAULT_SYNC_ESCROW_JOB_TOKEN_FILE) == \"/etc/vault-sync/escrow-job-token/token\" and $(env_value "$export_pod" VAULT_SYNC_ESCROW_JOB_TOKEN_FILE) == \"/etc/vault-sync/escrow-job-token/token\" and $(mounted_secret "$server" /etc/vault-sync/escrow-job-token) == \"vault-sync-escrow-job-token\" and $(mounted_secret "$export_pod" /etc/vault-sync/escrow-job-token) == \"vault-sync-escrow-job-token\""
check "nothing but the server and the export job names the escrow job token Secret" \
	"[\$docs[] | select(.kind != \"CronJob\" and .kind != \"Deployment\") | .. | strings | select(contains(\"vault-sync-escrow-job-token\"))] | length == 0"

rejects "rejects mounting the escrow Secret into every controller (globalMounts)" "escrow Secret" \
	--set resources.persistence.leak.type=secret --set resources.persistence.leak.name="$escrow_secret" \
	--set resources.persistence.leak.globalMounts[0].path=/leak
rejects "rejects mounting the escrow Secret with the default mounts" "escrow Secret" \
	--set resources.persistence.leak.type=secret --set resources.persistence.leak.name="$escrow_secret"
rejects "rejects mounting the escrow Secret into the server (advancedMounts)" "escrow Secret" \
	--set resources.persistence.leak.type=secret --set resources.persistence.leak.name="$escrow_secret" \
	--set resources.persistence.leak.advancedMounts.main.main[0].path=/leak
rejects "rejects mounting the escrow Secret into the server through a custom volume" "escrow Secret" \
	--set resources.persistence.leak.type=custom --set resources.persistence.leak.volumeSpec.secret.secretName="$escrow_secret" \
	--set resources.persistence.leak.advancedMounts.main.main[0].path=/leak
rejects "rejects passing the escrow Secret to the server as an env var" "escrow Secret" \
	--set resources.controllers.main.containers.main.env.LEAK.valueFrom.secretKeyRef.name="$escrow_secret" \
	--set resources.controllers.main.containers.main.env.LEAK.valueFrom.secretKeyRef.key=key
rejects "rejects passing the escrow Secret to the server through envFrom" "escrow Secret" \
	--set resources.controllers.main.containers.main.envFrom[0].secretRef.name="$escrow_secret"
rejects "rejects naming the escrow Secret in the default pod options" "escrow Secret" \
	--set resources.defaultPodOptions.imagePullSecrets[0].name="$escrow_secret"
if render --set resources.persistence.extra.type=secret --set resources.persistence.extra.name="$escrow_secret" \
	--set resources.persistence.extra.advancedMounts.export.main[0].path=/extra; then
	pass "allows an extra escrow mount into the export job only"
else
	fail "allows an extra escrow mount into the export job only: $(cat "$work/err")"
fi

# --- HA, security and bounds ------------------------------------------------

render
check "runs 2 replicas by default, rolling one at a time without losing capacity" \
	"($deployment | .spec.replicas) == 2 and ($deployment | .spec.strategy.rollingUpdate) == {\"maxUnavailable\": 0, \"maxSurge\": 1}"
check "the server mounts only Secrets (no per-replica state)" \
	"[$server | .volumes[] | select(has(\"secret\") | not)] | length == 0"
for pod in server export_pod; do
	check "$pod runs as non-root with a read-only root filesystem and no capabilities" \
		"(${!pod} | .securityContext.runAsNonRoot) == true and (${!pod} | .containers[0].securityContext | .runAsNonRoot == true and .readOnlyRootFilesystem == true and .allowPrivilegeEscalation == false and .capabilities.drop == [\"ALL\"])"
	check "$pod sets no container resources" \
		"(${!pod} | .containers[0] | has(\"resources\") | not) or (${!pod} | .containers[0].resources) == {}"
	check "$pod does not mount a service account token" \
		"(${!pod} | .automountServiceAccountToken) == false"
	check "$pod uses the RuntimeDefault seccomp profile" \
		"(${!pod} | .securityContext.seccompProfile.type) == \"RuntimeDefault\" and (${!pod} | .containers[0].securityContext.seccompProfile.type) == \"RuntimeDefault\""
done
check "termination grace covers the default shutdown delay and drain timeout (5s + 30s) with a margin" \
	"($server | .terminationGracePeriodSeconds) == 45"
check "the server declares no topology spread constraints (the cluster's defaults apply)" \
	"($server | has(\"topologySpreadConstraints\") | not) or ($server | .topologySpreadConstraints) == []"
check "the probes keep their periods and failure thresholds" \
	"($server | .containers[0] | [.startupProbe, .livenessProbe, .readinessProbe] | map({periodSeconds, failureThreshold})) == [{\"periodSeconds\": 5, \"failureThreshold\": 120}, {\"periodSeconds\": 10, \"failureThreshold\": 3}, {\"periodSeconds\": 2, \"failureThreshold\": 2}]"
check "an export run is bounded by a deadline (6 hours by default)" \
	"($cronjob | .spec.jobTemplate.spec.activeDeadlineSeconds) == 21600 and ($cronjob | .spec.concurrencyPolicy) == \"Forbid\""
render --set config.export.activeDeadlineSeconds=600
check "the export deadline is configurable" "($cronjob | .spec.jobTemplate.spec.activeDeadlineSeconds) == 600"
rejects "rejects an export deadline of 0" "/config/export/activeDeadlineSeconds" --set config.export.activeDeadlineSeconds=0
rejects "rejects an empty export deadline" "/config/export/activeDeadlineSeconds" --set config.export.activeDeadlineSeconds=

# The grace period follows the shutdown settings: 1m + 1m30.5s = 150.5s,
# rounded up to 151, plus the 10 second margin.
render --set config.server.shutdownDelay=1m --set config.server.shutdownTimeout=1m30.5s
check "termination grace follows a raised shutdown delay and drain timeout" \
	"($server | .terminationGracePeriodSeconds) == 161"
render --set config.server.shutdownDelay=0s --set config.server.shutdownTimeout=1s
check "termination grace stays at least 45 seconds" "($server | .terminationGracePeriodSeconds) == 45"
# An explicit grace period must exceed delay + timeout (5s + 1m = 65s).
rejects "rejects a grace period equal to the shutdown delay plus the drain timeout" "terminationGracePeriodSeconds (65) must be larger" \
	--set config.server.shutdownTimeout=1m --set resources.controllers.main.pod.terminationGracePeriodSeconds=65
if render --set config.server.shutdownTimeout=1m --set resources.controllers.main.pod.terminationGracePeriodSeconds=66; then
	check "accepts an explicit grace period one second above the shutdown delay plus the drain timeout" \
		"($server | .terminationGracePeriodSeconds) == 66"
else
	fail "accepts an explicit grace period one second above the shutdown delay plus the drain timeout: $(cat "$work/err")"
fi
rejects "rejects a shutdown delay that is not a Go duration" "/config/server/shutdownDelay" \
	--set config.server.shutdownDelay=soon
render

render --set resources.controllers.main.replicas=3
check "replicas are configurable, without a PodDisruptionBudget" "($deployment | .spec.replicas) == 3 and ($pdbs | length) == 0"

# --- caller policy renders exactly as given ---------------------------------

render --set resources.controllers.main.podDisruptionBudget.minAvailable=1
check "a caller's PodDisruptionBudget renders exactly as given (minAvailable only)" \
	"$pdbs | length == 1 and (.[0].spec | del(.selector)) == {\"minAvailable\": 1} and .[0].spec.selector.matchLabels[\"app.kubernetes.io/controller\"] == \"main\""
render --set resources.controllers.main.containers.main.resources.limits.memory=2Gi \
	--set resources.controllers.export.containers.main.resources.requests.cpu=50m
check "caller resources render exactly as given" \
	"($server | .containers[0].resources) == {\"limits\": {\"memory\": \"2Gi\"}} and ($export_pod | .containers[0].resources) == {\"requests\": {\"cpu\": \"50m\"}}"
render --set-json 'resources.controllers.main.pod.topologySpreadConstraints=[{"maxSkew":2,"topologyKey":"topology.kubernetes.io/zone","whenUnsatisfiable":"DoNotSchedule"}]'
check "a caller's spread constraint renders exactly as given" \
	"($server | .topologySpreadConstraints | map(del(.labelSelector))) == [{\"maxSkew\": 2, \"topologyKey\": \"topology.kubernetes.io/zone\", \"whenUnsatisfiable\": \"DoNotSchedule\"}]"

# --- ServiceMonitor, ingress and route --------------------------------------

render --set config.server.metrics.serviceMonitor.enabled=true
check "an enabled ServiceMonitor scrapes only /metrics on port metrics of the Service" \
	"$service_monitors | length == 1 and (.[0].spec.endpoints | length) == 1 and .[0].spec.endpoints[0].port == \"metrics\" and .[0].spec.endpoints[0].path == \"/metrics\" and .[0].spec.selector.matchLabels[\"app.kubernetes.io/service\"] == \"vault-sync\""

render --set config.server.metrics.serviceMonitor.enabled=true --set config.server.metrics.serviceWide.enabled=true \
	--set config.server.metrics.serviceMonitor.interval=2m --set config.server.metrics.serviceMonitor.scrapeTimeout=20s
check "serviceWide.enabled adds a second endpoint scraping /metrics on port service-metrics" \
	"$service_monitors | length == 1 and (.[0].spec.endpoints | map({port, path, interval, scrapeTimeout}) | sort_by(.port)) == [{\"port\": \"metrics\", \"path\": \"/metrics\", \"interval\": \"2m\", \"scrapeTimeout\": \"20s\"}, {\"port\": \"service-metrics\", \"path\": \"/metrics\", \"interval\": \"2m\", \"scrapeTimeout\": \"20s\"}]"
rejects "serviceWide.enabled without a ServiceMonitor fails" "config.server.metrics.serviceWide.enabled needs config.server.metrics.serviceMonitor.enabled" \
	--set config.server.metrics.serviceWide.enabled=true

if render --set resources.ingress.main.hosts[0].host=sync.example.com --set resources.ingress.main.hosts[0].paths[0].path=/; then
	check "a plain ingress routes to port http without naming a Service" \
		"[\$docs[] | select(.kind == \"Ingress\") | .spec.rules[0].http.paths[0].backend.service] == [{\"name\": \"vault-sync\", \"port\": {\"number\": 8080}}]"
else
	fail "a plain ingress routes to port http without naming a Service: $(cat "$work/err")"
fi

render --set config.route.enabled=true --set config.route.hostnames[0]=sync.example.com \
	--set config.route.parentRefs[0].name=gateway --set config.route.parentRefs[0].namespace=gateway-system \
	--set config.route.annotations.team=sync --set config.route.labels.tier=api
check "the route attaches to the given Gateway for the given hostnames" \
	"$routes | length == 1 and .[0].spec.hostnames == [\"sync.example.com\"] and (.[0].spec.parentRefs | map({name, namespace})) == [{\"name\": \"gateway\", \"namespace\": \"gateway-system\"}] and .[0].metadata.annotations.team == \"sync\" and .[0].metadata.labels.tier == \"api\""
check "every route rule sends traffic to port http of the Service" \
	"[$routes[0].spec.rules[].backendRefs[] | {name, port}] | unique == [{\"name\": \"vault-sync\", \"port\": 8080}]"
check "the route never times out the realtime WebSocket and gives other requests 15 minutes" \
	"($routes[0].spec.rules | map({path: .matches[0].path.value, timeouts})) == [{\"path\": \"/v1/realtime\", \"timeouts\": {\"request\": \"0s\", \"backendRequest\": \"0s\"}}, {\"path\": \"/\", \"timeouts\": {\"request\": \"15m\", \"backendRequest\": \"15m\"}}]"
render --set config.route.enabled=true --set config.route.parentRefs[0].name=gateway \
	--set-json 'resources.route.main.rules=[{"backendRefs":[{"identifier":"main","port":"http"}],"timeouts":{"request":"1h"}}]'
check "resources.route overrides the computed route" \
	"($routes[0].spec.rules | length) == 1 and $routes[0].spec.rules[0].timeouts == {\"request\": \"1h\"}"

# --- schema -----------------------------------------------------------------

rejects "the schema rejects an unknown config key" "additional properties 'forcepathstyle' not allowed" --set config.s3.forcepathstyle=true
rejects "the schema rejects a wrong type" "/config/server/blob/maxSizeBytes" --set config.server.blob.maxSizeBytes=big
rejects "the schema rejects a string boolean" "/config/s3/forcePathStyle" --set-string config.s3.forcePathStyle=true
rejects "the schema rejects a bad duration" "does not match pattern" --set config.server.writeTimeout=soon
rejects "the schema rejects a string serviceWide.enabled" "/config/server/metrics/serviceWide/enabled" --set-string config.server.metrics.serviceWide.enabled=true
rejects "the schema rejects an unknown log level" "/config/logLevel" --set config.logLevel=verbose
if render --set config.server.writeTimeout=1h30m --set config.server.blob.maxSizeBytes=1073741824 --set config.s3.forcePathStyle=false; then
	pass "the schema accepts typed values"
else
	fail "the schema accepts typed values: $(cat "$work/err")"
fi

render --set resources.controllers.main.containers.main.image.tag=1.2.3
check "the image tag is configurable" "($server | .containers[0].image) == \"ghcr.io/soliddowant/vault-sync:1.2.3\""
render
check "the image tag defaults to the chart's appVersion" \
	"($server | .containers[0].image) == \"ghcr.io/soliddowant/vault-sync:$(yq .appVersion "$chart/Chart.yaml")\" and ($export_pod | .containers[0].image) == ($server | .containers[0].image)"

# --- optional values --------------------------------------------------------

render
check "VAULT_SYNC_OIDC_CLIENT_ID is unset by default" \
	"[$server | .containers[0].env[] | select(.name == \"VAULT_SYNC_OIDC_CLIENT_ID\")] | length == 0"
render --set config.oidc.clientId=obsidian-plugin
check "VAULT_SYNC_OIDC_CLIENT_ID is set from config.oidc.clientId" \
	"$(env_value "$server" VAULT_SYNC_OIDC_CLIENT_ID) == \"obsidian-plugin\""

render --set config.server.blob.maxUploadsPerVault=0 --set config.s3.forcePathStyle=false
check "numeric 0 and boolean false reach the server for it to validate" \
	"$(env_value "$server" VAULT_SYNC_BLOB_MAX_UPLOADS_PER_VAULT) == \"0\" and $(env_value "$server" VAULT_SYNC_S3_FORCE_PATH_STYLE) == \"false\""

render --set config.export.database.url.secretKeyRef.name=export-db --set config.export.database.url.secretKeyRef.key=dsn \
	--set config.export.database.tls.clientCertificate.secretName=export-db-client \
	--set config.export.s3.credentials.secretName=export-bucket
check "export uses its own database and S3 credentials when given" \
	"($export_pod | .containers[0].env[] | select(.name == \"VAULT_SYNC_DATABASE_URL\") | .valueFrom.secretKeyRef.name) == \"export-db\" and $(mounted_secret "$export_pod" /etc/vault-sync/export-database-client-cert) == \"export-db-client\" and $(mounted_secret "$export_pod" /etc/vault-sync/export-s3-credentials) == \"export-bucket\""
check "the export's own credentials never reach the server" \
	"[$deployment | .. | strings | select(. == \"export-db\" or . == \"export-db-client\" or . == \"export-bucket\")] | length == 0"

if render --set config.export.enabled=false --set-json 'config.export.output.persistence={}'; then
	check "a disabled export renders no CronJob and mounts no escrow key" \
		"([$cronjob] | length) == 0 and ([\$docs[] | .. | strings | select(contains(\"$escrow_secret\"))] | length) == 0"
else
	fail "a disabled export renders without an export volume: $(cat "$work/err")"
fi

# --- Grafana dashboards -----------------------------------------------------

if python3 -I "$repo_root/scripts/dashboard_test.py"; then
	pass "the dashboards pass scripts/dashboard_test.py"
else
	fail "the dashboards pass scripts/dashboard_test.py"
fi

dashboard_files="$(find "$chart/dashboards" -name '*.json' | wc -l | tr -d ' ')"
dashboard_uids="$(jq -s -c '[.[].uid] | sort' "$chart"/dashboards/*.json)"
grafana_dashboards='[$docs[] | select(.kind == "GrafanaDashboard")]'
dashboard_config_maps='[$docs[] | select(.kind == "ConfigMap" and (.metadata.name | contains("-dashboard-")))]'

if render; then
	check "renders no GrafanaDashboard or dashboard ConfigMap by default" \
		"($grafana_dashboards | length) == 0 and ($dashboard_config_maps | length) == 0"
else
	fail "renders with the placeholder values: $(cat "$work/err")"
fi

if render --set config.grafana.dashboards.enabled=true --set-json 'config.grafana.dashboards.instanceSelector={"matchLabels":{"dashboards":"grafana"}}' \
	--set config.grafana.dashboards.folder=vault-sync --set config.grafana.dashboards.resyncPeriod=10m \
	--set config.grafana.dashboards.allowCrossNamespaceImport=true; then
	check "renders one GrafanaDashboard per dashboard file" \
		"($grafana_dashboards | length) == $dashboard_files and ($dashboard_config_maps | length) == 0"
	check "each GrafanaDashboard has the given instanceSelector, folder, resyncPeriod and allowCrossNamespaceImport" \
		"$grafana_dashboards | all(.apiVersion == \"grafana.integreatly.org/v1beta1\" and .spec.instanceSelector == {\"matchLabels\": {\"dashboards\": \"grafana\"}} and .spec.folder == \"vault-sync\" and .spec.resyncPeriod == \"10m\" and .spec.allowCrossNamespaceImport == true)"
	check "the GrafanaDashboards embed the dashboard JSON with its UID" \
		"[$grafana_dashboards[] | .spec.json | fromjson | .uid] | sort == $dashboard_uids"
	check "the GrafanaDashboards are named after the release" \
		"$grafana_dashboards | all(.metadata.name | startswith(\"$release-dashboard-\"))"
else
	fail "renders the GrafanaDashboards: $(cat "$work/err")"
fi

rejects "requires an instanceSelector for the GrafanaDashboards" "config.grafana.dashboards.instanceSelector is required" \
	--set config.grafana.dashboards.enabled=true
rejects "rejects more than one dashboard folder setting" "mutually exclusive" --set config.grafana.dashboards.enabled=true \
	--set-json 'config.grafana.dashboards.instanceSelector={"matchLabels":{"dashboards":"grafana"}}' \
	--set config.grafana.dashboards.folder=a --set config.grafana.dashboards.folderUID=b

if render --set config.grafana.dashboards.configMaps.enabled=true; then
	check "renders one sidecar ConfigMap per dashboard file, labelled grafana_dashboard: \"1\"" \
		"($dashboard_config_maps | length) == $dashboard_files and ($grafana_dashboards | length) == 0 and ($dashboard_config_maps | all(.metadata.labels.grafana_dashboard == \"1\"))"
	check "the sidecar ConfigMaps hold the dashboard JSON with its UID" \
		"[$dashboard_config_maps[] | .data | to_entries[0].value | fromjson | .uid] | sort == $dashboard_uids"
else
	fail "renders the dashboard ConfigMaps: $(cat "$work/err")"
fi

if render --set config.grafana.dashboards.configMaps.enabled=true --set config.grafana.dashboards.configMaps.label=dashboards \
	--set config.grafana.dashboards.configMaps.labelValue=vault-sync; then
	check "the sidecar label is configurable" \
		"($dashboard_config_maps | length) == $dashboard_files and ($dashboard_config_maps | all(.metadata.labels.dashboards == \"vault-sync\" and (.metadata.labels | has(\"grafana_dashboard\") | not)))"
else
	fail "renders the dashboard ConfigMaps with a custom label: $(cat "$work/err")"
fi

# --- required values --------------------------------------------------------

rejects "requires the database URL" "config.database.url is required" --set-json 'config.database.url={"value":"","secretKeyRef":{"name":"","key":""}}'
rejects "rejects both a database URL value and a Secret" "mutually exclusive" --set config.database.url.value=postgres://db
rejects "rejects a half-set database URL Secret reference" "must be set together" --set config.database.url.secretKeyRef.key=
rejects "requires the S3 bucket" "config.s3.bucket is required" --set config.s3.bucket=
rejects "requires the S3 credentials Secret" "config.s3.credentials.secretName is required" --set config.s3.credentials.secretName=
rejects "requires the OIDC issuer" "config.oidc.issuerUrl is required" --set config.oidc.issuerUrl=
rejects "requires the OIDC audience" "config.oidc.audience is required" --set config.oidc.audience=
rejects "requires the export volume" "config.export.output.persistence is required" --set-json 'config.export.output.persistence={}'
rejects "rejects an export directory with a slash" "config.export.output.directory" --set config.export.output.directory=a/b
rejects "rejects a database URL value together with a Secret" "mutually exclusive" --set config.export.database.url.value=postgres://db \
	--set config.export.database.url.secretKeyRef.name=export-db --set config.export.database.url.secretKeyRef.key=dsn

# --- documentation ----------------------------------------------------------

# --- alerting rules (PrometheusRule) ----------------------------------------

rules_file="$chart/alerts/vault-sync.rules.yaml"
all_alerts="$(yq '.groups[].rules[].alert' "$rules_file")"
# alert NAME: the rendered rule of alert NAME.
alert() { echo "($alert_rules[] | select(.alert == \"$1\"))"; }

render --set config.alerts.prometheusRule.enabled=true --set-string config.alerts.prometheusRule.labels.release=prometheus \
	--set-string config.alerts.prometheusRule.annotations.team=sync --namespace sync
check "an enabled PrometheusRule is named after the release, in its namespace, with the extra labels and annotations" \
	"$prometheus_rules | length == 1 and .[0].apiVersion == \"monitoring.coreos.com/v1\" and .[0].metadata.name == \"$release\" and .[0].metadata.namespace == \"sync\" and .[0].metadata.labels.release == \"prometheus\" and .[0].metadata.annotations.team == \"sync\""
check "every alert has a severity of critical or warning" "$alert_rules | length > 0 and all(.labels.severity == \"critical\" or .labels.severity == \"warning\")"
check "every alert's runbook_url is the docs/admin/alerts.md anchor of its name" \
	"$alert_rules | all(.annotations.runbook_url == \"https://github.com/solidDoWant/vault-sync/blob/master/docs/admin/alerts.md#\" + (.alert | ascii_downcase))"
check "every vault_sync expression matches the release's namespace and job" \
	"$alert_rules | map(select(.expr | test(\"vault_sync_\"))) | length > 0 and all(.expr | [scan(\"vault_sync_[a-z0-9_]+[{][^}]*[}]\")] | length > 0 and all(test(\"namespace=\\\"sync\\\", job=\\\"$release\\\"\")))"
check "kube-state-metrics alerts are off by default" \
	"[$alert_rules[] | .alert] - [\"VaultSyncNoReplicaReady\", \"VaultSyncReplicasUnavailable\"] == [$alert_rules[] | .alert]"
check "the export alert is on while the export is enabled" "[$(alert VaultSyncExportNotSucceeding)] | length == 1"
expected="$(echo "$all_alerts" | grep -vxE 'VaultSyncNoReplicaReady|VaultSyncReplicasUnavailable' | jq -R . | jq -sc 'sort')"
check "renders every other packaged alert" "[$alert_rules[] | .alert] | sort == $expected"

render --set config.alerts.prometheusRule.enabled=true --set config.export.enabled=false
check "the export alert is off while the export is disabled" "[$(alert VaultSyncExportNotSucceeding)] | length == 0"

render --set config.alerts.prometheusRule.enabled=true --set config.alerts.rules.VaultSyncNoReplicaReady.enabled=true \
	--set config.alerts.rules.VaultSyncReplicasUnavailable.enabled=true --namespace sync
check "kube-state-metrics alerts render on request, matching the namespace and Deployment" \
	"[$(alert VaultSyncNoReplicaReady), $(alert VaultSyncReplicasUnavailable)] | length == 2 and all(.expr | [scan(\"kube_deployment_[a-z_]+[{][^}]*[}]\")] | length > 0 and all(test(\"deployment=\\\"$release\\\", namespace=\\\"sync\\\"\")))"

render --set config.alerts.prometheusRule.enabled=true --set config.alerts.rules.VaultSyncRPCErrorRatioHigh.enabled=false
check "a disabled alert is dropped from the rendered rules" "[$(alert VaultSyncRPCErrorRatioHigh)] | length == 0 and ($alert_rules | length > 0)"

render --set config.alerts.prometheusRule.enabled=true --set-json config.alerts.rules.VaultSyncSyncLatencyHigh.threshold=7.5 \
	--set config.alerts.rules.VaultSyncSyncLatencyHigh.for=45m --set config.alerts.rules.VaultSyncSyncLatencyHigh.severity=critical
check "an alert's threshold, for and severity can be overridden" \
	"$(alert VaultSyncSyncLatencyHigh) | (.expr | endswith(\"> 7.5\")) and .for == \"45m\" and .labels.severity == \"critical\""
check "overriding one alert leaves the others' defaults" \
	"$(alert VaultSyncRPCErrorRatioHigh) | (.expr | endswith(\"> 0.05\")) and .for == \"10m\" and .labels.severity == \"critical\""

render --set config.alerts.prometheusRule.enabled=true --set config.alerts.prometheusRule.selector.namespace= \
	--set config.alerts.prometheusRule.selector.job=custom --set config.alerts.runbookUrlBase=https://runbooks.example.com/vault-sync
check "an empty namespace selector leaves the matcher out, and a job selector replaces the default" \
	"$alert_rules | map(select(.expr | test(\"vault_sync_\"))) | all((.expr | test(\"namespace=\") | not) and (.expr | test(\"job=\\\"custom\\\"\")))"
check "runbookUrlBase sets the runbook_url base" "$alert_rules | all(.annotations.runbook_url == \"https://runbooks.example.com/vault-sync#\" + (.alert | ascii_downcase))"

rejects "an override naming an unknown alert fails" "config.alerts.rules.VaultSyncNoSuchAlert: no such alert" \
	--set config.alerts.prometheusRule.enabled=true --set config.alerts.rules.VaultSyncNoSuchAlert.enabled=false
rejects "values.schema.json rejects an unknown severity" "severity" \
	--set config.alerts.prometheusRule.enabled=true --set config.alerts.rules.VaultSyncSyncLatencyHigh.severity=page
rejects "values.schema.json rejects a bad for duration" "for" \
	--set config.alerts.prometheusRule.enabled=true --set config.alerts.rules.VaultSyncSyncLatencyHigh.for=soon

# Every metric an expression reads is in the generated
# docs/admin/metrics-reference.md (histogram series by their base name), and every alert has a
# runbook section in docs/admin/alerts.md. The old docs/alerts.md keeps a
# heading per alert, so runbook_url links of released charts still land on
# the alert.
documented_metrics="$(grep -oE '^\| `vault_sync_[a-z0-9_]+`' "$repo_root/docs/admin/metrics-reference.md" | tr -d '|` ' | sort -u)"
for metric in $(grep -oE 'vault_sync_[a-z0-9_]+' "$rules_file" | sed -E 's/_(bucket|sum|count)$//' | sort -u); do
	if grep -qxF -- "$metric" <<<"$documented_metrics"; then
		pass "docs/admin/metrics-reference.md documents $metric, which the alerts read"
	else
		fail "docs/admin/metrics-reference.md documents $metric, which the alerts read"
	fi
done
for name in $all_alerts; do
	for page in docs/admin/alerts.md docs/alerts.md; do
		if grep -qxF -- "### $name" "$repo_root/$page"; then
			pass "$page has a section for $name"
		else
			fail "$page has a section for $name"
		fi
	done
done

# promtool: the rendered rules are valid (with and without matchers), and
# each alert fires on its synthetic series and stays quiet on a healthy one
# (ci/alerts-test.yaml, against every alert with an empty selector).
if command -v promtool >/dev/null 2>&1; then
	mkdir -p "$work/promtool"
	if render --set config.alerts.prometheusRule.enabled=true --namespace sync &&
		yq 'select(.kind == "PrometheusRule") | .spec' "$work/out.yaml" >"$work/promtool/default.yaml" &&
		promtool check rules "$work/promtool/default.yaml" >"$work/promtool/check" 2>&1; then
		pass "promtool check rules accepts the rendered PrometheusRule"
	else
		fail "promtool check rules accepts the rendered PrometheusRule: $(cat "$work/err" "$work/promtool/check" 2>/dev/null)"
	fi
	enable_all=()
	for name in $all_alerts; do
		enable_all+=(--set "config.alerts.rules.$name.enabled=true")
	done
	if render --set config.alerts.prometheusRule.enabled=true --set config.alerts.prometheusRule.selector.namespace= \
		--set config.alerts.prometheusRule.selector.job= "${enable_all[@]}" &&
		yq 'select(.kind == "PrometheusRule") | .spec | del(.groups[].rules[].annotations)' "$work/out.yaml" >"$work/promtool/rules.yaml" &&
		cp "$chart/ci/alerts-test.yaml" "$work/promtool/alerts-test.yaml" &&
		promtool check rules "$work/promtool/rules.yaml" >"$work/promtool/check" 2>&1 &&
		promtool test rules "$work/promtool/alerts-test.yaml" >"$work/promtool/test" 2>&1; then
		pass "promtool test rules: every alert fires on its synthetic series and stays quiet on a healthy one"
	else
		fail "promtool test rules: $(cat "$work/err" "$work/promtool/check" "$work/promtool/test" 2>/dev/null)"
	fi
	for name in $all_alerts; do
		if grep -qF -- "name: $name fires" "$chart/ci/alerts-test.yaml" && grep -qF -- "name: $name stays quiet" "$chart/ci/alerts-test.yaml"; then
			pass "ci/alerts-test.yaml tests $name firing and quiet"
		else
			fail "ci/alerts-test.yaml tests $name firing and quiet"
		fi
	done
else
	fail "promtool is required for the alerting rule tests (run inside the dev shell)"
fi

# Every variable in the server's configuration table must be settable
# through the chart: render with every optional value set and look for it.
render --set config.logLevel=debug --set config.s3.region=r --set config.s3.forcePathStyle=true --set config.s3.idleTimeout=1m \
	--set config.oidc.clientId=c --set config.server.maxRequestBytes=1 --set config.server.writeTimeout=1s \
	--set config.server.maxConcurrentRpcsPerUser=1 --set config.server.shutdownDelay=1s --set config.server.shutdownTimeout=1s \
	--set config.server.blob.maxChunkBytes=1 --set config.server.blob.maxSizeBytes=1 --set config.server.blob.maxUploadsPerVault=1 \
	--set config.server.blob.uploadTtl=1h --set config.server.blob.uploadReclaimIdle=10m --set config.server.blob.gcGrace=1h --set config.server.retention.keepAll=1h \
	--set config.server.retention.keepDaily=1h --set config.server.retention.purgeMarkerHorizon=24h --set config.server.retention.overrideMinKeepAll=24h \
	--set config.server.retention.overrideMinKeepDaily=24h --set config.server.realtime.maxConnections=1 \
	--set config.server.realtime.maxConnectionsPerUser=1 --set config.server.realtime.maxSubscriptions=1 \
	--set config.server.escrow.recipient=age1pq1x --set config.server.escrow.signingKey=c2lnbg== --set config.server.escrow.default=false \
	--set config.server.escrow.retiringKeyIds=sha256:00 --set config.server.metrics.serviceWide.interval=1m
documented_vars="$(grep -oE '^\| `VAULT_SYNC_[A-Z0-9_]+`' "$repo_root/docs/configuration.md" | tr -d '|` ')"
if [[ -z $documented_vars ]]; then
	fail "found the environment variables in docs/configuration.md"
fi
# The escrow identity is the export job's only, so it is looked for
# there. The escrow signing keys stay offline: the chart never sets their
# file (checked above).
for var in $documented_vars; do
	pod="$server"
	if [[ $var == VAULT_SYNC_ESCROW_SIGNING_KEY_FILE ]]; then
		continue
	fi
	if [[ $var == VAULT_SYNC_ESCROW_IDENTITY_FILE ]]; then
		pod="$export_pod"
	fi
	check "the chart can set $var" "[$pod | .containers[0].env[] | select(.name == \"$var\")] | length == 1"
done

# Every config value must be documented in docs/deployment.md.
for path in $(yq --output-format=json '.' "$chart/values.yaml" | jq -r '.config | paths(type != "object" or length == 0) | "config." + (map(tostring) | join("."))'); do
	if grep -qF -- "\`$path\`" "$repo_root/docs/deployment.md"; then
		pass "docs/deployment.md documents $path"
	else
		fail "docs/deployment.md documents $path"
	fi
done

if [[ $failures -ne 0 ]]; then
	echo "chart_test: $failures check(s) failed" >&2
	exit 1
fi
echo "chart_test: all checks passed"
