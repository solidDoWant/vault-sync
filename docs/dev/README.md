# Developer docs

For: developers who change the code. You know Go, TypeScript and the Obsidian plugin API, but not this codebase.

Start with the architecture page. Then read the page for the work you do. `SPEC.md` is the full set of rules. When a page here and `SPEC.md` disagree, `SPEC.md` is right, and the page has a bug.

## Pages in this folder

- [Architecture](architecture.md): the parts, how one edit travels from one device to another, and where each package lives.
- [Building](building.md): the dev shell, the `make` targets and the generated code.
- [Protocol](protocol.md): an overview of the API and the realtime channel.
- [Contributing](contributing.md): the rules you must not break, and how a change lands.
- [Releasing](releasing.md): how a release is made.
- [Decisions](decisions.md): the decisions that still bind, with their reasons.
- [Glossary](glossary.md): the terms of the codebase, with links to their exact definitions.

## Design

The design documents say how the system behaves and why. They are in `docs/design/` and are for developers and agents:

- [`engine.md`](../design/engine.md): the sync engine of the plugin. This design is fixed. Its decision table (§5) decides every sync case.
- [`engine-situations.md`](../design/engine-situations.md): the situations that explain each row of the decision table.
- [`sharing.md`](../design/sharing.md): roles, losing access and deleting a vault.
- [`encryption.md`](../design/encryption.md): end-to-end encryption, escrow and the protection against an active server.
- [`crypto.md`](../design/crypto.md): the cipher suites, the byte formats and the parameters.

## Testing

The test tiers are in `SPEC.md` §13. Each tier has a guide in `docs/testing/`:

- [`acceptance.md`](../testing/acceptance.md): the `[AC-nn]` tests, one for each scenario of the owner's checklist, and `make acceptance`.
- [`integration.md`](../testing/integration.md): the tests against a real PostgreSQL and S3 (`make test-integration`).
- [`e2e.md`](../testing/e2e.md): the plugin in a real Obsidian (`make test-e2e`), on desktop, emulated mobile and the Android emulator.
- [`android.md`](../testing/android.md): the manual checks on an Android device before each release.
- [`proto-compatibility.md`](../testing/proto-compatibility.md): what to do when `buf breaking` fails.

The owner's acceptance checklists are in `docs/acceptance/`. A phase is done when its checklist passes.
