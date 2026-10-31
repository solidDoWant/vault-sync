# Changelog

All notable changes to vault-sync are listed here, newest release first.

## 0.4.3

vault-sync is a self-hosted replacement for Obsidian Sync. It has two parts: an Obsidian plugin, and a sync server that stores its data in PostgreSQL and S3. This release makes escrow safer. Escrow lets the admin's backup read an encrypted vault. Your devices now remember the escrow key of the server, and they show you its fingerprint. A fingerprint is a short code that identifies a key. If the escrow key changes without a signature from the old key, the plugin asks you before it uses the new key. The release also rewrites the documentation in plain English, with separate pages for users, admins and developers. It also fixes one sync defect with folder renames. To install it, use the server image `ghcr.io/soliddowant/vault-sync:0.4.3` or the Helm chart `oci://ghcr.io/soliddowant/charts/vault-sync` (version 0.4.3). Install the plugin with BRAT from the GitHub releases of this repository. You can upgrade a 0.4.2 server one replica at a time. Upgrade the server before the plugin.

### Upgrade notes for admins

- Remove `config.export.escrow.signingKeysKey` from your Helm values before you upgrade the chart. The chart no longer has this value, and the chart refuses to render when it is set. The escrow signing key must stay offline, not in a Secret on the cluster. Devices trust a new escrow key only when the old signing key signed the change, so a signing key on the cluster gives less protection. The chart now also refuses to render when a controller gets `VAULT_SYNC_ESCROW_SIGNING_KEY_FILE` or runs `export rotate-escrow`. Run a rotation from your own machine or as a one-off pod. The admin guide gives the commands for both. ([#1419](https://github.com/solidDoWant/vault-sync/pull/1419))
- Upgrade every server replica and the plugin on every device to 0.4.3 before you run `export reset-escrow`. A 0.4.2 server does not start on an escrow chain with a reset point. A 0.4.2 plugin cannot read the membership log of a vault after an owner accepts a reset. ([#1442](https://github.com/solidDoWant/vault-sync/pull/1442), [#1454](https://github.com/solidDoWant/vault-sync/pull/1454))
- The new migration 0029 adds one column to the escrow chain table and replaces one check on it. A 0.4.2 replica keeps working during the rollout.

### Security

- The plugin shows the escrow fingerprint under the **Escrow** toggle when you create a vault, and in the **Fingerprints** line of the **Sharing** section of a vault with escrow. Your device remembers the escrow key that it saw first on the server, and shows the fingerprint of that key. Compare it with the fingerprint that your admin publishes before you turn on escrow. ([#1429](https://github.com/solidDoWant/vault-sync/pull/1429))
- Admins print the escrow fingerprint with the new command `vault-sync-server escrow fingerprint`. The command needs no database, no network and no private key. ([#1420](https://github.com/solidDoWant/vault-sync/pull/1420))
- If the escrow key changes and the old key did not sign the change, the plugin opens the window **The server's escrow key changed**. The window shows the previous and the new fingerprint. To accept, you type the last four characters of the new fingerprint. If you decline, escrow keeps the previous key and your notes keep syncing. You cannot create a vault with escrow until you accept. ([#1433](https://github.com/solidDoWant/vault-sync/pull/1433))
- When an owner accepts a new escrow key, the device of the owner moves each vault that the owner owns to the new key at its next sync. Other members see the notice "An owner of this vault accepted a new escrow key", with the name of the owner and both fingerprints. ([#1456](https://github.com/solidDoWant/vault-sync/pull/1456), [#1454](https://github.com/solidDoWant/vault-sync/pull/1454))
- Admins can start the escrow chain again from a new key with the new command `vault-sync-server export reset-escrow`. Use it only when you lost the old signing key, or when somebody stole it. Devices do not accept a reset on their own: each user must accept it in the plugin. ([#1442](https://github.com/solidDoWant/vault-sync/pull/1442))

### Server and deployment

- The documentation has new pages for each reader. The user guide is in `docs/user/`, the admin guide is in `docs/admin/`, and the developer pages are in `docs/dev/`. The admin guide adds pages for install, backup and restore, encryption, history and retention, monitoring, security and troubleshooting, and a glossary. The metrics reference, the configuration reference and the chart values page are now made from the code, so they always match the release. The old pages, for example `docs/deployment.md`, now only link to the new pages. ([#1424](https://github.com/solidDoWant/vault-sync/pull/1424), [#1425](https://github.com/solidDoWant/vault-sync/pull/1425), [#1426](https://github.com/solidDoWant/vault-sync/pull/1426), [#1427](https://github.com/solidDoWant/vault-sync/pull/1427), [#1431](https://github.com/solidDoWant/vault-sync/pull/1431), [#1436](https://github.com/solidDoWant/vault-sync/pull/1436), [#1448](https://github.com/solidDoWant/vault-sync/pull/1448), [#1451](https://github.com/solidDoWant/vault-sync/pull/1451), [#1452](https://github.com/solidDoWant/vault-sync/pull/1452), [#1453](https://github.com/solidDoWant/vault-sync/pull/1453), [#1455](https://github.com/solidDoWant/vault-sync/pull/1455), [#1459](https://github.com/solidDoWant/vault-sync/pull/1459))
- The links to the alert runbooks in the chart's alerting rules point to the new page `docs/admin/alerts.md`. ([#1424](https://github.com/solidDoWant/vault-sync/pull/1424))
- `SPEC.md` is rewritten in plain English. No rule of sync, storage or encryption changed. ([#1457](https://github.com/solidDoWant/vault-sync/pull/1457), [#1460](https://github.com/solidDoWant/vault-sync/pull/1460), [#1461](https://github.com/solidDoWant/vault-sync/pull/1461), [#1462](https://github.com/solidDoWant/vault-sync/pull/1462), [#1463](https://github.com/solidDoWant/vault-sync/pull/1463), [#1464](https://github.com/solidDoWant/vault-sync/pull/1464), [#1465](https://github.com/solidDoWant/vault-sync/pull/1465))

### Fixes

- A folder rename no longer leaves the old folder behind. Before, a device sometimes received the rename of a folder before the moves of the files in it. Then that device kept the old folder and sent it back to the server, so every device had both folders. Now the old folder goes away when its last file moves out. ([#1443](https://github.com/solidDoWant/vault-sync/pull/1443))

Internal work: CI checks the links in the documentation and checks that the generated reference pages are current, `make lint` reports every failure at once, an end-to-end test covers the escrow reset, the design pages were shortened, and the agent instructions were updated ([#1421](https://github.com/solidDoWant/vault-sync/pull/1421), [#1422](https://github.com/solidDoWant/vault-sync/pull/1422), [#1428](https://github.com/solidDoWant/vault-sync/pull/1428), [#1432](https://github.com/solidDoWant/vault-sync/pull/1432), [#1435](https://github.com/solidDoWant/vault-sync/pull/1435), [#1437](https://github.com/solidDoWant/vault-sync/pull/1437), [#1441](https://github.com/solidDoWant/vault-sync/pull/1441), [#1444](https://github.com/solidDoWant/vault-sync/pull/1444), [#1445](https://github.com/solidDoWant/vault-sync/pull/1445), [#1446](https://github.com/solidDoWant/vault-sync/pull/1446), [#1447](https://github.com/solidDoWant/vault-sync/pull/1447), [#1449](https://github.com/solidDoWant/vault-sync/pull/1449), [#1450](https://github.com/solidDoWant/vault-sync/pull/1450), [#1458](https://github.com/solidDoWant/vault-sync/pull/1458), [#1459](https://github.com/solidDoWant/vault-sync/pull/1459)).

### Known issues

- None known. No bug is open, and no item of this release was deferred.

## 0.4.2

vault-sync is a self-hosted replacement for Obsidian Sync. It has two parts: an Obsidian plugin, and a sync server that stores its data in PostgreSQL and S3. This release changes only the plugin. When two devices change the same file, the plugin can now combine more kinds of files: Obsidian Bases (`.base`) files, canvases, JSON files and plain-text files. The server, the protocol and the stored data did not change. To install it, use the server image `ghcr.io/soliddowant/vault-sync:0.4.2` or the Helm chart `oci://ghcr.io/soliddowant/charts/vault-sync` (version 0.4.2). Install the plugin with BRAT from the GitHub releases of this repository. If you run 0.4.1, you do not have to upgrade the server. You can upgrade a 0.4.1 server one replica at a time.

### Conflicts and history

- Obsidian Bases (`.base`) files merge. A merge combines the edits that two devices made to one file, so you get no conflict copy. Edits to different views, formulas or properties combine. Filter conditions that either device added or removed all apply. Before the plugin writes a merged base, it makes sure that the result is a valid Bases file. A merged base is written again as plain YAML in the same key order, so comments in it are lost. If only one device changed the base, the plugin keeps that version exactly, comments included. ([#1400](https://github.com/solidDoWant/vault-sync/pull/1400))
- Canvas (`.canvas`) files merge card by card and connection by connection. If two devices add cards, the canvas keeps all of them. If one device moves a card and the other device changes its color, the canvas gets both changes. ([#1409](https://github.com/solidDoWant/vault-sync/pull/1409))
- JSON (`.json`) files merge key by key. A list is one value, so two different changes to the same list are a conflict. ([#1409](https://github.com/solidDoWant/vault-sync/pull/1409))
- Plain-text files up to 1 MiB merge line by line, as notes do. This applies to `.txt`, `.csv`, `.tsv`, `.css`, `.js`, `.ts`, `.py`, `.sh`, `.html`, `.xml`, `.tex`, `.org`, `.rst`, `.yaml`, `.yml` and `.toml` files. Edits to the same line or to lines next to each other do not merge. ([#1409](https://github.com/solidDoWant/vault-sync/pull/1409))
- No edit is lost when a merge is not possible. In each of these cases, the plugin does what it did before: the newer version stays at the path, and the other version becomes a conflict copy next to it:
  - The two devices made changes that conflict. For example, both devices moved the same card, or both changed the limit of the same view.
  - One device deleted something that the other device changed or used. For example, one device deleted a card that the other device connected.
  - A version or the merged result does not parse or is not valid. For example, a base uses newer Bases syntax, or a merged YAML file is not valid YAML.
  - A device reordered the cards of a canvas, for example to bring a card to the front.

  The plugin never writes conflict markers into a file. `docs/plugin.md` describes the rules for each type of file. ([#1400](https://github.com/solidDoWant/vault-sync/pull/1400), [#1409](https://github.com/solidDoWant/vault-sync/pull/1409))

Internal work: the documentation now has one page set for each type of reader (users, admins and developers), and the agent instructions require plain English for text that people read ([#1407](https://github.com/solidDoWant/vault-sync/pull/1407), [#1408](https://github.com/solidDoWant/vault-sync/pull/1408)).

### Known issues

- None known. No bug is open, and no item of this release was deferred.

## 0.4.1

vault-sync is a self-hosted replacement for Obsidian Sync: an Obsidian plugin and a sync server backed by PostgreSQL and S3. This is a maintenance release after 0.4.0. It reworks the Helm chart, which is a **breaking change for anyone who deploys with the chart**, so read the first section before you upgrade. It also adds device renaming, metrics that cover the whole deployment, Grafana dashboards and Prometheus alerting rules, a tidier settings tab, and dependency updates. Sync behaviour, the protocol and the stored data are unchanged. Install the server from the image `ghcr.io/soliddowant/vault-sync:0.4.1` or the Helm chart `oci://ghcr.io/soliddowant/charts/vault-sync` (version 0.4.1), and the plugin with BRAT from this repository's GitHub releases. A 0.4.0 deployment can be upgraded replica by replica. Upgrade the server before the plugin.

### BREAKING (Helm chart)

The Helm chart was reworked so that it renders only what the server needs to run correctly and sets no policy you can't cleanly replace. **Before you upgrade a chart release, render the new chart with your values (`helm template` or `helm diff upgrade`) and compare the result with what runs now: several defaults changed, and values the new schema doesn't know now fail the install.** ([#1378](https://github.com/solidDoWant/vault-sync/pull/1378), [#1390](https://github.com/solidDoWant/vault-sync/pull/1390))

- **Every resource is renamed.** Resources are now named after the release, never with the chart name twice: a release `obsidian-vault-sync` gets the Deployment, Service, ServiceAccount, ServiceMonitor and HTTPRoute `obsidian-vault-sync` and the CronJob `obsidian-vault-sync-export` (previously `<release>-vault-sync-main` and so on). Upgrading therefore replaces the Deployment and the Service: expect the server's pods to be recreated, and point anything that names the old Service (an Ingress, a scrape config, a NetworkPolicy) at the new name. The identifiers under `resources` (`main`, `export`) are unchanged, so overrides keep working.
- **One Service.** The separate `metrics` Service is merged into the main Service, which now has ports `http` (8080, primary), `metrics` (9090) and `service-metrics` (9091). A plain `resources.ingress` or route now resolves its backend to port `http` without naming a Service. Only port `http` may be routed to from outside the cluster.
- **No PodDisruptionBudget and no default container resources** (and no topology spread constraint). The chart no longer creates a PodDisruptionBudget or sets CPU and memory requests and limits. If you relied on them, set them under `resources.controllers.<main|export>`; `docs/deployment.md` has examples and the previous values as a starting point.
- **The export job is off by default** (`config.export.enabled: false`). Set it to `true` to keep your plaintext disaster-recovery copy; we recommend it.
- **The ServiceMonitor is off by default and opt-in** (`config.server.metrics.serviceMonitor.enabled: false`), so installs no longer fail on clusters without the prometheus-operator CRDs. Turn it on to keep scraping; it now selects the main Service.
- **A strict values schema.** A `values.schema.json` checks `config`: unknown keys, wrong types and malformed durations now fail the install instead of being silently ignored. Optional settings default to `null` instead of `""` and take typed values: integers for sizes and counts (`maxRequestBytes: 1048576`, not `"1048576"`), booleans for switches (`forcePathStyle: false`), and Go duration strings (`30s`) for durations.
- **HTTPRoute support:** `config.route` (`enabled`, `hostnames`, `parentRefs`, `annotations`, `labels`) renders a Gateway API HTTPRoute to port `http` with timeouts suited to the API: 15 minutes for requests (an upload commit may take up to 10 minutes) and none for the `/v1/realtime` WebSocket.

### Devices and sign-in

- Rename a device after it is registered: while you are signed in, changing **Device name** in the plugin's settings renames this device on the server about a second after you stop typing. The device list shows the new name, and the device keeps its id and its history. If the rename fails, a notice says so and the setting goes back to the last name the server accepted. Rename devices only once every server replica runs 0.4.1: older replicas answer the rename with an error. ([#1380](https://github.com/solidDoWant/vault-sync/pull/1380), [#1389](https://github.com/solidDoWant/vault-sync/pull/1389))
- The settings tab is laid out in setup order: Sync status first, then Server, Account, and, while signed in, End-to-end encryption, Remote vault, Sharing and Devices. Settings you rarely need (the OIDC issuer URL and client ID, and an owner's **Rotate key** and **Re-encrypt history** for an encrypted vault) move to a collapsed **Advanced** group at the bottom, which remembers whether you left it open. Every control works as before. ([#1396](https://github.com/solidDoWant/vault-sync/pull/1396))

### Server and deployment

- **Service-wide metrics on their own port.** The server serves metrics about the whole deployment (counts of devices, users with devices, vaults, memberships, documents and stored blobs, upload, garbage-collection and end-to-end-encryption backlogs, and when retention and the export last succeeded) on a third port, `VAULT_SYNC_SERVICE_METRICS_LISTEN_ADDRESS` (default `:9091`), named `vault_sync_service_*` and with no per-user, per-vault or per-device label. Each replica refreshes them from PostgreSQL in the background every `VAULT_SYNC_SERVICE_METRICS_INTERVAL` (default `1m`), so a scrape never queries the database. Don't expose this port to the internet. The new migration 0028 only adds the two tables that record the last retention and export runs. ([#1387](https://github.com/solidDoWant/vault-sync/pull/1387), [#1391](https://github.com/solidDoWant/vault-sync/pull/1391), [#1392](https://github.com/solidDoWant/vault-sync/pull/1392))
- **ServiceMonitor endpoint for the service-wide metrics:** with `config.server.metrics.serviceMonitor.enabled` and `config.server.metrics.serviceWide.enabled`, the chart's ServiceMonitor also scrapes port `service-metrics`. ([#1390](https://github.com/solidDoWant/vault-sync/pull/1390))
- **Per-replica dependency metrics:** PostgreSQL connection pool use and wait times, S3 requests and their latency by operation and outcome, the age of the OIDC signing keys and failed refreshes of them, and blob bytes uploaded and downloaded, on the existing metrics port. ([#1388](https://github.com/solidDoWant/vault-sync/pull/1388))
- **Grafana dashboards** ship with the chart: Overview, Server and Dependencies. The chart renders them as grafana-operator `GrafanaDashboard`s (`config.grafana.dashboards.enabled`) or as ConfigMaps for the Grafana chart's dashboard sidecar (`config.grafana.dashboards.configMaps.enabled`); both are off by default. ([#1394](https://github.com/solidDoWant/vault-sync/pull/1394))
- **Alerting rules:** the chart can render a prometheus-operator `PrometheusRule` (`config.alerts.prometheusRule.enabled`, off by default) covering availability (server errors, slow syncs, the realtime listener, limit rejections, optional kube-state-metrics replica alerts), dependencies (PostgreSQL pool, S3 errors, OIDC key refresh) and data safety (retention, export, upload and garbage-collection backlogs, re-key and escrow re-wrap progress, stale service-wide metrics). Each alert can be turned off or have its `for`, severity and threshold overridden under `config.alerts.rules`, and links to its runbook in `docs/alerts.md`. The service-wide alerts need the service-wide metrics to be scraped. ([#1395](https://github.com/solidDoWant/vault-sync/pull/1395))

### Dependency updates

- Updated the AWS SDK for Go (S3), ConnectRPC for the plugin, the pinned Nix packages (Go toolchain and tools), and the plugin's npm dependencies. The bech32 encoding of age keys now comes from btcd's `address/v2` instead of the retired btcutil package; key formats are unchanged and the shared crypto test vectors pass. ([#1381](https://github.com/solidDoWant/vault-sync/pull/1381))

Internal work: CI actions moved to new major versions and pinned by digest, test database images updated, and the agent scheduler routes dependency-update PRs ([#1381](https://github.com/solidDoWant/vault-sync/pull/1381), [#1393](https://github.com/solidDoWant/vault-sync/pull/1393)).

### Known issues

- None known: no bug is open, and no item of this release was deferred.

## 0.4.0

vault-sync is a self-hosted replacement for Obsidian Sync: an Obsidian plugin and a sync server backed by PostgreSQL and S3. This release adds end-to-end encryption (Phase 4). A vault can now be encrypted on your devices so that the server stores only ciphertext for its notes, attachments and file names, shared with other members through invitations and protected against a server that tries to slip in keys or members. [How encryption works](https://github.com/solidDoWant/vault-sync/blob/0.4.0/docs/encryption.md) explains what it protects and what it doesn't. Install the server from the image `ghcr.io/soliddowant/vault-sync:0.4.0` or the Helm chart `oci://ghcr.io/soliddowant/charts/vault-sync` (version 0.4.0), and the plugin with BRAT from this repository's GitHub releases. A 0.3.0 deployment can be upgraded replica by replica.

### Sync

- Encrypted vaults sync exactly like plaintext ones: edits, merges, conflict copies, renames, deletes and history all work the same way. ([#1267](https://github.com/solidDoWant/vault-sync/pull/1267), [#1259](https://github.com/solidDoWant/vault-sync/pull/1259))
- New file and folder names may only use characters from Unicode 15.0, so every device treats the same name the same way. ([#1253](https://github.com/solidDoWant/vault-sync/pull/1253))

### Sharing

- Invite people to an encrypted vault with the same one-time code as before. The invitee can read the whole vault, history included, without any other member being online. A revoked or expired code grants nothing. ([#1274](https://github.com/solidDoWant/vault-sync/pull/1274), [#1303](https://github.com/solidDoWant/vault-sync/pull/1303), [#1320](https://github.com/solidDoWant/vault-sync/pull/1320))
- Removing a member from an encrypted vault switches the vault to a new key, so the removed member can't read anything committed afterwards. An owner can also switch to a new key at any time. Other devices pick it up on their next sync, and changes sent under the old key are retried and land. ([#1317](https://github.com/solidDoWant/vault-sync/pull/1317), [#1321](https://github.com/solidDoWant/vault-sync/pull/1321))
- Re-encrypt a vault's history under its newest key and retire the old keys. The job can be interrupted and resumed, and you can keep editing while it runs. ([#1334](https://github.com/solidDoWant/vault-sync/pull/1334), [#1339](https://github.com/solidDoWant/vault-sync/pull/1339), [#1341](https://github.com/solidDoWant/vault-sync/pull/1341))
- Convert an existing plaintext vault to an encrypted one in place, keeping its history and its members. Every member needs an encryption key first, and the owner compares their key fingerprints before the switch. History is then re-encrypted. ([#1335](https://github.com/solidDoWant/vault-sync/pull/1335), [#1340](https://github.com/solidDoWant/vault-sync/pull/1340), [#1343](https://github.com/solidDoWant/vault-sync/pull/1343))

### Devices and sign-in

- Unlock an encrypted vault on another device with your recovery passphrase. A wrong passphrase is refused, and repeated wrong attempts are slowed down. Unlocking takes a few seconds even on a phone. ([#1218](https://github.com/solidDoWant/vault-sync/pull/1218))
- Change your recovery passphrase. Devices that are already unlocked keep working, and the settings explain what to do if you lose it. ([#1245](https://github.com/solidDoWant/vault-sync/pull/1245))
- Your private key and the vault keys are kept in Obsidian's local storage on each device, not in the vault's files. ([#1260](https://github.com/solidDoWant/vault-sync/pull/1260))

### Server and deployment

- Escrow: an operator can give the deployment an escrow key (`VAULT_SYNC_ESCROW_RECIPIENT` and `VAULT_SYNC_ESCROW_SIGNING_KEY`), so that encrypted vaults can be recovered and exported. New encrypted vaults use escrow unless their owner turns it off or the operator changes the default (`VAULT_SYNC_ESCROW_DEFAULT`). ([#1233](https://github.com/solidDoWant/vault-sync/pull/1233), [#1289](https://github.com/solidDoWant/vault-sync/pull/1289), [#1301](https://github.com/solidDoWant/vault-sync/pull/1301))
- `vault-sync-server export` decrypts escrowed vaults with the escrow identity. A vault without escrow is skipped and reported. ([#1268](https://github.com/solidDoWant/vault-sync/pull/1268))
- `vault-sync-server export rotate-escrow` moves every escrowed vault, including vaults deleted in the last 30 days, to a new escrow key, after which the old key can be retired. An escrow key slot also opens with the standard `age` tool, for recovery without vault-sync. ([#1304](https://github.com/solidDoWant/vault-sync/pull/1304), [#1307](https://github.com/solidDoWant/vault-sync/pull/1307))
- `vault-sync-server import` now signs in as you and uploads through the server's API instead of opening the database and S3. It imports into encrypted vaults too, with the escrow identity or your own passphrase, and checks the vault's membership and keys first. ([#1249](https://github.com/solidDoWant/vault-sync/pull/1249), [#1275](https://github.com/solidDoWant/vault-sync/pull/1275), [#1279](https://github.com/solidDoWant/vault-sync/pull/1279), [#1290](https://github.com/solidDoWant/vault-sync/pull/1290))

### Security

- End-to-end encrypted vaults: when you create a vault, you can choose to encrypt it. The server's database and S3 then hold only ciphertext for file contents and names, and the server never receives your passphrase, your private key or a vault key. ([#1233](https://github.com/solidDoWant/vault-sync/pull/1233), [#1267](https://github.com/solidDoWant/vault-sync/pull/1267), [#1259](https://github.com/solidDoWant/vault-sync/pull/1259))
- Every key is wrapped with a hybrid post-quantum scheme (X25519 with ML-KEM-768), through the `age` libraries. ([#1220](https://github.com/solidDoWant/vault-sync/pull/1220))
- Protection against a malicious server: every membership change and every new vault key is signed by an owner's device and checked by every member's device. A server that adds a key, swaps a member's key, injects a vault key, rolls back the membership or forges it for a newcomer is caught: devices never encrypt to it, stop syncing that vault, keep their files and show the reason. ([#1262](https://github.com/solidDoWant/vault-sync/pull/1262), [#1278](https://github.com/solidDoWant/vault-sync/pull/1278), [#1282](https://github.com/solidDoWant/vault-sync/pull/1282), [#1285](https://github.com/solidDoWant/vault-sync/pull/1285), [#1286](https://github.com/solidDoWant/vault-sync/pull/1286), [#1306](https://github.com/solidDoWant/vault-sync/pull/1306), [#1309](https://github.com/solidDoWant/vault-sync/pull/1309), [#1310](https://github.com/solidDoWant/vault-sync/pull/1310), [#1314](https://github.com/solidDoWant/vault-sync/pull/1314), [#1318](https://github.com/solidDoWant/vault-sync/pull/1318), [#1319](https://github.com/solidDoWant/vault-sync/pull/1319), [#1324](https://github.com/solidDoWant/vault-sync/pull/1324))
- Each device remembers the deployment's escrow key and the passphrase-hardening settings, and accepts a new escrow key only with a statement signed by the previous one. ([#1315](https://github.com/solidDoWant/vault-sync/pull/1315))
- The member list shows every member's key fingerprint and the vault's fingerprint, so members can compare them out of band. ([#1322](https://github.com/solidDoWant/vault-sync/pull/1322))
- [How encryption works](https://github.com/solidDoWant/vault-sync/blob/0.4.0/docs/encryption.md) explains encryption for users and operators: the threat model, key storage, escrow, recovery with `age`, and what encryption does not protect. ([#1232](https://github.com/solidDoWant/vault-sync/pull/1232), [#1312](https://github.com/solidDoWant/vault-sync/pull/1312))

### Fixes

These fix features built earlier in this release cycle.

- A file whose vault key a device doesn't have yet no longer holds back the rest of the vault; it arrives once the key does. ([#1347](https://github.com/solidDoWant/vault-sync/pull/1347))
- A change to an encrypted vault whose reply was lost, retried after a restart, no longer stops sync. ([#1357](https://github.com/solidDoWant/vault-sync/pull/1357))
- Attachments in encrypted vaults no longer become unreadable after an interrupted upload, an interrupted re-encryption, or two devices uploading the same file. ([#1362](https://github.com/solidDoWant/vault-sync/pull/1362))
- Converting a vault to encrypted now also replaces the name fingerprints of files deleted before the conversion. ([#1363](https://github.com/solidDoWant/vault-sync/pull/1363))
- Escrowed vaults move to a rotated escrow key at their next key change. ([#1364](https://github.com/solidDoWant/vault-sync/pull/1364))
- Devices refuse a vault key signed by a former owner from before their removal, and a converted vault's first key bound is taken only from its signed member list. ([#1360](https://github.com/solidDoWant/vault-sync/pull/1360), [#1361](https://github.com/solidDoWant/vault-sync/pull/1361))

Plus internal work: CI, tests, the release workflow, agent instructions, design documents, dependency updates, and refactors onto maintained libraries for merging, Unicode, OIDC, UUIDs and Bech32.

### Known issues

- No bugs are open at release time.
- Out of scope for this release, as `docs/encryption.md` describes: encryption doesn't hide metadata (file sizes, timing, devices), doesn't prove which member wrote a revision, and doesn't detect a server that withholds or replays file changes. A single lost device's copy of your private key can't be revoked; switch the vault to a new key instead. There are no per-vault passphrases and no external crypto audit yet.

## 0.3.0

The first public release of vault-sync, a self-hosted replacement for Obsidian Sync. It covers single-user sync (Phase 2) and vault sharing (Phase 3); there is no separate 0.2.0. Install the server from the image `ghcr.io/soliddowant/vault-sync:0.3.0` or the Helm chart, and the plugin with BRAT from this repository's GitHub releases.

### Sync

- Sync an Obsidian vault across desktop and mobile devices through your own server. Notes, attachments and folders sync automatically: at startup, 2 seconds after you stop typing, every 30 seconds, and with **Vault Sync: Sync now**. Changes made while Obsidian was closed are found and synced at the next start. ([#55](https://github.com/solidDoWant/vault-sync/pull/55), [#98](https://github.com/solidDoWant/vault-sync/pull/98), [#153](https://github.com/solidDoWant/vault-sync/pull/153), [#164](https://github.com/solidDoWant/vault-sync/pull/164), [#220](https://github.com/solidDoWant/vault-sync/pull/220), [#1123](https://github.com/solidDoWant/vault-sync/pull/1123), [#1131](https://github.com/solidDoWant/vault-sync/pull/1131))
- Changes from other devices arrive within seconds over a realtime connection. Sync never depends on that connection: if it drops, changes still arrive within 30 seconds, and the plugin reconnects on its own. ([#114](https://github.com/solidDoWant/vault-sync/pull/114), [#236](https://github.com/solidDoWant/vault-sync/pull/236))
- Large files upload and download in chunks, and an interrupted upload resumes where it stopped. ([#94](https://github.com/solidDoWant/vault-sync/pull/94), [#164](https://github.com/solidDoWant/vault-sync/pull/164))
- Renames and moves keep a note's identity and history on every device, including renames that change only letter case and renames made while Obsidian was closed. Deletes sync too, and an edit or rename that hasn't synced yet wins over another device's delete. ([#196](https://github.com/solidDoWant/vault-sync/pull/196), [#1129](https://github.com/solidDoWant/vault-sync/pull/1129))
- Folders sync, empty ones included. Creating, renaming or deleting a folder does the same on your other devices. ([#1125](https://github.com/solidDoWant/vault-sync/pull/1125), [#1140](https://github.com/solidDoWant/vault-sync/pull/1140), [#1152](https://github.com/solidDoWant/vault-sync/pull/1152))
- Remote changes never overwrite unsaved typing. A note or canvas open in the editor keeps your cursor and unsaved keystrokes while another device's change is merged in. ([#162](https://github.com/solidDoWant/vault-sync/pull/162), [#230](https://github.com/solidDoWant/vault-sync/pull/230))
- A crash, a power cut or quitting Obsidian during sync loses no change. The next sync picks up where it left off. ([#175](https://github.com/solidDoWant/vault-sync/pull/175), [#1128](https://github.com/solidDoWant/vault-sync/pull/1128))
- When the server is restored from a backup, every device notices and resyncs instead of losing or duplicating notes. ([#350](https://github.com/solidDoWant/vault-sync/pull/350), [#506](https://github.com/solidDoWant/vault-sync/pull/506), [#1128](https://github.com/solidDoWant/vault-sync/pull/1128))
- Files a device can't store, such as one too large for a phone or a path too long for Windows, stay on the server and on your other devices and are listed in the conflict view. The rest of the vault keeps syncing. Names the server refuses are listed with the reason and sync once you rename them. ([#217](https://github.com/solidDoWant/vault-sync/pull/217), [#294](https://github.com/solidDoWant/vault-sync/pull/294), [#1137](https://github.com/solidDoWant/vault-sync/pull/1137))
- The status bar on desktop, or a ribbon icon on mobile, shows the sync state: idle, syncing, offline, pending changes, unresolved conflicts, and errors. ([#220](https://github.com/solidDoWant/vault-sync/pull/220), [#547](https://github.com/solidDoWant/vault-sync/pull/547))

### Conflicts and history

- Edits to different lines of the same note on two devices are merged with no conflict. A conflict that can't be merged keeps both versions: yours is saved next to the note as a conflict copy, never as conflict markers inside it. ([#173](https://github.com/solidDoWant/vault-sync/pull/173), [#763](https://github.com/solidDoWant/vault-sync/pull/763), [#1129](https://github.com/solidDoWant/vault-sync/pull/1129))
- The conflict view lists every conflict copy, with a side-by-side compare, and the files that aren't on this device or aren't synced. ([#245](https://github.com/solidDoWant/vault-sync/pull/245), [#294](https://github.com/solidDoWant/vault-sync/pull/294), [#524](https://github.com/solidDoWant/vault-sync/pull/524))
- Browse every revision of a file, preview it and restore it. A restore is a new revision, so nothing is overwritten. If another file now has the name, the file can be restored at another path. ([#249](https://github.com/solidDoWant/vault-sync/pull/249), [#547](https://github.com/solidDoWant/vault-sync/pull/547), [#685](https://github.com/solidDoWant/vault-sync/pull/685))
- The history and conflict copy names show which user and which device made each change. ([#547](https://github.com/solidDoWant/vault-sync/pull/547), [#1158](https://github.com/solidDoWant/vault-sync/pull/1158))
- The server keeps the full history for 90 days, then one revision a day for a year, then one a week. Operators can change the policy for the server or for a single vault. ([#219](https://github.com/solidDoWant/vault-sync/pull/219), [#515](https://github.com/solidDoWant/vault-sync/pull/515), [#541](https://github.com/solidDoWant/vault-sync/pull/541))

### Sharing

- Share a vault: owners invite people with a one-time code as owner, editor or viewer, change their roles and remove them. Invitees join from the plugin settings. ([#640](https://github.com/solidDoWant/vault-sync/pull/640), [#680](https://github.com/solidDoWant/vault-sync/pull/680))
- Viewers get a read-only copy. Notes open read-only, nothing is uploaded, and a file changed on a viewer's device is moved aside to `.vault-sync/local-copies/` while the shared version is restored. ([#1157](https://github.com/solidDoWant/vault-sync/pull/1157))
- Leave a vault, or delete it as its owner. A device that loses access stops syncing and keeps every local file. The server keeps a deleted vault for 30 days, during which the operator can restore it. ([#1180](https://github.com/solidDoWant/vault-sync/pull/1180), [#1182](https://github.com/solidDoWant/vault-sync/pull/1182), [#1183](https://github.com/solidDoWant/vault-sync/pull/1183))

### Devices and sign-in

- Sign in through your identity provider (OIDC) with a device code. The session refreshes on its own and asks you to sign in again only when it really ends. ([#74](https://github.com/solidDoWant/vault-sync/pull/74), [#192](https://github.com/solidDoWant/vault-sync/pull/192), [#235](https://github.com/solidDoWant/vault-sync/pull/235))
- Each installation registers as a named device. List and remove your devices in the settings, which frees a place under the per-account device limit. A removed device stops syncing and can be registered again. ([#220](https://github.com/solidDoWant/vault-sync/pull/220), [#588](https://github.com/solidDoWant/vault-sync/pull/588), [#618](https://github.com/solidDoWant/vault-sync/pull/618))

### Server and deployment

- A Go server backed by PostgreSQL (14 or newer) and S3, shipped as an OCI image with a Helm chart. It runs as several stateless replicas, drains gracefully on shutdown, and exposes health checks and Prometheus metrics. ([#56](https://github.com/solidDoWant/vault-sync/pull/56), [#68](https://github.com/solidDoWant/vault-sync/pull/68), [#99](https://github.com/solidDoWant/vault-sync/pull/99), [#238](https://github.com/solidDoWant/vault-sync/pull/238))
- `vault-sync-server export` writes a plaintext copy of every vault to a directory, for backup or tape archival. ([#152](https://github.com/solidDoWant/vault-sync/pull/152))
- `vault-sync-server import` loads an existing folder of notes, such as an Obsidian vault, into a new vault. ([#1126](https://github.com/solidDoWant/vault-sync/pull/1126))

### Security

- Every request is authenticated, and every vault operation checks the caller's role in the vault. Request sizes, uploads, pages, connections and each user's concurrent requests are all bounded. ([#74](https://github.com/solidDoWant/vault-sync/pull/74), [#82](https://github.com/solidDoWant/vault-sync/pull/82), [#118](https://github.com/solidDoWant/vault-sync/pull/118), [#120](https://github.com/solidDoWant/vault-sync/pull/120), [#145](https://github.com/solidDoWant/vault-sync/pull/145), [#198](https://github.com/solidDoWant/vault-sync/pull/198))
- Paths must be portable: the server refuses names that some platforms can't store, such as Windows reserved names or a backslash, so a vault stays usable on every device. ([#144](https://github.com/solidDoWant/vault-sync/pull/144), [#283](https://github.com/solidDoWant/vault-sync/pull/283), [#291](https://github.com/solidDoWant/vault-sync/pull/291), [#1127](https://github.com/solidDoWant/vault-sync/pull/1127), [#1177](https://github.com/solidDoWant/vault-sync/pull/1177))
- Names from other members (device names, user names, paths) are displayed safely: invisible and right-to-left control characters can't disguise one name as another. ([#553](https://github.com/solidDoWant/vault-sync/pull/553), [#599](https://github.com/solidDoWant/vault-sync/pull/599), [#612](https://github.com/solidDoWant/vault-sync/pull/612))
- The refresh token is kept in Obsidian's local storage, not in the vault's files, so tools that back up or sync the vault folder never copy it. ([#460](https://github.com/solidDoWant/vault-sync/pull/460), [#1179](https://github.com/solidDoWant/vault-sync/pull/1179))
- Set up an end-to-end encryption key for your account, protected by a recovery passphrase that the server never sees. This is the first step towards end-to-end encrypted vaults, which can't be created or synced yet. ([#638](https://github.com/solidDoWant/vault-sync/pull/638), [#670](https://github.com/solidDoWant/vault-sync/pull/670), [#672](https://github.com/solidDoWant/vault-sync/pull/672), [#689](https://github.com/solidDoWant/vault-sync/pull/689), [#698](https://github.com/solidDoWant/vault-sync/pull/698), [#703](https://github.com/solidDoWant/vault-sync/pull/703), [#718](https://github.com/solidDoWant/vault-sync/pull/718))

### Fixes

These fix features built earlier in this release cycle.

- A folder tree deleted on one device no longer comes back when another device syncs partway through the delete. ([#1194](https://github.com/solidDoWant/vault-sync/pull/1194))
- A change sent just before its author was removed or demoted to viewer is refused instead of applied. ([#1196](https://github.com/solidDoWant/vault-sync/pull/1196))
- Remote changes now reach a note that is open in reading view. ([#1186](https://github.com/solidDoWant/vault-sync/pull/1186))
- A note deleted and replaced by renaming another note onto its name now syncs correctly. ([#1173](https://github.com/solidDoWant/vault-sync/pull/1173))
- A rename onto a name this device is giving up, and a change whose reply was lost, no longer get stuck. ([#1171](https://github.com/solidDoWant/vault-sync/pull/1171), [#1174](https://github.com/solidDoWant/vault-sync/pull/1174))
- A resync after a server restore no longer stops at a file this device can't store, and no longer loses a note to a name the restore gave another note. ([#1164](https://github.com/solidDoWant/vault-sync/pull/1164), [#1175](https://github.com/solidDoWant/vault-sync/pull/1175))
- Remote files named like vault-sync's temporary files are skipped instead of disrupting sync. ([#1176](https://github.com/solidDoWant/vault-sync/pull/1176))
- A device that leaves viewer mode, by disconnecting or switching to a vault where it is an editor, syncs normally again. ([#1178](https://github.com/solidDoWant/vault-sync/pull/1178))
- A former owner's pending invitations are deleted with their membership. ([#1189](https://github.com/solidDoWant/vault-sync/pull/1189))
- Replacing a file no longer waits several seconds for the vault index. ([#1191](https://github.com/solidDoWant/vault-sync/pull/1191))
- A note deleted while open in the editor no longer loses unsaved keystrokes. ([#340](https://github.com/solidDoWant/vault-sync/pull/340))
- A connection that silently stops answering now shows as offline instead of hanging, and an account at the server's request limit backs off and retries. ([#288](https://github.com/solidDoWant/vault-sync/pull/288), [#560](https://github.com/solidDoWant/vault-sync/pull/560), [#732](https://github.com/solidDoWant/vault-sync/pull/732))
- Canvas files merge field by field without dropping fields, and Android file errors are handled. ([#542](https://github.com/solidDoWant/vault-sync/pull/542), [#554](https://github.com/solidDoWant/vault-sync/pull/554), [#711](https://github.com/solidDoWant/vault-sync/pull/711))
- Server hardening: S3 certificate checks, upload session cleanup, fair sharing of server work between users, retention and garbage-collection fixes, and a safe shutdown drain. ([#143](https://github.com/solidDoWant/vault-sync/pull/143), [#177](https://github.com/solidDoWant/vault-sync/pull/177), [#199](https://github.com/solidDoWant/vault-sync/pull/199), [#382](https://github.com/solidDoWant/vault-sync/pull/382), [#387](https://github.com/solidDoWant/vault-sync/pull/387), [#438](https://github.com/solidDoWant/vault-sync/pull/438), [#461](https://github.com/solidDoWant/vault-sync/pull/461), [#489](https://github.com/solidDoWant/vault-sync/pull/489))
- Export hardening: no readable note is left out because of its path, and staging and lock files are handled safely. ([#188](https://github.com/solidDoWant/vault-sync/pull/188), [#197](https://github.com/solidDoWant/vault-sync/pull/197), [#492](https://github.com/solidDoWant/vault-sync/pull/492), [#501](https://github.com/solidDoWant/vault-sync/pull/501))
- Sign-in hardening: OIDC keys are fetched over HTTPS only, and identity claims and device names are checked. ([#83](https://github.com/solidDoWant/vault-sync/pull/83), [#90](https://github.com/solidDoWant/vault-sync/pull/90), [#445](https://github.com/solidDoWant/vault-sync/pull/445))
- Updated Go to fix standard-library vulnerabilities. ([#168](https://github.com/solidDoWant/vault-sync/pull/168), [#604](https://github.com/solidDoWant/vault-sync/pull/604))

Plus internal test, CI, tooling and process work.

### Known issues

- None. No bugs are open at release time.
