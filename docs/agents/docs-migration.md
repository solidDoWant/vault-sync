# Docs migration map (temporary)

Agent-only working file for the docs rewrite issues. It maps every section of every current human-facing doc (`README.md`, `SPEC.md`, and all of `docs/` except `docs/agents/`) to its destination in the tree defined in `docs/README.md`. The last rewrite issue deletes this file.

## How to use it

- Destinations are relative to `docs/` unless they start with a top-level file name. `user/`, `admin/` and `dev/` are the new trees.
- A section may go to several destinations at different depths (per the depth table in `docs/README.md`). The first destination listed is where the full detail lands; the others get the reader-level summary plus a "for more detail" link.
- **Every fact must land somewhere.** When a rewrite issue moves a section, it moves every fact in it, or records the drop here with a reason. Tick the row (`[x]`) when its content is in place.
- A row marked **stays** keeps its content where it is; the rewrite only adds the reader line and links (and plain English where the file is human-facing).
- After moving a page, apply the redirect rules in `docs/README.md` ("Moved pages and redirects").
- The rewrite issues are: user docs, admin docs, developer docs, SPEC.md readability, and front door + links + docs style check. Each row's owner is the issue for its first destination's tree (`user/` → user docs, `admin/` → admin docs, `dev/` → developer docs, `SPEC.md` → SPEC readability, `README.md` and stubs → front door).

## Machine-read docs: move these together with their readers

Scripts and tests parse some pages. Moving a table without updating its reader breaks CI. The rewrite issue that moves the table updates the reader in the same PR:

