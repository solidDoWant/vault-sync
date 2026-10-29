# Vault sharing design (Phase 3)

Status: approved by the owner on 2026-10-29. It adds to `engine.md`, and the same rules apply: agents implement it and do not change it. Questions go to the operator.

## Roles

`owner`, `editor` and `viewer`, as in SPEC §9.2. The server enforces every role on every request: viewers get `PERMISSION_DENIED` for `CommitRevision` and the blob upload procedures, whatever the client sends. Any user who can sign in may redeem an invitation code. There are any number of owners, and always at least one: the last owner can't be demoted, removed, or leave. Ownership moves by promoting someone and then leaving.

## Sync is unchanged

Several users sync exactly like several devices of one user. The server orders every commit, and `engine.md` §5 and §11 apply unchanged. A vault shared with nobody else is a normal single-user vault.

## Viewer devices

- The device learns its role from `ListVaults` at the start of every sync cycle, so a role change takes effect within one cycle.
- **In Obsidian:** a viewer's files open read-only. A CodeMirror read-only extension and reading view are combined, with a banner saying the vault is shared with them as a viewer. Create, rename and delete actions on the vault are refused with a notice.
- **Nothing is pushed.** A viewer device never commits or uploads. If a file differs from `base` anyway (changed outside Obsidian), the device copies it to `.vault-sync/local-copies/<path>` (a dot folder, never synced; a numeric suffix is added if the name is taken), restores the shared version, and shows a notice. New local files are moved there too. A local delete or rename is undone by restoring from `base`.
- **Convergence:** a viewer device only pulls, so it always ends up at the server's heads (§11 point 4).
- **Becoming an editor:** a device that becomes an editor syncs normally from its next cycle. Files in `local-copies` stay local.

## Losing access

When a member is removed, leaves, or the vault is deleted, the server answers that device's vault requests with `NOT_FOUND` (deleted vaults are reported as deleted). The device then:
- stops syncing that vault;
- keeps every local file as it is;
- shows "no longer a member" or "vault deleted" in the status and settings.

Its journal is kept, so it can reconnect if access comes back. Leaving is available to every member from the plugin's settings.

## Deleting a vault

- **Who and how:** `DeleteVault` is owner-only. The plugin asks the owner to type the vault name to confirm.
- **On the server:** the vault is marked deleted and becomes invisible to everyone.
- **Purge:** a background job purges a deleted vault 30 days after deletion: rows, then blobs.
- **Undo:** `vault-sync-server vault undelete <vault-id>` restores a vault that hasn't been purged yet. There is no undo in the plugin.

## Attribution

- **History:** every revision carries `user_id` and `device_id`. `GetDocumentHistory` returns each user's display name (the identity provider's `name` claim, falling back to `preferred_username`) and each device's name. The plugin shows "user, device" for each version.
- **Conflict copies:** they are named after the local user and device, `<name> (Conflicted copy <user> <device> <YYYYMMDDHHMM>).<ext>`. This replaces the device-only name in `engine.md` rule C, for all vaults.
