# Docs migration map (temporary)

Agent-only working file for the docs rewrite issues. It classifies every section of every current human-facing doc (`README.md`, `SPEC.md`, and all of `docs/` except `docs/agents/`) and maps it to its destination in the tree defined in `docs/README.md`. The last rewrite issue deletes this file.

## How to use it

- Destinations are relative to `docs/` unless they start with a top-level file name. `user/`, `admin/` and `dev/` are the new trees.
- A section may go to several destinations at different depths (per the depth table in `docs/README.md`). The first destination listed is where the full detail lands; the others get the reader-level summary plus a "for more detail" link.
- **Every fact must land somewhere** — in a page, a generator's output, a code comment, a test name, or a recorded drop. When a rewrite issue moves a section, it moves every fact in it, or records the drop here with a reason. Tick the row (`[x]`) when its content is in place.
- A row marked **stays** keeps its content where it is; the rewrite only adds the reader line and links (and plain English where the file is human-facing), and applies the row's class.
- After moving a page, apply the redirect rules in `docs/README.md` ("Moved pages and redirects").
- The rewrite issues are: user docs, admin docs, developer docs, SPEC.md readability, and front door + links + docs style check. Each row's owner is the issue for its first destination's tree (`user/` → user docs, `admin/` → admin docs, `dev/` → developer docs, `SPEC.md` → SPEC readability, `README.md` and stubs → front door).
- Word counts (**W**) are today's words in the section, counted with `wc -w` semantics per heading (fenced code included). **Target** is the projected hand-written words after the rewrite. Targets are rough guidance for planning, not limits (`docs/README.md`, "Size").

## Classes

Every row has exactly one primary class. A row whose content splits says so in its notes (for example "keep rule, move server details, delete history"); the primary class is the one that decides most of its words.

| Class | Meaning | What the rewrite does |
|---|---|---|
| **keep** | A reader of that audience needs it and can't learn it from the code: why a design is the way it is, binding owner decisions, non-goals, cross-component contracts, what to do when something breaks. | Rewrite at the reader's depth, in plain English where human-facing. |
| **generate** | Reference material that restates code. | Write a generator that produces the table from the source, check the output in, and make CI fail on a diff (`make check-generate` or a sibling target). Scripts that parse the table today read the generator's output or the source instead. |
| **move** | Move next to the code: facts only an agent changing that code needs. | Put it in the proto comment, Go package doc, TypeScript module comment or test name named in the row. Where the named test or vector already pins the fact, the prose is deleted, not moved: the test is the contract. |
| **delete** | History (issue numbers, "(decision, #NNN)" trails, rejected alternatives, superseded designs), duplication, or a description of code that no longer exists. | Remove it. A reason is given on each delete row. Decisions that still bind go to `dev/decisions.md` (see "Decisions that still bind"). |

## Generators

The reference tables marked "machine-read" in the first version of this map are **generate**. Each gets a generator, a checked-in output page and a CI diff check. The scripts that parse the tables today switch to the generated page (same row format) or to the source.

| Table | Source | Output page | How | Readers to switch |
|---|---|---|---|---|
| Environment variables (`VAULT_SYNC_*`, server and export) | The `*Env` constants in `internal/config/config.go` and their defaults and validation in the same package. | `admin/configuration-reference.md` | A small Go generator (`go run ./internal/config/docgen` or similar, using `go/ast` and `go/doc` from the standard library) that reads each constant's doc comment, default and allowed range. The descriptions move from today's table into those doc comments first. Done: `internal/config/configuration_reference_test.go` (`make generate-docs`, `make check-generate-docs`); the export's own table in `export.md` moves with the data pages. | `scripts/chart_test.sh` (documented_vars) |
| Metrics (`vault_sync_*`, per-replica and service-wide) | The collectors' `prometheus.*Opts` (`Name`, `Help`, label names) in `internal/server`, `internal/store`, `internal/blobstore`, `internal/auth`, `internal/retention`, `internal/realtime`, `internal/servicemetrics`. | `admin/metrics-reference.md` | A Go test or `go run` program that registers every collector on a fresh registry and prints name, type, labels and help. `Help` strings are lengthened where today's table says more. Replaces the hand check in `internal/server/metrics_doc_test.go`. Done: `internal/server/metrics_reference_test.go` (`make generate-docs`, `make check-generate-docs`). | `internal/server/metrics_doc_test.go`, `scripts/chart_test.sh` (documented_metrics), `scripts/dashboard_test.py`, comment in `internal/servicemetrics/servicemetrics.go` |
| Chart values | `deploy/charts/vault-sync/values.yaml` comments and `values.schema.json`. | `admin/chart-values.md` | `helm-docs` (established tool; add it to `flake.nix`) with `# --` comments in `values.yaml`. The prose now in `deployment.md` "Chart values" moves into those comments. | `scripts/chart_test.sh` (values documented check) |
| RPC errors | Proto comments in `proto/`. | none | Already in the proto comments and the generated code. No page; `dev/protocol.md` links to `proto/`. | none |

Alert runbooks (`alerts.md`) are **keep**: what to check and what to do can't be generated. The alert names and expressions already live in `alerts/vault-sync.rules.yaml`; the runbook does not repeat the expression.

## Decisions that still bind

`dev/decisions.md` keeps only these, each under the SPEC section it belongs to, with the reason in one to three sentences and no issue numbers. Every other "(decision, #NNN)" trail, issue number and rejected alternative is a **delete**: git and the issues keep the history.

