# vault-sync

Self-hosted synchronization for [Obsidian](https://obsidian.md) vaults: an Obsidian plugin plus a Go sync server backed by PostgreSQL and S3-compatible object storage.

> **Status: early development.** Nothing here is usable yet. Do not point it at a vault you care about.

Goals:

- No acknowledged edit is ever lost — revision history, tombstones, and conflict copies instead of silent overwrites.
- Desktop (Windows, macOS, Linux) and Android; iOS best-effort.
- Multiple users with shared vaults, OIDC login.
- Optional end-to-end encryption, with an opt-in escrow key so an internal backup job can still produce plaintext backups.
- Live collaborative editing (CRDT) on top of the same protocol.

See [`SPEC.md`](SPEC.md) for the design and [`CLAUDE.md`](CLAUDE.md) for how work in this repository is done.

## Development

```sh
nix develop      # or: direnv allow
make help
make lint test
```

## License

[AGPL-3.0](LICENSE)
