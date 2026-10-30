# Contributing

For: developers who change the code. Read [architecture.md](architecture.md) and [building.md](building.md) first.

## The principles

Five principles override convenience. The exact wording is in `SPEC.md` §2. In short:

1. No acknowledged write is ever lost. Deletes are tombstones. Neither the client nor the server silently overwrites or drops a user edit.
2. One source of truth per concern. The server's revision log holds the history, the local vault holds the edits not pushed yet, and one journal on the device joins them. Do not add other replicated stores or chunk layers.
3. Done means the owner's acceptance checklist passes (`docs/acceptance/`). Tests guard behavior. They do not raise the bar beyond the checklist and principle 1.
4. Small, defensible attack surface. The server is on the internet. Authenticate and authorize every request, and bound every resource.
5. Operator infrastructure only: PostgreSQL, S3 and OIDC.

If your change touches one of them, say so in the pull request.

## Rules for the code

- `plugin/src/core` never imports `obsidian`. Lint enforces this.
- The engine design in `docs/design/engine.md` is fixed. If it does not decide a case, ask on the issue. Do not invent a rule.
- Never write your own cryptography. Every cipher, hash, MAC, KDF, KEM, signature and random source comes from an established library: `@noble/*` in TypeScript, the Go standard library and `golang.org/x/crypto` in Go, or age. A change to cryptography updates the vectors in `testdata/crypto/` and passes them in both languages.
- Every RPC and WebSocket handler resolves the caller's vault role before it touches data. Add a test that a non-member and, where it applies, a `viewer` are refused.
- Bound every input: request and chunk sizes, decompression, pagination and path lengths.
- Never log secrets, tokens, note content or, for end-to-end encrypted vaults, plaintext paths.
- Never edit generated code (`gen/`, `plugin/src/gen/`). Run `make generate`.
- Name files and symbols for what they are. Comments say what the code does and why. They never cite issue or pull request numbers: that history belongs in commit messages and pull requests.

## Tests

- A sync bug gets a failing test first: an engine decision-table test (in-memory server and vault) or an `[AC-nn]` acceptance test.
- Every row of the decision table (`docs/design/engine.md` §5) has a table test.
- Go tests use `testify` (`require` and `assert`) and are table-driven. Use `t.Context()`, never `context.Background()`. Integration tests have the `integration` build tag and skip when Docker is missing.
- TypeScript tests use vitest, and `describe` and `it` name the behavior. Unit tests use no network. They use the in-memory transport and vault.
- Tests never depend on wall-clock speed or scheduling order. A test that is sensitive to timing must pass `-count=50 -race`.
- Never change an acceptance test to make it pass. Fix the code. CI fails a pull request that deletes or skips an `[AC-nn]` or `[Pn-nn]` scenario test or removes a crypto or path vector (`make test-guard`).

The test tiers and how to run them are in [the developer README](README.md#testing).

## How a change lands

1. Every change starts from a GitHub issue.
2. Work on a branch named after the issue, for example `fix/sync-123`. Never push to `master`.
3. Commit with conventional-commit messages: `type(scope): summary`, for example `fix(engine): keep the local edit on a path conflict`.
4. Open a pull request with a conventional-commit title and `Fixes #<issue>` in the body. Say how each acceptance criterion is tested, and which principle the change touches, if any.
5. If the behavior changes, update `SPEC.md` and the docs for each audience it affects in the same pull request. `docs/README.md` says which page is for which reader.
6. CI runs lint, the unit, integration and end-to-end tests, the release builds and the test guard. The one required check is `checks`. It passes when every job passed or was skipped.
7. Pull requests are squash-merged.

Most work in this repository is done by AI agents that follow the same rules. Their instructions are in `CLAUDE.md` and `docs/agents/`.
