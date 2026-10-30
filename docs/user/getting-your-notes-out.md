# Getting your notes out

For: people who use the Obsidian plugin. You want a copy of your notes without vault-sync.

## Your notes are plain files

Each synced device holds the vault as an ordinary Obsidian vault: a folder of Markdown files, attachments and subfolders. This is also true for an encrypted vault.

To get a copy, copy the vault folder on any synced device. You do not need the plugin, the server or an internet connection for that. If you stop using vault-sync, disable the plugin. The files stay where they are.

A device holds only the current version of each file, not the history, and not files that it [cannot hold](syncing.md#files-that-are-not-on-this-device).

## What your admin can give you

Your admin can run an export on the server. An export is a plaintext copy of the current files of each vault, for backups. It holds:

- every file that exists in the vault, as last synced to the server
- for a vault that an owner deleted, the files until the server removes the vault 30 days later.

It does not hold:

- older versions from the history, or deleted files
- changes that a device did not upload yet, or the config folder (`.obsidian`)
- the members and their roles
- an encrypted vault without [escrow](encryption.md#escrow). Nobody but its members can decrypt it.

If you lost every device, or you forgot your passphrase, ask your admin for a copy from the export. For how the export works, see [Plaintext export](../admin/backup-and-restore.md#the-export-job).

## Bring notes in

To start a vault from an existing folder of notes, connect it in the plugin: the plugin uploads the files (see [Getting started](getting-started.md#connect-a-vault)). Your admin can also load a folder of Markdown notes into a new, empty vault with the server's import tool (see [Markdown import](../admin/backup-and-restore.md#import-markdown)).
