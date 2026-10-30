# vault-sync documentation

For: anyone who wants to find the right page. You need to know nothing yet.

vault-sync has four kinds of readers. Each page is written for one of them. This page says who they are, which pages are theirs, and how deep each page goes on a topic. It also records the rules for writing the pages.

## Who reads these docs

| Reader | Who they are | What they already know | What they care about | What they don't care about |
|---|---|---|---|---|
| **User** | Someone who syncs their notes with the plugin. | Obsidian, their own devices, how to install a plugin. | Setting up, what syncs and what doesn't, what happens when two devices change the same note, getting an old version back, sharing a vault, what encryption protects, and what they must never lose. | Servers, protocols, algorithms, PostgreSQL, Kubernetes. |
| **Admin** | Someone who runs the server for themselves, their family or a team. | Kubernetes and Helm, PostgreSQL, S3, an OIDC sign-in provider, TLS, Prometheus. | What the server needs, how to install it, every setting, sizing, backups and restore, upgrades, monitoring and alerts, how safe the server is, and what the server can and can't see. | How the sync engine decides things, how the tests are organised. |
| **Developer** | Someone who changes the code. | Go, TypeScript, the Obsidian plugin API. Not this codebase. | The architecture, how to build and test, the design and the reasons for it, the protocol, and the rules they must not break. | How to set up one particular sign-in provider or ingress. |
| **Agent** | The AI agents that build this project. | Everything in `CLAUDE.md`. | Exact and complete rules. | Prose style. Their files in `docs/agents/` and `.claude/` don't follow the style rules below. |

The owner reads the acceptance checklists, the release notes and status reports. Write those for a user and an admin together, in plain English.

## Where each reader starts

- **User:** [`docs/user/`](user/), starting with "Getting started".
- **Admin:** [`docs/admin/`](admin/), starting with "Requirements".
- **Developer:** [`docs/dev/`](dev/), starting with "Architecture". `SPEC.md` is the full set of rules.
- **Agent:** `CLAUDE.md`, then [`docs/agents/`](agents/).

## The tree

```
README.md                  The front door: what vault-sync is, its status, and three links:
                           "Use it" (docs/user/), "Run a server" (docs/admin/), "Work on the code" (docs/dev/).
CHANGELOG.md               Release notes, one section per release. For users and admins.
SPEC.md                    The rules of the system. For developers and agents. Keeps its section numbers.

docs/README.md             This page.

docs/user/
  getting-started.md       Install the plugin with BRAT, sign in, connect a vault, first sync.
  syncing.md               What syncs and when, the status icon, offline use, what is not synced
                           (the config folder, files too large, names the server refuses).
  conflicts-and-history.md What happens when two devices change one note, conflict copies,
                           the history view, getting an old version back.
  sharing.md               Members and roles, invitations, leaving a vault, deleting a vault.
  encryption.md            End-to-end encryption: what it protects, the recovery passphrase,
                           escrow, what to do if you lose the passphrase.
  devices.md               Device names, the device list, removing a device, signing out.
  getting-your-notes-out.md  Your notes are plain files on each device; how to get a copy
                           without the plugin; what to ask your admin for.
  troubleshooting.md       Each status message and error, what it means, what to do.
  faq.md
  glossary.md

docs/admin/
  requirements.md          What the server needs: Kubernetes, PostgreSQL 14 or later, S3, OIDC, TLS, sizing.
  install.md               Install with Helm, step by step, and a first sign-in check.
  configuration.md         How the server is configured: the groups of settings, the endpoints.
  configuration-reference.md  Every environment variable. Generated from the code.
  chart-values.md          Every Helm chart value. Generated from the chart.
  identity-provider.md     What the sign-in provider must offer, and a worked Authentik example.
  postgresql-and-s3.md     The database and the bucket: setup, TLS, permissions, what lives where.
  backup-and-restore.md    Backups, the plaintext export job, import, restoring a server,
                           undeleting a vault.
  encryption.md            Encryption for operators: what the server holds, the escrow key,
                           rotating it, recovery with age, the threat model.
  history-and-retention.md The retention policy, per-vault overrides, storage growth.
  monitoring.md            What to scrape, service-wide metrics, Grafana dashboards.
  metrics-reference.md     Every metric. Generated from the code.
  alerts.md                One runbook per alert: what it means, what to check, what to do.
  upgrades.md              Upgrading, rolling upgrades, high availability.
  security.md              The security model: authentication, authorization, limits, what an
                           attacker can and can't do.
  troubleshooting.md       Startup failures, configuration errors, common faults.
  glossary.md

docs/dev/
  README.md                Where to start; links to every developer page.
  architecture.md          The parts and how they fit: plugin, engine, server, PostgreSQL, S3.
  building.md              The dev shell, make targets, generated code.
  protocol.md              An overview of the API and the realtime channel; SPEC.md has the rules.
  contributing.md          How work lands: issues, branches, PRs, commit titles, reviews.
  releasing.md             How a release is made.
  decisions.md             Decisions and rejected alternatives, moved out of SPEC.md, by SPEC section.
  glossary.md

docs/design/               Unchanged location. The design of the engine, sharing and encryption.
                           For developers and agents.
  engine.md                The sync engine: its rules and the decision table.
  engine-situations.md     The sync situations to test, and the tests that cover them.
  sharing.md               Vault membership, invitations and roles.
  encryption.md            End-to-end encryption: keys, epochs, escrow, the membership log.
  crypto.md                The byte formats of the cipher suite.

docs/testing/              Unchanged location. The test tiers and how to run them. For developers.
  acceptance.md            How `make acceptance` finds and counts the acceptance tests.
  integration.md           The integration tests against PostgreSQL and S3.
  e2e.md                   The plugin e2e tests in a real Obsidian.
  android.md               The checklist for each release on Android.
  proto-compatibility.md   The protobuf compatibility check (`buf breaking`).

docs/acceptance/           Unchanged location. The owner's acceptance checklists.
  phase-2.md
  phase-3.md
  phase-4.md

docs/agents/               Unchanged. For agents only.

docs/plugin.md             Stubs for pages that moved (see "Moved pages and redirects" below).
docs/encryption.md         Each one links to the new page or pages.
docs/configuration.md
docs/deployment.md
docs/export.md
docs/import.md
docs/alerts.md
```

