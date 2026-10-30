# Conflicts and history

For: people who use the Obsidian plugin. You have [connected a vault](getting-started.md).

This page says what happens when two devices change the same file, how to resolve a conflict copy, and how to get an old version of a file back.

## When two devices change the same file

vault-sync never writes conflict markers into a note, and it never drops one of the two versions. It first tries to combine the two changes. If it cannot, it keeps both versions:

- The server's version stays at the file's path.
- The other version is kept next to it, in the same folder, as a **conflict copy**: `<name> (Conflicted copy <user> <device> <YYYYMMDDHHMM>).<ext>`. `<user>` is your name from your organization's login. `<device>` is the [device name](devices.md) of the device that made the change.

If that name is taken, ` 2`, ` 3` and so on are added. If the name is too long, it is cut short. A conflict copy is an ordinary file, and it syncs to your other devices. Only one device makes the copy, so there is one copy per conflict.

### Which changes are combined

| File type | What vault-sync does | You get a conflict copy when |
|---|---|---|
| Notes (`.md`) | Combines changes line by line. Versions that differ only in line endings, or in a newline at the end, count as equal. | Both devices changed the same lines. |
| Obsidian Bases (`.base`) | Combines changes to different views, formulas or properties. Filter conditions that either device added or removed all apply. A combined base is written again as plain YAML, without its comments. A base that only one device changed is kept byte for byte. | Both changed the same setting, one deleted what the other changed, the plugin does not understand the base (newer Bases syntax), or the result is not valid (one deleted a formula that the other started to use). |
| Canvas (`.canvas`) | Combines changes card by card and connection by connection. If one device moves a card and the other changes its color, both apply. | Both changed the same property of a card (both moved it), one changed the order of the cards, or one deleted a card that the other connected or changed. |
| Other JSON (`.json`) | Combines changes key by key. A list counts as one value. | Both changed the same key differently. |
| Plain text up to 1 MiB (`.txt`, `.csv`, `.tsv`, `.css`, `.js`, `.ts`, `.py`, `.sh`, `.html`, `.xml`, `.tex`, `.org`, `.rst`, `.yaml`, `.yml`, `.toml`) | Combines changes line by line. | The edits are on the same line or on lines next to each other, or a combined YAML or TOML file is not valid. |
| Every other file | Keeps the newer version at the path. | Both devices changed it, or created it at the same path with different content. |

A note also gets a conflict copy when the version that both edits started from is no longer in the history.

## Resolve a conflict copy

1. Run **Vault Sync: Show conflicts**. The conflict view opens in the right sidebar. It lists the conflict copies that this device made, newest first, each with links to the note and to the copy.
2. Click **Compare side by side** to open the two versions next to each other. On a phone, both open, and you switch between them.
3. Copy what you need from the conflict copy into the note.
4. Delete the conflict copy. Its entry leaves the view, and the status no longer counts it. Renaming the copy has the same effect.

The conflict view also lists files that do not sync. [Syncing](syncing.md#files-that-do-not-sync) explains them.

## History

By default, the server keeps every saved version for 90 days, then one version per day for a year, then one per week. Your admin can change these times. The current version of a file is never removed, and neither is the record that a file was deleted. For the settings, see [History and retention](../admin/history-and-retention.md#the-retention-policy) in the admin docs.

History works only while the vault syncs: you are signed in and the vault is connected.

### See the history of a file

Run **Vault Sync: Show file history** for the open file, or choose **Show sync history** in a file's context menu. The list shows the file's versions, newest first. Each line shows:

- when the server received the version
- which user made it, by the name from their login, or by the start of their user id
- which device made it: `this device`, another device's name in quotes, or the start of its id
- what changed: edited, moved, deleted or restored.

**Load older versions** shows more. Every member of a vault sees the names of the devices that changed its files.

Another member can choose any name. So that one name cannot pass for another, the history and the conflict view show invisible characters as `\uXXXX` (a right-to-left override shows as `\u202E`) and a backslash as `\\`. Device names longer than 64 characters end in `…`. Only the display changes.

### Restore a version

1. Choose a version in the list to preview it. Text shows as it is, or only its start for a very long file. Other files show their size.
2. Click **Restore this version**.

The restore is a new version, so the version that it replaces stays in the history. It reaches your other devices like any edit, and the file keeps its current name and folder. A local edit that did not sync yet meets the restored version like an edit from another device.

Viewers can see the history and preview versions, but they cannot restore. If the plugin cannot read your role, for example because the server cannot be reached, it shows the button, and the server decides.

### When another file uses the path

If another file now uses the file's path, the restore fails at first. Then:

1. Click **Restore at another path**. The field suggests a free path next to the old one, for example `plan (restored).md`.
2. Change the path if you want.
3. Click **Restore here**. The file comes back at that path, with its history.

If the path cannot be used, correct it in the field. You can also move the other file away and restore again.