- §4: the server never merges content; the plugin's `core` never imports `obsidian`; the export is the only process that holds the escrow private key.
- §4.1: ConnectRPC over protobuf, one schema for HTTP/1.1 JSON and binary (why not gRPC-only or hand-written REST: Obsidian's `requestUrl` and the mobile WebView).
- §6.2: optimistic concurrency on `base_rev_id`; an acknowledged revision is never lost (principle 1).
- §6.4: the realtime channel only says "pull now"; pulling decides sync. The token travels as a WebSocket subprotocol, never in the URL.
- §9.1: OAuth device authorization grant with a public client (works the same on desktop and Android); only the refresh token is stored, device-local.
- §9.2: authorization is central and runs before every handler; there is no admin bypass of vault roles.
- §9.3: hybrid post-quantum user keys (ML-KEM-768 + X25519, age format); a suite version byte on every ciphertext; key commitments in slots; removing a member starts a new epoch and history is re-keyed by the owner's re-key job, not by the server.
- §9.4: escrow is opt-in per vault and the escrow key is rotated through a signed chain.
- §11: a document's head revision is never purged; per-vault retention overrides exist and are set by the operator.

## Machine-read docs: move these together with their readers

Scripts and tests parse some pages. Moving a table without updating its reader breaks CI. The rewrite issue that moves the table updates the reader in the same PR:

| Content | Today | New home | Readers to update |
|---|---|---|---|
| Environment-variable table | `configuration.md` "Environment variables" | generated `admin/configuration-reference.md` (see Generators) | `scripts/chart_test.sh` (documented_vars) |
| Metrics tables | `configuration.md` "Metrics", "Service-wide metrics" | generated `admin/metrics-reference.md` (see Generators) | `internal/server/metrics_doc_test.go`, `scripts/chart_test.sh` (documented_metrics), `scripts/dashboard_test.py`, comment in `internal/servicemetrics/servicemetrics.go` |
| One `### AlertName` heading per alert | `alerts.md` | `admin/alerts.md` | `scripts/chart_test.sh` (alert headings and `runbook_url`), chart `values.yaml` `config.alerts.runbookUrlBase` and its `values.schema.json` description, `alerts/vault-sync.rules.yaml` and `templates/prometheus-rule.yaml` comments, the `runbookUrlBase` row in the chart-values doc |
| Chart value paths in backticks | `deployment.md` "Chart values" | generated `admin/chart-values.md` (see Generators) | `scripts/chart_test.sh` (values documented check) |
| Doc paths in chart comments | `deployment.md`, `configuration.md`, `export.md`, `alerts.md` | new admin pages | `deploy/charts/vault-sync/Chart.yaml`, `values.yaml`, `templates/grafana-dashboards.yaml` |
| Doc paths in code comments | `configuration.md`, `export.md`, `import.md`, `plugin.md` | new pages | `cmd/vault-sync-server/main.go`, `plugin/src/main.ts`, `plugin/src/core/protocol/client.ts`, `cmd/vault-sync-server/lost_passphrase_integration_test.go` |
| CI path filter that runs the chart checks on a docs-only change | `configuration.md`, `deployment.md`, `alerts.md` | the generated pages, `admin/monitoring.md`, `admin/alerts.md` | `.github/workflows/ci.yml` (the `docs/{configuration,deployment,alerts}.md` filter and its comments) |
| Acceptance checklists | `acceptance/phase-*.md` | stay | `scripts/acceptance.sh`, `scripts/acceptance-scoreboard.py` (don't move them) |
| `proto-compatibility.md` | `testing/` | stays | `buf.yaml` |

Grep for the old path (`grep -rn 'docs/<page>.md' --exclude-dir=node_modules .`) before deleting any stub.

## README.md (260 W → front door target 250)

| Section | Class | Destination | Notes |
|---|---|---|---|
| [ ] Title and summary ("Self-hosted synchronization…") | keep | `README.md` (front door) | Rewrite as the front door: what it is, status, three links (Use it / Run a server / Work on the code). |
| [ ] Status note | keep | `README.md` | Update to the real status (released versions exist; see `CHANGELOG.md`). The "nothing here is usable yet" text is out of date, so the old text is a delete. |
| [x] Development (dev shell, `make help`, git-flake rule) | keep | `dev/building.md` | Front door keeps one link. The git-flake rule also stays in `CLAUDE.md`. |
| [ ] License | keep | `README.md` | stays |

## SPEC.md (21.4k W → target 7k)

SPEC keeps its section numbers and its rules. The SPEC readability issue applies the classes below. "move" names the tests or vectors that already pin the rule: the SPEC keeps a one-line rule and a pointer to the test file, and the step-by-step server or client details go to the named code comments or are deleted because the test pins them. Decision history is a delete except the entries in "Decisions that still bind".

| Section | W | Class | Destination | Notes | Target |
|---|---|---|---|---|---|
| [ ] 1. Purpose | 90 | keep | stays; summary to `README.md`, `dev/architecture.md` | | 90 |
| [ ] 2. Design principles | 214 | keep | stays; summary to `dev/contributing.md` | Normative; keep the wording of the rules. Principle 4's bounds are pinned by `internal/server/limits_test.go`, `blob_limits_internal_test.go`, `page_bytes_integration_test.go`, but the principle itself stays. | 214 |
| [ ] 3. Target environment | 373 | keep | stays (rule); detail to `admin/requirements.md` | Kubernetes, CNPG, Ceph RGW, Authentik, Istio/Coraza as the reference setup. Deployment detail (CNPG client certs, Talos) is admin depth: move to `admin/requirements.md` and cut here. | 200 The detail is copied to `admin/requirements.md`; cutting it here is left for the SPEC rewrite. |
| [ ] 4. Architecture | 1,327 | move | stays (component list and the three binding rules); overview to `dev/architecture.md` | The `core` no-`obsidian` rule is enforced by `plugin/eslint.config.*` (the `obsidian` import restriction) and `plugin/test/core-import-fence.test.ts`: keep one line, delete the detail. The long `plugin/src/obsidian` and `export` bullets (adapter internals, export credentials) move to the package docs of `plugin/src/obsidian` and `internal/export`. HA rules are pinned by `cmd/vault-sync-server/instances_integration_test.go` and `upgrade_integration_test.go`. Decision history: delete. | 450 |
| [ ] 4.1 Protocol transport (decision) | 119 | keep | stays (rule); reason to `dev/decisions.md` | Backward compatibility is enforced by `buf breaking` (`make lint`) and `make check-generate`: one line. Rejected alternatives: delete. | 80 |
| [ ] 5. Data model | 2,226 | move | table stays as one line per entity; overview to `dev/architecture.md`; terms to `dev/glossary.md` (as links) | The column lists restate `internal/store/migrations/`: keep entity, key and one-line purpose, delete column lists (pinned by `internal/store/migrate_integration_test.go`, `internal/server/vaultid_schema_test.go`). "Paths" (≈900 W): keep the rule (path is an attribute, uniqueness on `path_key`), move the normalization steps to the `internal/pathkey` and `internal/vaultpath` package docs (pinned by `internal/pathkey/pathkey_test.go`, `normalize_internal_test.go`, `internal/vaultpath/vaultpath_test.go`, `internal/server/path_*_integration_test.go`, `long_path_integration_test.go`, `path_backslash_integration_test.go`). "Content addressing": keep, pinned by `testdata/crypto/vectors.json`. | 900 |
| [ ] 6. Sync protocol | 0 | keep | stays; overview to `dev/protocol.md` | heading only | 0 |
| [ ] 6.1 Pull | 659 | move | stays (rule: `ListChanges` from a cursor, pages, anchors); overview to `dev/protocol.md` | Paging and anchor details are pinned by `internal/api/changes_anchors_internal_test.go`, `internal/server/cursor_anchor_integration_test.go`, `anchor_list_integration_test.go`, `page_bytes_integration_test.go`; move them to the `ListChanges` proto comment. | 250 |
| [ ] 6.2 Push (optimistic concurrency) | 2,605 | move | stays (the three steps and the acknowledgement rule); overview to `dev/protocol.md`; one line to `admin/security.md` (server never merges) | The two "Server-side details (decision)" blocks (≈2,100 W: multipart sizes, locking order, idempotency, reclaim) move to the `internal/server` blob and commit handlers' comments and the proto comments; pinned by `internal/server/blob_integration_test.go`, `blob_codec_integration_test.go`, `blob_reclaim_integration_test.go`, `concurrency_test.go`, `concurrency_order_test.go`, `sync_integration_test.go`, `encrypted_commit_integration_test.go`, `folder_integration_test.go`. | 500 |
| [ ] 6.3 Renames, deletes, creates | 56 | keep | stays; overview to `dev/protocol.md`; user view (deletes are kept in history) to `user/syncing.md` | | 56 |
| [ ] 6.4 Realtime channel | 1,116 | move | stays (one socket per device, "pull now" only, token as subprotocol); overview to `dev/protocol.md`; ingress needs to `admin/install.md` | Upgrade, bounds, fan-out and drain details move to the `internal/realtime` package doc (pinned by `internal/realtime/hub_test.go`, `internal/server/realtime_integration_test.go`); client reconnect and pull details move to `plugin/src/core/realtime` module comments (pinned by its tests). Decision history: delete. | 300 |
| [ ] 7. Merge rules (client side) | 215 | keep | stays; user view to `user/conflicts-and-history.md` | Already a pointer to `docs/design/engine.md` §5; cut the summary to the pointer. | 80 |
| [ ] 8. Client durability | 16 | keep | stays; user view (nothing is lost on a crash) to `user/syncing.md` | | 16 |
| [ ] 9. Authentication, authorization, encryption | 0 | keep | stays | heading only | 0 |
| [ ] 9.1 Authentication | 1,060 | move | stays (device grant, default-deny, accepted algorithms); provider requirements to `admin/identity-provider.md`; user sign-in to `user/getting-started.md` | Client details (HTTP client, storage, refresh) move to `plugin/src/core/auth` module comments (pinned by `plugin/src/core/auth/authenticated-sync.test.ts` and its siblings); server details (JWKS refresh, JIT users) move to the `internal/auth` package doc (pinned by `internal/server/auth_test.go`, `auth_integration_test.go`). Decision history: delete. | 300 |
| [ ] 9.2 Authorization | 2,082 | move | stays (role table, central check, no bypass); roles to `user/sharing.md`; no-admin-bypass to `admin/security.md` | Per-RPC rules for vaults, deletion, membership and devices (≈1,700 W) move to the proto service comments and `internal/authz` package doc; pinned by `internal/server/authz_test.go`, `authz_integration_test.go`, `role_access_integration_test.go`, `membership_integration_test.go`, `invitation_slots_integration_test.go`, `delete_vault_test.go`, `device_integration_test.go`, `device_registration_integration_test.go`, `device_rename_integration_test.go`. Limits (100 vaults, 100 devices) also to `admin/security.md`. | 400 |
| [ ] 9.3 End-to-end encryption | 3,839 | move | stays (envelope model, suites, epochs, what the server never sees); user view to `user/encryption.md`; operator view to `admin/encryption.md` | Formats and byte layouts are pinned by `testdata/crypto/vectors.json` (`internal/e2ee/vectors_test.go`, `memberlog_vectors_test.go`, `plugin/src/core/e2ee/vectors.test.ts`) and already described in `docs/design/crypto.md`: delete here. Service details (user keys, anchor lists, epochs, slots, re-key calls, plugin key managers) move to the proto service comments and `plugin/src/core/keys` module comments; pinned by `internal/server/user_key_integration_test.go`, `vault_key_integration_test.go`, `epoch_record_integration_test.go`, `vault_log_integration_test.go`, `membership_log_integration_test.go`, `vault_conversion_integration_test.go`, `internal/e2ee/*_test.go`. Decision history: delete. | 900 |
| [ ] 9.4 Escrow for plaintext backups | 511 | keep | stays; to `admin/encryption.md`, `admin/backup-and-restore.md`; user view to `user/encryption.md` | Escrow chain details are pinned by `internal/server/escrow_chain_test.go`, `escrow_chain_integration_test.go`, `escrow_job_test.go`. | 350 |
| [ ] 10. Live collaborative editing (Phase 5) | 197 | keep | stays | Future phase; no user or admin page until it ships. | 197 |
| [ ] 11. Retention and history | 1,908 | move | stays (keep-all/keep-daily policy, head never purged, overrides); settings to `admin/history-and-retention.md`; user view to `user/conflicts-and-history.md` | Purge mechanics, parent links, blob GC, concurrency and incremental scans move to the `internal/retention` package doc; pinned by `internal/retention/retention_integration_test.go`, `incremental_integration_test.go`, `vault_purge_integration_test.go`, `internal/store/retention_integration_test.go`, `purge_marker_prune_integration_test.go`, `internal/server/retention_integration_test.go`, `blob_reclaim_integration_test.go`. Client history paging moves to the engine's history module comments. | 450 |
| [ ] 12. Operations | 1,892 | move | rules stay (logs, metrics port, health, HA rules); operational detail moves to `admin/monitoring.md`, `admin/backup-and-restore.md`, `admin/upgrades.md` | Health and drain behaviour pinned by `internal/server/readyz_test.go`, `readyz_integration_test.go`, `draining_internal_test.go`; HA by `cmd/vault-sync-server/instances_integration_test.go`, `upgrade_integration_test.go`; export by `internal/export/export_test.go`. Metric lists: delete (generated reference). | 450 |
| [ ] 13. Testing strategy | 372 | keep | stays; summary to `dev/README.md` (testing section) linking `testing/` | | 300 |
| [ ] 14. Repository layout | 132 | keep | stays; summary to `dev/architecture.md` | One authoritative list (SPEC); dev page links to it. | 132 |
| [ ] 15. Phases | 147 | keep | stays; status summary to `README.md` | | 147 |
| [ ] 16. Open questions | 22 | keep | stays | | 22 |

## docs/plugin.md → user (7.8k W → user target, see the user pages)

| Section | W | Class | Destination | Notes |
|---|---|---|---|---|
| [x] Intro | 28 | delete | — | Replaced by the reader line on each user page. |
| [x] Settings | 1,083 | keep | `user/getting-started.md` (tour of the settings tab); each setting also on the page for its topic | Advanced settings listed in `user/troubleshooting.md` where they fix a problem. Setting internals (storage keys, defaults in code) are a delete: the settings tab shows them. |
| [ ] Signing in | 353 | keep | `user/getting-started.md`; device-grant detail to `dev/architecture.md` (sign-in) | "RFC 8628" is developer depth. User part done in `user/`; device-grant detail to `dev/architecture.md` is left for the developer docs. |
| [x] When the session ends | 137 | keep | `user/troubleshooting.md` ("sign-in needed"); `user/getting-started.md` | |
| [x] Connecting a vault | 382 | keep | `user/getting-started.md` | |
| [ ] Sharing a vault | 1,236 | keep | `user/sharing.md`; member limit and roles also to `admin/security.md` | RPC names and error codes are a delete (pinned by `plugin/src/obsidian/sharing.test.ts`). User part done in `user/`; member limit and roles in `admin/security.md` are left for the admin docs. |
| [ ] Device registration | 249 | keep | `user/devices.md`; device id in `data.json` to `plugin/src/obsidian` module comment (move) | User part done in `user/`; the `data.json` device-id module comment is left. |
| [x] Devices | 279 | keep | `user/devices.md` | |
| [x] End-to-end encryption (setup, unlock, change passphrase) | 646 | keep | `user/encryption.md`; Argon2id parameters to `dev/` via `docs/design/crypto.md` link only | Follow the passphrase row of the depth table. |
| [ ] Sync | 610 | keep | `user/syncing.md` | Timeouts and retry detail: move to `plugin/src/core/protocol` module comments. User part done in `user/`; the timeout and retry module comments are left. |
| [x] Realtime channel | 192 | keep | `user/syncing.md` (one paragraph: changes arrive in seconds); `admin/install.md` (WebSocket path) | Protocol detail duplicates SPEC §6.4: delete. User part done in `user/`; the WebSocket path in `admin/install.md` is left for the admin docs. Done: the WebSocket path is in `admin/install.md`. |
| [x] Status | 542 | keep | `user/syncing.md` (icons); `user/troubleshooting.md` (each message) | |
| [x] Conflicts | 1,084 | keep | `user/conflicts-and-history.md`; "files that are not synced" and name rules to `user/syncing.md` and `user/troubleshooting.md` | Size limits: user page gives the numbers; admin page names `VAULT_SYNC_BLOB_MAX_SIZE_BYTES`. Rule letters (M, W, C) are developer depth: delete here. |
| [x] Config folder | 42 | keep | `user/syncing.md` (what is not synced); `user/faq.md` | |
| [x] History and restore | 712 | keep | `user/conflicts-and-history.md`; retention numbers link to `admin/history-and-retention.md` | |
| [x] Identity provider setup (Authentik) | 164 | keep | `admin/identity-provider.md` | Admin content, not user. Merge with `deployment.md` "Authentik". Done: `admin/identity-provider.md`. |

## docs/encryption.md → user + admin (4.3k W)

| Section | W | Class | Destination | Notes |
|---|---|---|---|---|
| [ ] Intro | 92 | delete | — | Reader lines replace it. |
| [ ] In short | 118 | keep | `user/encryption.md` (user summary); `admin/encryption.md` (operator summary) | User part done in `user/`; admin summary left. |
| [ ] What the server can and can't see | 240 | keep | `admin/encryption.md` (full list); `user/encryption.md` (short list) | User part done in `user/`; full list left for `admin/encryption.md`. |
| [ ] Your key and your recovery passphrase | 371 | keep | `user/encryption.md`; Argon2id and the guess limit to `admin/encryption.md` | Key chain duplicates `docs/design/crypto.md`: delete. User part done in `user/`; Argon2id and the guess limit left for `admin/encryption.md`. |
| [ ] Vault keys | 216 | keep | `admin/encryption.md` | Cipher names duplicate `docs/design/`: delete. Users don't need key slots. |
| [ ] Creating an encrypted vault | 60 | keep | `user/encryption.md`; escrow default setting to `admin/encryption.md` | User part done in `user/`; escrow default setting left for `admin/encryption.md`. |
| [ ] Invitations | 252 | keep | `user/sharing.md` (how to invite to an encrypted vault) | Code format duplicates `docs/design/encryption.md`: delete after checking it is there. User part done in `user/`; code-format delete left. |
| [ ] Rotation | 302 | keep | `user/sharing.md` (what a removed member keeps); `admin/encryption.md` (epochs) | User part done in `user/`; epochs left for `admin/encryption.md`. |
| [ ] Re-encrypting history | 170 | keep | `admin/encryption.md`; one line to `user/encryption.md` | Rekey backlog alert links here. User part done in `user/`; admin part left. |
| [x] Converting a plaintext vault | 196 | keep | `user/encryption.md` | |
| [ ] Escrow | 344 | keep | `user/encryption.md` (what escrow means for you); `admin/encryption.md` | User part done in `user/`; admin part left. |
| [ ] For operators: the escrow key | 416 | keep | `admin/encryption.md` | |
| [ ] Losing your passphrase | 153 | keep | `user/encryption.md`; operator recovery steps to `admin/encryption.md` | User part done in `user/`; operator recovery steps left for `admin/encryption.md`. |
| [ ] Recovery with `age` | 272 | keep | `admin/encryption.md` (or `admin/backup-and-restore.md`, linked from both) | |
| [ ] Threat model | 30 | keep | `admin/security.md`; short user version in `user/encryption.md` | User part done in `user/`; admin part left. |
| [ ] A stolen copy of the database or the bucket | 144 | keep | `admin/security.md`; user version: "choose a long passphrase" | User part done in `user/`; admin part left. |
| [ ] An actively malicious server | 490 | keep | `admin/security.md` (≈150 W: what it can and can't do) | Mechanism duplicates `docs/design/encryption.md` "Protection against an active server": delete the mechanism here. |
| [ ] What encryption does not protect | 336 | keep | `admin/security.md`; `user/encryption.md` | Must stay visible to users. User part done in `user/`; admin part left. |

## docs/configuration.md → admin (9.9k W)

| Section | W | Class | Destination | Notes |
|---|---|---|---|---|
| [ ] Intro (env-only config, validation, exit status) | 88 | keep | `admin/configuration.md`; failure messages to `admin/troubleshooting.md` | The intro is in `admin/configuration.md`; the failure messages stay here for `admin/troubleshooting.md`. |
| [x] Environment variables (table) | 2,884 | generate | `admin/configuration-reference.md` (generated) | See Generators. Descriptions move into the constants' doc comments first; `admin/configuration.md` keeps only the grouped concepts below. |
| [ ] Authentication | 437 | keep | `admin/identity-provider.md`; token checks to `admin/security.md` | Provider requirements are in `admin/identity-provider.md`; the token checks stay here for `admin/security.md`. |
| [ ] Authorization | 1,004 | keep | `admin/security.md` (≈300 W) | Per-procedure role lists duplicate SPEC §9.2 and the proto comments: delete. |
| [ ] Blob storage | 404 | keep | `admin/postgresql-and-s3.md`; size and chunk limits to `admin/security.md` (limits) | The layout, permissions and cleanup are in `admin/postgresql-and-s3.md`; the size and chunk limits stay here for `admin/security.md`. |
| [ ] Revisions and the change feed | 539 | keep | `admin/postgresql-and-s3.md` (≈150 W: page size and response limits as settings) | Protocol detail duplicates SPEC §6.1: delete. Page sizes and response limits are in `admin/postgresql-and-s3.md`; the rest is left to delete. |
| [ ] Retention and history | 1,375 | keep | `admin/history-and-retention.md` (≈500 W) | Purge mechanics are developer depth (SPEC §11, `internal/retention`): delete here. |
| [ ] Per-vault overrides | — | keep | `admin/history-and-retention.md` | Subsection of the row above. |
| [ ] Realtime channel | 439 | keep | `admin/install.md` (ingress); limits to `admin/security.md` | The ingress needs are in `admin/install.md`; the limits stay here for `admin/security.md`. |
| [x] PostgreSQL TLS | 125 | keep | `admin/postgresql-and-s3.md` | Done: `admin/postgresql-and-s3.md`. |
| [ ] Endpoints | 138 | keep | `admin/configuration.md`; CORS and health detail to `admin/security.md`, `admin/monitoring.md` | The listeners are in `admin/configuration.md`; CORS and health detail stay here for `admin/security.md` and `admin/monitoring.md`. |
| [x] Metrics | 708 | generate | `admin/metrics-reference.md` (generated) | See Generators. `admin/monitoring.md` keeps the concepts (two ports, what to scrape). |
| [x] Service-wide metrics | 762 | generate | `admin/metrics-reference.md` (generated) | See Generators. Why service-wide metrics are separate (one exporter, not per replica) stays in `admin/monitoring.md`. The table is generated; the paragraph on how the values are refreshed stays in `configuration.md` until `admin/monitoring.md` is written. |
| [ ] Startup and shutdown | 471 | keep | `admin/requirements.md` (PostgreSQL 14+); `admin/upgrades.md` (migrations, graceful shutdown); `admin/troubleshooting.md` | Done for `admin/requirements.md` and `admin/upgrades.md`; the failure facts stay here for `admin/troubleshooting.md`. |
| [x] High-availability deployment | 453 | keep | `admin/upgrades.md` (rolling upgrades, HA) | Design detail duplicates SPEC §12 HA rules: delete. Done: `admin/upgrades.md`. |

## docs/deployment.md → admin (6.7k W)

| Section | W | Class | Destination | Notes |
|---|---|---|---|---|
| [x] Intro and "What you deploy" | 208 | keep | `admin/install.md`; reference setup to `admin/requirements.md` | Done: `admin/install.md`, `admin/requirements.md`. |
| [x] The image | 82 | keep | `admin/install.md` | Done: `admin/install.md`. |
| [x] PostgreSQL (CloudNativePG) | 323 | keep | `admin/postgresql-and-s3.md` | Done: `admin/postgresql-and-s3.md`. |
| [x] S3 (Ceph RGW) | 204 | keep | `admin/postgresql-and-s3.md` | Done: `admin/postgresql-and-s3.md`. |
| [x] Authentik (the device-flow application) | 259 | keep | `admin/identity-provider.md` | Merge with `plugin.md` "Identity provider setup". Done: `admin/identity-provider.md`. |
| [ ] The WAF body limit (Istio and Coraza) | 310 | keep | `admin/install.md`; limit relationship to `admin/security.md` | The ingress part is in `admin/install.md`; the limit relationship stays here for `admin/security.md`. |
| [ ] The export job | 546 | keep | `admin/backup-and-restore.md` | Chart wiring duplicates the chart values: delete. |
| [x] Installing the chart | 220 | keep | `admin/install.md` | Done: `admin/install.md`. |
| [x] Upgrading | 681 | keep | `admin/upgrades.md` | Done: `admin/upgrades.md`. |
| [ ] Per-vault retention | 139 | keep | `admin/history-and-retention.md` | Merge with `configuration.md` "Per-vault overrides" (duplicate). |
| [ ] Undeleting a vault | 128 | keep | `admin/backup-and-restore.md`; one line in `user/sharing.md` (ask your admin) | |
| [ ] Chart values (and Shared settings, PostgreSQL, S3, OIDC, Server, Export, Route, Grafana dashboards, Alerts, Overriding the computed resources) | 2,254 | generate | `admin/chart-values.md` (generated by `helm-docs`) | See Generators. Per-value text moves into `values.yaml` `# --` comments. "Overriding the computed resources" (323 W) explains a concept: keep ≈150 W of it in `admin/install.md` (sizing). |
| [x] High availability | 117 | delete | — | Duplicate of `configuration.md` "High-availability deployment", which lands in `admin/upgrades.md`. Done: every fact is in `admin/upgrades.md`. |
| [ ] Monitoring | 440 | keep | `admin/monitoring.md` | |
| [x] Releasing | 707 | keep | `dev/releasing.md` (≈400 W) | Developer content, not admin. Steps that restate `make release` and the release-manager playbook: delete; link them. |

## docs/export.md → admin (+ user) (3.9k W)

| Section | W | Class | Destination | Notes |
|---|---|---|---|---|
| [ ] Intro | 129 | keep | `admin/backup-and-restore.md`; user summary in `user/getting-your-notes-out.md` | User part done in `user/`; admin part left. |
| [ ] Flags | 35 | keep | `admin/backup-and-restore.md` | |
| [ ] Environment variables | 280 | generate | `admin/configuration-reference.md` (generated, export section) | The export's variables are `internal/config` constants too; one generator covers both. |
| [ ] What an export contains | 429 | keep | `admin/backup-and-restore.md`; user summary in `user/getting-your-notes-out.md` | User part done in `user/`; admin part left. |
| [ ] Output layout | 268 | keep | `admin/backup-and-restore.md` | |
| [ ] End-to-end encrypted vaults | 258 | keep | `admin/backup-and-restore.md`; links `admin/encryption.md` | |
| [ ] Documents that cannot be placed at their path | 168 | keep | `admin/backup-and-restore.md` | |
| [ ] Manifest | 499 | move | `admin/backup-and-restore.md` (≈100 W: that it exists and what it is for) | Field-by-field format moves to the `internal/export` manifest type's doc comments (pinned by `internal/export/export_test.go`). |
| [ ] Atomic replacement | 408 | move | `admin/backup-and-restore.md` (one paragraph: a failed run never leaves a half-written tree) | Mechanism moves to the `internal/export` package doc. |
| [ ] Path safety | 164 | move | `admin/security.md` (one line) | Mechanism moves to `internal/export` comments (pinned by `internal/export/export_test.go`, `helpers_test.go`). |
| [ ] Summary and exit status | 521 | keep | `admin/backup-and-restore.md` (≈250 W) | Log field lists restate code: delete. |
| [ ] Rotating the escrow key | 696 | keep | `admin/encryption.md` | |
| [ ] Signals | 26 | keep | `admin/backup-and-restore.md` | |

## docs/import.md → admin (+ user) (1.5k W)

| Section | W | Class | Destination | Notes |
|---|---|---|---|---|
| [ ] Intro | 236 | keep | `admin/backup-and-restore.md`; user line in `user/faq.md` (moving notes in) | User part done in `user/`; admin part left. |
| [ ] What it imports | 127 | keep | `admin/backup-and-restore.md` | |
| [ ] Importing into an end-to-end encrypted vault | 314 | keep | `admin/backup-and-restore.md`; links `admin/encryption.md` | |
| [ ] Verification against the server | 187 | move | `admin/backup-and-restore.md` (one line) | Mechanism already in `docs/design/encryption.md` "Import": delete here. |
| [ ] With the escrow identity | 327 | keep | `admin/backup-and-restore.md` | |
| [ ] What it skips | 165 | keep | `admin/backup-and-restore.md` | |
| [ ] Report and exit status | 128 | keep | `admin/backup-and-restore.md` | |

## docs/alerts.md → admin (1.7k W)

| Section | W | Class | Destination | Notes |
|---|---|---|---|---|
| [x] Intro | 250 | keep | `admin/alerts.md` (≈100 W) | How the rules are wired into the chart duplicates the chart values: delete. That every alert is unit-tested with `promtool test rules` (`make chart-lint`) is developer depth: it stays in the `scripts/chart_test.sh` header. |
| [x] Availability (VaultSyncNoReplicaReady, VaultSyncReplicasUnavailable, VaultSyncRPCErrorRatioHigh, VaultSyncSyncLatencyHigh, VaultSyncRealtimeListenerDown, VaultSyncConcurrencyRejections, VaultSyncRealtimeRefusals) | 578 | keep | `admin/alerts.md` | Keep every `### AlertName` heading verbatim (machine-read; runbook anchors). Don't repeat the expression; it is in `alerts/vault-sync.rules.yaml`. |
| [x] Dependencies (VaultSyncDatabasePoolExhausted, VaultSyncS3ErrorRatioHigh, VaultSyncOIDCKeyRefreshFailing) | 239 | keep | `admin/alerts.md` | same |
| [x] Data safety and backlog (VaultSyncRetentionNotSucceeding, VaultSyncExportNotSucceeding, VaultSyncUploadSessionsNotExpiring, VaultSyncBlobGCStalled, VaultSyncRekeyBacklogNotShrinking, VaultSyncEscrowRewrapStuck, VaultSyncServiceMetricsStale) | 618 | keep | `admin/alerts.md` | same |
| [x] Stub | — | keep | `alerts.md` keeps one heading per alert linking to `admin/alerts.md#…` for one release | See redirects in `docs/README.md`. |

## docs/design/ (stays; developer and agent reference; 20.8k W → target 19k)

All sections stay and keep their rules: the engine design is fixed. The developer docs rewrite adds a reader line ("For: developers and agents…") and links from `dev/README.md`. The reasons for a rule stay (design docs are where reasons live). Issue numbers and rejected alternatives that no longer explain a current rule are a delete. Do not renumber `engine.md` sections; code and tests cite them. Files: `engine.md` (§1–§12), `engine-situations.md` (§1–§11, Count), `sharing.md`, `encryption.md`, `crypto.md`.

| Section | W | Class | Destination | Notes |
|---|---|---|---|---|
| [x] `design/engine.md` (all) | 3,914 | keep | stays | Owner-fixed. Delete only issue numbers. |
| [x] `design/engine.md` §10 Status and user interface | — | keep | stays; user view to `user/syncing.md` | User view done in `user/syncing.md`. Done: the page has the reader line and no issue numbers. |
| [x] `design/engine-situations.md` (all) | 5,128 | keep | stays | Each situation has a decision-table test; the situations stay because they explain the rows. Delete only issue numbers. |
| [x] `design/sharing.md` Roles, Losing access, Deleting a vault | 684 (file) | keep | stays; user view to `user/sharing.md` | User view done in `user/sharing.md`. Done: the page has the reader line and no issue numbers. |
| [x] `design/encryption.md` Escrow, Protection against an active server | — | keep | stays; operator view in `admin/encryption.md`, `admin/security.md` | Design page done: reader line, no issue numbers. The operator pages are part of the admin rewrite. |
| [x] `design/encryption.md` Formats and rules settled during implementation | 800 | move | byte formats pinned by `testdata/crypto/vectors.json` and described in `design/crypto.md` | Delete the duplicates; move what remains to `design/crypto.md`. Done: the formats that remained (the invitation code, the passphrase rule) moved to `crypto.md`. The other bullets are design rules, not formats, so they stay in `encryption.md` under the heading *Rules for contents, invitations and escrow*. `SPEC.md` and `plugin/src/core/sync/codec.ts` cite the new heading. |
| [x] `design/encryption.md` Interaction matrix | 1,128 | keep | stays | Design-review artefact the design reviewer reads. |
| [x] `design/encryption.md` Documentation | — | keep | stays | Says which user docs must exist; update its links to the new paths. Done: it names `user/encryption.md` for users and `docs/encryption.md` for operators until `admin/encryption.md` exists. |
| [x] `design/crypto.md` (all) | 4,592 | keep | stays | Parameters and formats stay (developer depth); vectors are the contract, so prose that only restates a vector's bytes is a delete. Target ≈3,500. Done at about 4,200 (from 4,834): the vector list and the escrow-chain rules that repeated `encryption.md` are cut. The rest is rules and parameters, and cutting it would lose facts. |
| [x] every other design section | — | keep | stays | |

## docs/testing/ (stays; developer; 13.9k W → target 6k)

| Section | W | Class | Destination | Notes |
|---|---|---|---|---|
| [x] `acceptance.md` (all sections) | 864 | keep | stays; linked from `dev/README.md` | Done: reader line added, content unchanged. |
| [x] `integration.md` (all sections) | 1,507 | keep | stays (≈900 W); linked from `dev/README.md` | Per-test lists restate the test files: delete. |
| [x] `e2e.md` "How it fits together" | 5,026 | move | stays (≈1,500 W: the parts, how to run, how to debug) | Step-by-step harness internals move to comments in `plugin/test/e2e/` (the wdio config and helpers) and `scripts/`; descriptions of individual specs are a delete (the spec names say it). Done: the spec descriptions are deleted. The harness facts a test writer needs (driver, configuration, harness plugin, two devices, helpers) stay as a short list in `e2e.md`, not as code comments, because they span several files. |
| [x] `e2e.md` Platforms, Android emulator job | 1,000 | keep | stays (≈500 W) | CI job detail restates `.github/workflows/`: delete. |
| [x] `e2e.md` "Real Android app on an emulator (spike, #187)" | 984 | delete | — | A finished spike: history. Keep any instruction still used, as one paragraph under the Android job, without the issue number. Done: the still-used facts (the APK hash check, `adb reverse` and airplane mode, Appium's numeric `status`) are in "Android emulator job" and "Writing e2e tests". `SPEC.md` §13 now cites the job, not the spike. |
| [x] `android.md` (all sections) | 3,267 | keep | stays (≈1,500 W); linked from `dev/releasing.md` | Manual release checklist; cut repeated setup steps. Done: each section's automated rows became one line naming the covered behaviour and the test files. The manual rows stay whole. |
| [x] `proto-compatibility.md` (all sections) | 800 | keep | stays (≈500 W) | `buf.yaml` cites it. The breaking-change rules `buf breaking` enforces: delete; keep why and what to do on a failure. |

## docs/acceptance/ (stays; owner)

| Section | W | Class | Destination | Notes |
|---|---|---|---|---|
| [ ] `phase-2.md`, `phase-3.md`, `phase-4.md` (all sections) | 2,243 | keep | stay | Owner-facing; scripts parse the scenario ids. Only the owner changes scenarios. Plain-English edits must not change any `[AC-nn]`/`[P3-nn]`/`[P4-nn]` id or meaning. |

## Projected words per new page

Rough sizes to plan the rewrite (`docs/README.md`, "Size"). They are guidance, not limits: clarity for the page's reader wins over the number.

| User page | Target | Admin page | Target | Developer page | Target |
|---|---|---|---|---|---|
| `getting-started.md` | 1,200 | `requirements.md` | 500 | `README.md` | 400 |
| `syncing.md` | 1,000 | `install.md` | 1,100 | `architecture.md` | 1,500 |
| `conflicts-and-history.md` | 1,100 | `configuration.md` | 500 | `building.md` | 600 |
| `sharing.md` | 900 | `identity-provider.md` | 600 | `protocol.md` | 1,200 |
| `encryption.md` | 1,200 | `postgresql-and-s3.md` | 800 | `contributing.md` | 800 |
| `devices.md` | 350 | `backup-and-restore.md` | 1,900 | `releasing.md` | 400 |
| `getting-your-notes-out.md` | 300 | `encryption.md` | 1,400 | `decisions.md` | 1,200 |
| `troubleshooting.md` | 800 | `history-and-retention.md` | 600 | `glossary.md` | 500 |
| `faq.md` | 450 | `monitoring.md` | 500 | | |
| `glossary.md` | 400 | `alerts.md` | 1,300 | | |
| | | `upgrades.md` | 900 | | |
| | | `security.md` | 1,000 | | |
| | | `troubleshooting.md` | 500 | | |
| | | `glossary.md` | 300 | | |
| **Total** | **7,700** | **Total** (generated pages excluded) | **11,900** | **Total** (plus SPEC 6,800 rounded to 7,000: 13,600) | **6,600** |

Design and testing targets are in their sections above (`docs/design/` ≈19k, `docs/testing/` ≈5.8k). Agent files: 11,900 today against 10,000; the cut is not owned by any rewrite issue yet (see the PR handoff).

## New pages with no current source

These have no section today; the rewrite writes them from the sources above:

- `user/troubleshooting.md`, `user/faq.md`, `user/glossary.md`, `user/getting-your-notes-out.md`;
- `admin/requirements.md` (from SPEC §3, configuration "Startup and shutdown", deployment intro), `admin/troubleshooting.md`, `admin/glossary.md`, `admin/security.md` (assembled from the rows above), and the generated `admin/configuration-reference.md` and `admin/metrics-reference.md`;
- `dev/README.md`, `dev/architecture.md`, `dev/protocol.md`, `dev/contributing.md` (from `CLAUDE.md` workflow rules that also apply to humans), `dev/decisions.md` (the list in "Decisions that still bind"), `dev/glossary.md`.