`docs/design/` and `docs/testing/` stay where they are, unlike the first proposal, which moved them under `docs/dev/`. Code comments, protobuf comments (and so the generated code), `buf.yaml`, CI workflows, scripts, `CLAUDE.md` and the agent playbooks all cite these paths. Moving them would change generated code and many files, and would not help any reader. `docs/dev/README.md` links to them, so a developer finds them from `docs/dev/`.

The section-by-section mapping from today's pages to this tree is in [`docs/agents/docs-migration.md`](agents/docs-migration.md). It is temporary. The last rewrite issue deletes it.

## How deep each page goes

A topic that matters to more than one reader appears on more than one page, at a different depth on each. A page never copies the next reader's detail. It says what its own reader needs, then links to the deeper page "for more detail".

| Topic | User page | Admin page | Developer page |
|---|---|---|---|
| **Recovery passphrase (Argon2id)** | "Your passphrase never leaves your device. If you forget it, nobody can get your encrypted notes back, not even the server's admin. Write it down." | The passphrase is stretched with a deliberately slow hash, Argon2id. A stolen database still costs an attacker that slow hash for every guess. Wrong guesses are limited to 10 an hour. Escrow is the only way to recover a vault without the passphrase. | The parameters (64 MiB, 3 passes), the library, the key chain from passphrase to the wrapping key and the verifier, the shared test vectors. Links to `SPEC.md` §9.3 and `docs/design/crypto.md`. |
| **Conflicts and conflict copies** | When two devices change the same lines, you get both versions: your note, plus a conflict copy named after the other device. Nothing is lost. How to resolve it, and where the status shows it. | The server never merges. It only refuses a change made on top of an old version. Conflicts cost nothing on the server. | The decision table, the three-way merge, conflict copy names, the rules that make devices agree. Links to `docs/design/engine.md` §5 and `SPEC.md` §7. |
| **History and retention** | Every saved version is kept for a while. How to see and restore an old version, and how long versions last by default. | The retention policy and its settings, per-vault overrides, how much storage history uses, the retention job and its alert. | The revision model, how purging chooses versions, why a head revision is never purged. Links to `SPEC.md` §11. |
| **Sharing and membership** | Owners, editors and viewers; inviting someone; leaving; what a removed member keeps. | Who may do what; the member limit; that there is no admin override; undeleting a vault. | The membership model, how every request checks the caller's role, attribution. Links to `docs/design/sharing.md` and `SPEC.md` §9.2. |
| **End-to-end encryption and escrow** | What is encrypted and what is not, what escrow means for you, what to do before you lose the passphrase. | What the server can and can't see, generating and storing the escrow key, rotating it, recovering a vault with age, the threat model. | The cipher suite, key slots, epochs and rotation, the membership log, the re-key job, the hard stop on a failed check. Links to `docs/design/encryption.md`, `docs/design/crypto.md` and `SPEC.md` §9.3–9.4. |
| **Devices** | Naming a device, the device list, removing a lost device, signing out. | What a device is on the server, the per-user realtime connection limit, what removing a device does. | Device registration, device ids, realtime subscriptions per device. Links to `SPEC.md` §9.1 and §6.4. |
| **Sign-in** | Sign in with your organisation's login on a second screen; what "sign-in needed" means. | What the OIDC provider must offer (device code flow, public client, audience), a worked Authentik example. | The device authorization grant, token refresh, how the server checks tokens. Links to `SPEC.md` §9.1. |
| **Export and import** | Your notes are files on your devices. How to get a copy; that the admin can export a vault. | The export job, its output and manifest, the escrow identity it needs for encrypted vaults, importing Markdown, exit codes. | The export and import code paths, path safety, atomic replacement. Links to `SPEC.md` §9.4 and §12. |
| **Limits and rate limits** | Files too large to sync (1 GiB on desktop, 256 MiB on a phone), names the server refuses, what the status shows. | Every size and request limit, concurrency and connection limits, the WAF body limit, the passphrase-guess limit, how to raise them safely. | Where each bound is enforced and why every input is bounded. Links to `SPEC.md` §2 (principle 4) and `docs/design/engine.md` §7. |
| **Metrics and alerts** | Not covered. | Every metric, the service-wide metrics, the dashboards, and one runbook per alert. | How metrics are registered and kept in step with the docs. |
| **Realtime and offline** | Changes arrive in seconds; offline edits sync when you are back. | The realtime WebSocket path, ingress timeouts, connection limits. | The realtime channel never decides sync; pulling does. Links to `SPEC.md` §6.4 and `docs/design/engine.md` §3. |
| **What is not synced** | The config folder, files that are too large, names the server refuses. | Not covered beyond the server's size limit. | Why config-folder sync is out of scope. Links to `docs/design/engine.md` §1. |

