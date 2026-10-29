#!/usr/bin/env bash
# Lints the Helm chart and checks its rendered manifests (make chart-lint).
#
# Every case renders deploy/charts/vault-sync with `helm template` (no
# cluster needed) and asserts on the resulting objects with jq (via yq), so the checks
# hold for whatever the bjw-s common library makes of the chart's values:
#
#   - the server Deployment, export CronJob, Services, PodDisruptionBudget
#     and ServiceMonitor are rendered, with the Secret references for the
#     database client certificate and CA, the S3 credentials and CA, and the
#     escrow key;
#   - the escrow Secret is mounted into the export job and named nowhere
#     else, and every override that would put it into the server fails;
#   - replicas, the optional OIDC client id, the export overrides, the
#     security context and resource bounds render as configured, and the
#     server mounts nothing but Secrets (no per-replica state);
#   - missing required values fail with a message naming them;
#   - every VAULT_SYNC_* variable in docs/configuration.md can be set through
#     the chart, and every config value is documented in docs/deployment.md.
#
# Needs helm, yq and jq (all in the dev shell) and, on the first run, network
# access to fetch the pinned bjw-s common chart (Chart.lock).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chart="$repo_root/deploy/charts/vault-sync"
base_values="$chart/ci/test-values.yaml"
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
	helm template vault-sync "$chart" -f "$base_values" "$@" >"$work/out.yaml" 2>"$work/err" &&
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

check "renders the server Deployment" "[$deployment] | length == 1 and .[0].metadata.name == \"vault-sync-main\""
check "renders the export CronJob running the export subcommand" \
	"[$cronjob] | length == 1 and (.[0].spec.jobTemplate.spec.template.spec.containers[0].args == [\"export\", \"-out\", \"/export/vaults\"])"
check "renders a ServiceMonitor scraping the metrics port of the metrics Service" \
	"[\$docs[] | select(.kind == \"ServiceMonitor\")] | length == 1 and .[0].spec.endpoints[0].port == \"metrics\" and .[0].spec.selector.matchLabels[\"app.kubernetes.io/service\"] == \"vault-sync-metrics\""
check "renders the API and metrics Services" \
	"[\$docs[] | select(.kind == \"Service\") | .metadata.name + \":\" + (.spec.ports[0].port | tostring)] | sort == [\"vault-sync-main:8080\", \"vault-sync-metrics:9090\"]"
check "renders a PodDisruptionBudget for the server" \
	"[\$docs[] | select(.kind == \"PodDisruptionBudget\")] | length == 1 and .[0].spec.maxUnavailable == 1 and .[0].spec.selector.matchLabels[\"app.kubernetes.io/controller\"] == \"main\""
check "creates no Secrets" "[\$docs[] | select(.kind == \"Secret\")] | length == 0"

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
	"$(env_value "$server" VAULT_SYNC_LISTEN_ADDRESS) == \":8080\" and $(env_value "$server" VAULT_SYNC_METRICS_LISTEN_ADDRESS) == \":9090\" and ($server | .containers[0].readinessProbe.httpGet) == {\"path\": \"/readyz\", \"port\": \"metrics\"} and ($server | .containers[0].livenessProbe.httpGet) == {\"path\": \"/healthz\", \"port\": \"metrics\"}"
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
	check "$pod has CPU and memory requests and limits" \
		"(${!pod} | .containers[0].resources | (.requests.cpu != null) and (.requests.memory != null) and (.limits.cpu != null) and (.limits.memory != null))"
	check "$pod does not mount a service account token" \
		"(${!pod} | .automountServiceAccountToken) == false"
	check "$pod uses the RuntimeDefault seccomp profile" \
		"(${!pod} | .securityContext.seccompProfile.type) == \"RuntimeDefault\" and (${!pod} | .containers[0].securityContext.seccompProfile.type) == \"RuntimeDefault\""
done
check "termination grace covers the default shutdown delay and drain timeout (5s + 30s) with a margin" \
	"($server | .terminationGracePeriodSeconds) == 45"
check "the server spreads its replicas across nodes" \
	"($server | .topologySpreadConstraints) == [{\"maxSkew\": 1, \"topologyKey\": \"kubernetes.io/hostname\", \"whenUnsatisfiable\": \"ScheduleAnyway\", \"labelSelector\": ($server | .topologySpreadConstraints[0].labelSelector)}] and ($server | .topologySpreadConstraints[0].labelSelector.matchLabels[\"app.kubernetes.io/controller\"]) == \"main\""
check "the probes keep their periods and failure thresholds" \
	"($server | .containers[0] | [.startupProbe, .livenessProbe, .readinessProbe] | map({periodSeconds, failureThreshold})) == [{\"periodSeconds\": 5, \"failureThreshold\": 120}, {\"periodSeconds\": 10, \"failureThreshold\": 3}, {\"periodSeconds\": 2, \"failureThreshold\": 2}]"
check "an export run is bounded by a deadline (6 hours by default)" \
	"($cronjob | .spec.jobTemplate.spec.activeDeadlineSeconds) == 21600 and ($cronjob | .spec.concurrencyPolicy) == \"Forbid\""
render --set config.export.activeDeadlineSeconds=600
check "the export deadline is configurable" "($cronjob | .spec.jobTemplate.spec.activeDeadlineSeconds) == 600"
rejects "rejects an export deadline of 0" "config.export.activeDeadlineSeconds" --set config.export.activeDeadlineSeconds=0
rejects "rejects an empty export deadline" "config.export.activeDeadlineSeconds" --set config.export.activeDeadlineSeconds=

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
rejects "rejects a shutdown delay that is not a Go duration" "config.server.shutdownDelay must be a Go duration" \
	--set config.server.shutdownDelay=soon
render

render --set resources.controllers.main.replicas=3
check "replicas are configurable" "($deployment | .spec.replicas) == 3 and ([\$docs[] | select(.kind == \"PodDisruptionBudget\")] | length) == 1"
render --set resources.controllers.main.replicas=1
check "a single replica gets no PodDisruptionBudget" "([\$docs[] | select(.kind == \"PodDisruptionBudget\")] | length) == 0 and ($deployment | .spec.replicas) == 1"

render --set resources.controllers.main.containers.main.resources.limits.memory=2Gi
check "resource bounds are configurable" "($server | .containers[0].resources.limits.memory) == \"2Gi\" and ($server | .containers[0].resources.requests.memory) == \"128Mi\""

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

render --set config.server.metrics.serviceMonitor.enabled=false
check "the ServiceMonitor can be disabled" "[\$docs[] | select(.kind == \"ServiceMonitor\")] | length == 0"

if render --set config.export.enabled=false --set-json 'config.export.output.persistence={}'; then
	check "a disabled export renders no CronJob and mounts no escrow key" \
		"([$cronjob] | length) == 0 and ([\$docs[] | .. | strings | select(contains(\"$escrow_secret\"))] | length) == 0"
else
	fail "a disabled export renders without an export volume: $(cat "$work/err")"
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

# --- documentation ----------------------------------------------------------

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
	--set config.server.escrow.recipient=age1pq1x --set config.server.escrow.signingKey=c2lnbg== --set config.server.escrow.default=false
documented_vars="$(grep -oE '^\| `VAULT_SYNC_[A-Z0-9_]+`' "$repo_root/docs/configuration.md" | tr -d '|` ')"
if [[ -z $documented_vars ]]; then
	fail "found the environment variables in docs/configuration.md"
fi
# The escrow identity is the export job's only, so it is looked for there.
for var in $documented_vars; do
	pod="$server"
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
