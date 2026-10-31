# vault-sync

vault-sync is a self-hosted replacement for Obsidian Sync. It has two parts: a plugin for [Obsidian](https://obsidian.md), and a sync server that you run yourself and that stores its data in PostgreSQL and S3.

## Status

You can install released versions of vault-sync. Each release and its changes are listed in [`CHANGELOG.md`](CHANGELOG.md). Sync for one user, shared vaults and end-to-end encryption work today. Live editing of one note by several people at the same time is not ready yet. The project is young, so keep a backup of any vault that you care about.

## Where to start

- [Use it](docs/user/getting-started.md): install the plugin and sync your notes.
- [Run a server](docs/admin/requirements.md): install and run the sync server.
- [Work on the code](docs/dev/README.md): build, test and change vault-sync.

[`docs/README.md`](docs/README.md) lists every page.

## License

[AGPL-3.0](LICENSE)