## Rules for every page

- **Name the reader.** Each page starts with one line: `For:` the reader, then what they must already know. For example: "For: admins. You need a running Kubernetes cluster and know Helm."
- **One reader per page.** If a section is for a different reader, it belongs on that reader's page.
- **Link down, don't repeat.** Say what this reader needs, then link "for more detail" to the next reader's page. User pages link to admin pages, admin pages to developer pages, developer pages to `SPEC.md` and `docs/design/`.
- **Every fact has one home per reader.** A fact may appear on several readers' pages at different depths, but only once for each reader.
- **Plain English.** Pages for users, admins and the owner follow SimpleEnglish (Plain mode). Developer pages use plain English too, but keep exact terms. Agent files are exempt.
- **CI checks every page.** It fails when a relative link or anchor is broken, when a page under `docs/` is missing from the tree above, when a generated reference is out of date, or when a page has an em-dash, a "(decision" note with an issue number, or a "Why:" lead-in. It also reports the style of each changed page, but that report never fails the build. Run `make docs-check` to run the same checks.
- **Reference tables are generated.** The tables of environment variables, metrics and chart values are generated from the code and the chart, and CI fails when they are out of date. Do not edit them by hand. Change the doc comment, the metric help text or the `values.yaml` comment instead. The alert runbooks are written by hand, with one heading per alert. Scripts read those headings, so keep their format.

## Glossaries

There is **one glossary per reader**: `docs/user/glossary.md`, `docs/admin/glossary.md` and `docs/dev/glossary.md`. A user should not have to read past "epoch" and "key slot" to find "conflict copy". Each entry defines the term at its reader's depth and may link to the same term in the next reader's glossary. `SPEC.md` stays the exact definition for developers. `docs/dev/glossary.md` points to it rather than restating it.

## SPEC.md

- `SPEC.md` stays the normative reference for developers and agents.
- It keeps its section numbers. Code, tests and reviews cite them.
- User and admin material moves out to the new pages. For example, the operations detail in §12 moves to the admin pages, and SPEC keeps the rules.
- Server and client details that a test or a test vector already checks move next to the code. They go into the proto comments, the package docs or the test names. SPEC keeps the rule in one line and names the test. The migration map names the test for each section.
- Decision history is deleted: the decision notes that cite an issue number, the other issue numbers and the rejected alternatives. Git and the issues keep it. Only decisions that still bind move to `docs/dev/decisions.md`, each with its reason and the SPEC section it belongs to. The migration map lists them.
- A separate issue rewrites SPEC in plain English. It must not change any rule.

## Size

The docs should be as short as their readers need, and no shorter. Size is not a goal and not a CI check (owner decision, 2026-10-30). A page is the right size when every fact on it serves its reader, appears once for that reader, and isn't already stated by the code, a test or a generated reference.

The one-off rewrite set rough targets per page in [`docs/agents/docs-migration.md`](agents/docs-migration.md) to size the work. They are guidance for that rewrite only. A rewrite that needs more words to be clear uses them. One that can say it in fewer does.

## Moved pages and redirects

Links from outside the repository point at today's paths. The released chart's alerts link each alert's `runbook_url` to `docs/alerts.md#` and the alert name on `master`. The released chart's `Chart.yaml` and `values.yaml` comments name `docs/configuration.md`, `docs/deployment.md`, `docs/export.md` and `docs/alerts.md`. Code comments in the repository name these pages too, but they change with the move. Release notes link to pages, but at a release tag, so moving a page on `master` does not break them.

So:

- Every page moved out of the top of `docs/` (`plugin.md`, `encryption.md`, `configuration.md`, `deployment.md`, `export.md`, `import.md`, `alerts.md`) leaves a stub for one release. The stub is one line that links to the new page or pages.
- The `docs/alerts.md` stub also keeps one heading per alert, each linking to the alert's new runbook. Then old `runbook_url` links still land on the right alert.
- The chart's `runbookUrlBase` default, the chart's comments, code comments and the scripts and tests that read these pages change to the new paths in the same rewrite.
- The stubs are deleted in the first release after the one that ships the new pages.
- `docs/design/` and `docs/testing/` don't move, so they need no stubs.