| Content | Today | New home | Readers to update |
|---|---|---|---|
| Environment-variable table (rows whose first cell is a backticked `VAULT_SYNC_` name) | `configuration.md` "Environment variables" | `admin/configuration.md` | `scripts/chart_test.sh` (documented_vars) |
| Metrics tables (rows whose first cell is a backticked `vault_sync_` name) | `configuration.md` "Metrics", "Service-wide metrics" | `admin/monitoring.md` | `internal/server/metrics_doc_test.go`, `scripts/chart_test.sh` (documented_metrics), `scripts/dashboard_test.py`, comment in `internal/servicemetrics/servicemetrics.go` |
| One `### AlertName` heading per alert | `alerts.md` | `admin/alerts.md` | `scripts/chart_test.sh` (alert headings and `runbook_url`), chart `values.yaml` `config.alerts.runbookUrlBase` and its `values.schema.json` description, `alerts/vault-sync.rules.yaml` and `templates/prometheus-rule.yaml` comments, the `runbookUrlBase` row in the chart-values doc |
| Chart value paths in backticks | `deployment.md` "Chart values" | `admin/chart-values.md` | `scripts/chart_test.sh` (values documented check) |
| Doc paths in chart comments | `deployment.md`, `configuration.md`, `export.md`, `alerts.md` | new admin pages | `deploy/charts/vault-sync/Chart.yaml`, `values.yaml`, `templates/grafana-dashboards.yaml` |
| Doc paths in code comments | `configuration.md`, `export.md`, `import.md`, `plugin.md` | new pages | `cmd/vault-sync-server/main.go`, `plugin/src/main.ts`, `plugin/src/core/protocol/client.ts`, `cmd/vault-sync-server/lost_passphrase_integration_test.go` |
| CI path filter that runs the chart checks on a docs-only change | `configuration.md`, `deployment.md`, `alerts.md` | `admin/configuration.md`, `admin/monitoring.md`, `admin/chart-values.md`, `admin/alerts.md` | `.github/workflows/ci.yml` (the `docs/{configuration,deployment,alerts}.md` filter and its comments) |
| Acceptance checklists | `acceptance/phase-*.md` | stay | `scripts/acceptance.sh`, `scripts/acceptance-scoreboard.py` (don't move them) |
| `proto-compatibility.md` | `testing/` | stays | `buf.yaml` |

Grep for the old path (`grep -rn 'docs/<page>.md' --exclude-dir=node_modules .`) before deleting any stub.

## README.md

| Section | Destination | Notes |
|---|---|---|
| [ ] Title and summary ("Self-hosted synchronization…") | `README.md` (front door) | Rewrite as the front door: what it is, status, three links (Use it / Run a server / Work on the code). |
| [ ] Status note | `README.md` | Update to the real status (released versions exist; see `CHANGELOG.md`). The "nothing here is usable yet" text is out of date. |
| [ ] Development (dev shell, `make help`, git-flake rule) | `dev/building.md` | Front door keeps one link. The git-flake rule also stays in `CLAUDE.md`. |
| [ ] License | `README.md` | stays |

## SPEC.md

SPEC keeps its section numbers and rules. "Decision history" means the "(decision, #NNN)" parentheticals, issue numbers and rejected alternatives; each moves to `dev/decisions.md` under a heading naming the SPEC section.

| Section | Destination | Notes |
|---|---|---|
| [ ] 1. Purpose | stays; summary to `README.md`, `dev/architecture.md` | |
| [ ] 2. Design principles | stays; summary to `dev/contributing.md` | Principles are normative; keep wording of the rules. |
| [ ] 3. Target environment | stays (rule); detail to `admin/requirements.md` | Kubernetes, CNPG, Ceph RGW, Authentik, Istio/Coraza as the reference setup. |
| [ ] 4. Architecture | stays; overview to `dev/architecture.md` | Decision history to `dev/decisions.md`. |
| [ ] 4.1 Protocol transport (decision) | stays (rule); rationale and rejected alternatives to `dev/decisions.md` | |
| [ ] 5. Data model | stays; overview to `dev/architecture.md`; terms to `dev/glossary.md` (as links) | |
| [ ] 6. Sync protocol | stays; overview to `dev/protocol.md` | |
| [ ] 6.1 Pull | stays; overview to `dev/protocol.md` | |
| [ ] 6.2 Push (optimistic concurrency) | stays; overview to `dev/protocol.md`; one line to `admin/security.md` (server never merges) | |
| [ ] 6.3 Renames, deletes, creates | stays; overview to `dev/protocol.md`; user view (deletes are kept in history) to `user/syncing.md` | |
| [ ] 6.4 Realtime channel | stays; overview to `dev/protocol.md`; ingress needs to `admin/install.md` | |
| [ ] 7. Merge rules (client side) | stays; user view to `user/conflicts-and-history.md` | |
| [ ] 8. Client durability | stays; user view (nothing is lost on a crash) to `user/syncing.md` | |
| [ ] 9. Authentication, authorization, encryption | stays | |
| [ ] 9.1 Authentication | stays; provider requirements to `admin/identity-provider.md`; user sign-in to `user/getting-started.md` | |
| [ ] 9.2 Authorization | stays; roles to `user/sharing.md`; no-admin-bypass to `admin/security.md` | |
| [ ] 9.3 End-to-end encryption | stays; user view to `user/encryption.md`; operator view to `admin/encryption.md` | Decision history to `dev/decisions.md`. |
| [ ] 9.4 Escrow for plaintext backups | stays; to `admin/encryption.md`, `admin/backup-and-restore.md`; user view to `user/encryption.md` | |
| [ ] 10. Live collaborative editing (Phase 5) | stays | Future phase; no user or admin page until it ships. |
| [ ] 11. Retention and history | stays (rule); settings to `admin/history-and-retention.md`; user view to `user/conflicts-and-history.md` | |
| [ ] 12. Operations | rule stays; operational detail (logs, metrics, health, backups, export) moves to `admin/monitoring.md`, `admin/backup-and-restore.md`, `admin/upgrades.md` | Leave SPEC the rules, not the how-to. |
| [ ] 13. Testing strategy | stays; summary to `dev/README.md` (testing section) linking `testing/` | |
| [ ] 14. Repository layout | stays; copy summary to `dev/architecture.md` | Keep one authoritative list (SPEC); dev page links to it. |
| [ ] 15. Phases | stays; status summary to `README.md` | |
| [ ] 16. Open questions | stays | |

## docs/plugin.md → user (mostly)

| Section | Destination | Notes |
|---|---|---|
| [ ] Intro | drop | Replaced by the reader line on each user page. |
| [ ] Settings | `user/getting-started.md` (tour of the settings tab); each setting also on the page for its topic | Advanced settings listed in `user/troubleshooting.md` where they fix a problem. |
| [ ] Signing in | `user/getting-started.md`; device-grant detail to `dev/architecture.md` (sign-in) | "RFC 8628" is developer depth. |
| [ ] When the session ends | `user/troubleshooting.md` ("sign-in needed"); `user/getting-started.md` | |
| [ ] Connecting a vault | `user/getting-started.md` | |
| [ ] Sharing a vault | `user/sharing.md`; member limit and roles also to `admin/security.md` | |
| [ ] Device registration | `user/devices.md`; device id in `data.json` to `dev/architecture.md` | |
| [ ] Devices | `user/devices.md` | |
| [ ] End-to-end encryption (setup, unlock, change passphrase) | `user/encryption.md`; Argon2id parameters to `dev/` via `docs/design/crypto.md` link only | Follow the passphrase row of the depth table. |
| [ ] Sync | `user/syncing.md`; timeouts and retry detail to `dev/protocol.md` | |
| [ ] Realtime channel | `user/syncing.md` (one paragraph: changes arrive in seconds); `admin/install.md` (WebSocket path); protocol detail to `dev/protocol.md` | |
| [ ] Status | `user/syncing.md` (icons); `user/troubleshooting.md` (each message) | |
| [ ] Conflicts | `user/conflicts-and-history.md`; "files that are not synced" and name rules to `user/syncing.md` and `user/troubleshooting.md` | Size limits: user page gives the numbers; admin page names `VAULT_SYNC_BLOB_MAX_SIZE_BYTES`. |
| [ ] Config folder | `user/syncing.md` (what is not synced); `user/faq.md` | |
| [ ] History and restore | `user/conflicts-and-history.md`; retention numbers link to `admin/history-and-retention.md` | |
| [ ] Identity provider setup (Authentik) | `admin/identity-provider.md` | Admin content, not user. Merge with `deployment.md` "Authentik". |

## docs/encryption.md → user + admin

| Section | Destination | Notes |
|---|---|---|
| [ ] Intro | drop | Reader lines replace it. |
| [ ] In short | `user/encryption.md` (user summary); `admin/encryption.md` (operator summary) | |
| [ ] What the server can and can't see | `admin/encryption.md` (full list); `user/encryption.md` (short list) | |
| [ ] Your key and your recovery passphrase | `user/encryption.md`; Argon2id and the guess limit to `admin/encryption.md`; key chain to `docs/design/crypto.md` (already there) | Depth table row "Recovery passphrase". |
| [ ] Vault keys | `admin/encryption.md`; cipher names stay in `docs/design/` | Users don't need key slots. |
| [ ] Creating an encrypted vault | `user/encryption.md`; escrow default setting to `admin/encryption.md` | |
| [ ] Invitations | `user/sharing.md` (how to invite to an encrypted vault); code format to `docs/design/encryption.md` (check it is there) | |
| [ ] Rotation | `user/sharing.md` (what a removed member keeps); `admin/encryption.md` (epochs) | |
| [ ] Re-encrypting history | `admin/encryption.md`; one line to `user/encryption.md` | Rekey backlog alert links here. |
| [ ] Converting a plaintext vault | `user/encryption.md` | |
| [ ] Escrow | `user/encryption.md` (what escrow means for you); `admin/encryption.md` | |
| [ ] For operators: the escrow key | `admin/encryption.md` | |
| [ ] Losing your passphrase | `user/encryption.md`; operator recovery steps to `admin/encryption.md` | |
| [ ] Recovery with `age` | `admin/encryption.md` (or `admin/backup-and-restore.md`, linked from both) | |
| [ ] Threat model | `admin/security.md`; short user version in `user/encryption.md` | |
| [ ] A stolen copy of the database or the bucket | `admin/security.md`; user version: "choose a long passphrase" | |
| [ ] An actively malicious server | `admin/security.md`; mechanism stays in `docs/design/encryption.md` | |
| [ ] What encryption does not protect | `admin/security.md`; `user/encryption.md` | Must stay visible to users. |

## docs/configuration.md → admin

| Section | Destination | Notes |
|---|---|---|
| [ ] Intro (env-only config, validation, exit status) | `admin/configuration.md`; failure messages to `admin/troubleshooting.md` | |
| [ ] Environment variables (table) | `admin/configuration.md` | Machine-read (see top). Keep one row per variable. |
| [ ] Authentication | `admin/identity-provider.md`; token checks to `admin/security.md` | |
| [ ] Authorization | `admin/security.md` | |
| [ ] Blob storage | `admin/postgresql-and-s3.md`; size and chunk limits to `admin/security.md` (limits) | |
| [ ] Revisions and the change feed | `admin/postgresql-and-s3.md`; protocol detail to `dev/protocol.md` | |
| [ ] Retention and history | `admin/history-and-retention.md` | |
| [ ] Per-vault overrides | `admin/history-and-retention.md` | |
| [ ] Realtime channel | `admin/install.md` (ingress); limits to `admin/security.md` | |
| [ ] PostgreSQL TLS | `admin/postgresql-and-s3.md` | |
| [ ] Endpoints | `admin/configuration.md`; CORS and health detail to `admin/security.md`, `admin/monitoring.md` | |
| [ ] Metrics | `admin/monitoring.md` | Machine-read (see top). |
| [ ] Service-wide metrics | `admin/monitoring.md` | Machine-read (see top). |
| [ ] Startup and shutdown | `admin/requirements.md` (PostgreSQL 14+); `admin/upgrades.md` (migrations, graceful shutdown); `admin/troubleshooting.md` | |
| [ ] High-availability deployment | `admin/upgrades.md` (rolling upgrades, HA); design detail to `dev/architecture.md` | |

## docs/deployment.md → admin

| Section | Destination | Notes |
|---|---|---|
| [ ] Intro and "What you deploy" | `admin/install.md`; reference setup to `admin/requirements.md` | |
| [ ] The image | `admin/install.md` | |
| [ ] PostgreSQL (CloudNativePG) | `admin/postgresql-and-s3.md` | |
| [ ] S3 (Ceph RGW) | `admin/postgresql-and-s3.md` | |
| [ ] Authentik (the device-flow application) | `admin/identity-provider.md` | Merge with `plugin.md` "Identity provider setup". |
| [ ] The WAF body limit (Istio and Coraza) | `admin/install.md`; limit relationship to `admin/security.md` | |
| [ ] The export job | `admin/backup-and-restore.md` | |
| [ ] Installing the chart | `admin/install.md` | |
| [ ] Upgrading | `admin/upgrades.md` | |
| [ ] Per-vault retention | `admin/history-and-retention.md` | |
| [ ] Undeleting a vault | `admin/backup-and-restore.md`; one line in `user/sharing.md` (ask your admin) | |
| [ ] Chart values (and Shared settings, PostgreSQL, S3, OIDC, Server, Export, Route, Grafana dashboards, Alerts, Overriding the computed resources) | `admin/chart-values.md` | Machine-read (see top). Keep each subsection. |
| [ ] High availability | `admin/upgrades.md` | Merge with `configuration.md` "High-availability deployment". |
| [ ] Monitoring | `admin/monitoring.md` | |
| [ ] Releasing | `dev/releasing.md` | Developer content, not admin. |

## docs/export.md → admin (+ user)

| Section | Destination | Notes |
|---|---|---|
| [ ] Intro | `admin/backup-and-restore.md`; user summary in `user/getting-your-notes-out.md` | |
| [ ] Flags | `admin/backup-and-restore.md` | |
| [ ] Environment variables | `admin/backup-and-restore.md` | Not part of the server's machine-read table; keep as its own table. |
| [ ] What an export contains | `admin/backup-and-restore.md`; user summary in `user/getting-your-notes-out.md` | |
| [ ] Output layout | `admin/backup-and-restore.md` | |
| [ ] End-to-end encrypted vaults | `admin/backup-and-restore.md`; links `admin/encryption.md` | |
| [ ] Documents that cannot be placed at their path | `admin/backup-and-restore.md` | |
| [ ] Manifest | `admin/backup-and-restore.md` | |
| [ ] Atomic replacement | `admin/backup-and-restore.md`; mechanism to `dev/architecture.md` (export) | |
| [ ] Path safety | `admin/security.md`; mechanism to `dev/architecture.md` | |
| [ ] Summary and exit status | `admin/backup-and-restore.md` | |
| [ ] Rotating the escrow key | `admin/encryption.md` | |
| [ ] Signals | `admin/backup-and-restore.md` | |

## docs/import.md → admin (+ user)

| Section | Destination | Notes |
|---|---|---|
| [ ] Intro | `admin/backup-and-restore.md`; user line in `user/faq.md` (moving notes in) | |
| [ ] What it imports | `admin/backup-and-restore.md` | |
| [ ] Importing into an end-to-end encrypted vault | `admin/backup-and-restore.md`; links `admin/encryption.md` | |
| [ ] Verification against the server | `admin/backup-and-restore.md`; mechanism stays in `docs/design/encryption.md` "Import" | |
| [ ] With the escrow identity | `admin/backup-and-restore.md` | |
| [ ] What it skips | `admin/backup-and-restore.md` | |
| [ ] Report and exit status | `admin/backup-and-restore.md` | |

## docs/alerts.md → admin

| Section | Destination | Notes |
|---|---|---|
| [ ] Intro | `admin/alerts.md` | |
| [ ] Availability (VaultSyncNoReplicaReady, VaultSyncReplicasUnavailable, VaultSyncRPCErrorRatioHigh, VaultSyncSyncLatencyHigh, VaultSyncRealtimeListenerDown, VaultSyncConcurrencyRejections, VaultSyncRealtimeRefusals) | `admin/alerts.md` | Keep every `### AlertName` heading verbatim (machine-read; runbook anchors). |
| [ ] Dependencies (VaultSyncDatabasePoolExhausted, VaultSyncS3ErrorRatioHigh, VaultSyncOIDCKeyRefreshFailing) | `admin/alerts.md` | same |
| [ ] Data safety and backlog (VaultSyncRetentionNotSucceeding, VaultSyncExportNotSucceeding, VaultSyncUploadSessionsNotExpiring, VaultSyncBlobGCStalled, VaultSyncRekeyBacklogNotShrinking, VaultSyncEscrowRewrapStuck, VaultSyncServiceMetricsStale) | `admin/alerts.md` | same |
| [ ] Stub | `alerts.md` keeps one heading per alert linking to `admin/alerts.md#…` for one release | See redirects in `docs/README.md`. |

## docs/design/ (stays; developer and agent reference)

All sections stay. The developer docs rewrite adds a reader line ("For: developers and agents…") and links from `dev/README.md`. Decision history inside design docs stays: design docs are where the reasons live. Files: `engine.md` (§1–§12), `engine-situations.md` (§1–§11, Count), `sharing.md` (Roles, Sync is unchanged, Viewer devices, Losing access, Deleting a vault, Attribution), `encryption.md` (Model … Documentation), `crypto.md` (Principles … Vectors). Do not renumber `engine.md` sections; code and tests cite them.

| Section | Destination | Notes |
|---|---|---|
| [ ] `design/sharing.md` Roles, Losing access, Deleting a vault | stays; user view to `user/sharing.md` | |
| [ ] `design/encryption.md` Escrow, Protection against an active server | stays; operator view already in `admin/encryption.md`, `admin/security.md` | |
| [ ] `design/encryption.md` Documentation | stays | Says which user docs must exist; update its links to the new paths. |
| [ ] `design/engine.md` §10 Status and user interface | stays; user view to `user/syncing.md` | |
| [ ] every other design section | stays | |

## docs/testing/ (stays; developer)

| Section | Destination | Notes |
|---|---|---|
| [ ] `acceptance.md` (all sections) | stays; linked from `dev/README.md` | |
| [ ] `integration.md` (all sections) | stays; linked from `dev/README.md` | |
| [ ] `e2e.md` (all sections) | stays; linked from `dev/README.md` | "Real Android app on an emulator (spike, #187)": drop the issue number from the heading. |
| [ ] `android.md` (all sections) | stays; linked from `dev/releasing.md` | Manual release checklist. |
| [ ] `proto-compatibility.md` (all sections) | stays | `buf.yaml` cites it. |

## docs/acceptance/ (stays; owner)

| Section | Destination | Notes |
|---|---|---|
| [ ] `phase-2.md`, `phase-3.md`, `phase-4.md` (all sections) | stay | Owner-facing; scripts parse the scenario ids. Only the owner changes scenarios. Plain-English edits must not change any `[AC-nn]`/`[P3-nn]`/`[P4-nn]` id or meaning. |

## New pages with no current source

These have no section today; the rewrite writes them from the sources above:

- `user/troubleshooting.md`, `user/faq.md`, `user/glossary.md`, `user/getting-your-notes-out.md`;
- `admin/requirements.md` (from SPEC §3, configuration "Startup and shutdown", deployment intro), `admin/troubleshooting.md`, `admin/glossary.md`, `admin/security.md` (assembled from the rows above);
- `dev/README.md`, `dev/architecture.md`, `dev/protocol.md`, `dev/contributing.md` (from `CLAUDE.md` workflow rules that also apply to humans), `dev/decisions.md` (from SPEC decision history), `dev/glossary.md`.
