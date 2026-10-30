# Frequently asked questions

For: people who use the Obsidian plugin.

## Does vault-sync sync my Obsidian settings, themes and plugins?

No. It does not sync the config folder (`.obsidian`). Set up each device on its own. See [Syncing](syncing.md#what-syncs).

## Can I lose an edit?

vault-sync does not drop a saved edit. When two devices change the same note and the changes cannot be combined, you get both versions: the note, and a conflict copy. Deletes are kept in the history. See [Conflicts and history](conflicts-and-history.md).

## How long does the server keep old versions?

By default, every version for 90 days, then one per day for a year, then one per week. Your admin can change this. The current version is never removed. See [Conflicts and history](conflicts-and-history.md#history).

## Why does a file not sync?

It is too large (1 GiB on a desktop, 256 MiB on a phone), or the server refuses its name. Run **Vault Sync: Show conflicts** to see the reason. See [Syncing](syncing.md#files-that-do-not-sync).

## Can my admin read my notes?

In a plaintext vault, yes: the server stores your notes as they are. In an end-to-end encrypted vault, no, unless the vault has escrow, which lets the admin's backup read it. See [Encryption](encryption.md).

## What happens if I forget my passphrase?

Your unlocked devices keep your files. Do not sign out of them. The server's copy can be restored only if the vault has escrow. See [Encryption](encryption.md#if-you-forget-your-passphrase).

## How do I move my existing notes into vault-sync?

Create a vault from the Obsidian vault that holds them, and the plugin uploads them. Your admin can also import a folder of Markdown notes. See [Getting your notes out](getting-your-notes-out.md#bring-notes-in).

## How do I stop using vault-sync?

Disable the plugin. Your notes stay on each device as ordinary files. See [Getting your notes out](getting-your-notes-out.md).

