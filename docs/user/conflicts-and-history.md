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

Run **Vault Sync: Show file history** for the open file, or choose **Show Vault Sync history** in a file's context menu. To find any synced file, also a deleted one, run **Vault Sync: Browse sync history** and type part of its name in the search field.

The title of the history window shows the path of the chosen file, as Obsidian shows it above a note. Click a folder in the path to show that folder in the list of files, or click the file's name to show the file.

The history window has three parts, from left to right:

1. The synced files, in their folders. Click a folder to open or close it. Deleted files are marked `(deleted)`. While you type in the search field, the list shows only the files that match, with their folders open.
2. The versions of the chosen file, newest first. **Load older versions** shows more.
3. The chosen version.

Each version in the list shows, on three lines:

1. How long ago the server received the version, for example `5 minutes ago` or `3 days ago`. To see the exact date and time, with your time zone, hold the pointer over it. The newest version is marked `(current)`.
2. What changed: edited, moved (with the place that the file was moved from), deleted or restored. The oldest version in the list is marked **Oldest kept version**. It is the version that created the file, unless the server already removed older versions (see [History](#history)).
3. Which user made it, by the name from their login or by the start of their user id, and which device: another device by its name, your own device as **this device**, or a device by the start of its id. Each name is in a box, so you can see where it starts and ends, and a device has a device icon. The box of your own device has the accent color, so a device that another person named "this device" does not look like yours.

Every member of a vault sees the names of the devices that changed its files.

Another member can choose any name. So that one name cannot pass for another, the history and the conflict view show invisible characters as `\uXXXX` (a right-to-left override shows as `\u202E`) and a backslash as `\\`. Device names longer than 64 characters end in `…`. Only the display changes.

### Compare a version with the one before

Turn on **Show changes** to see what the chosen version changed. Removed lines are red, and added lines are green. When a line was changed, not added or removed, the text that changed in it has a darker color, so you can see, for example, that words were added at its end. Long runs of unchanged lines are folded. Click a fold to show all lines. Turn on **Side by side** to see the version before on the left and the chosen version on the right. The window keeps both choices until you close Obsidian.

Changes show only for text. A very large file shows only its start, and its changes do not show.

### Copy, restore or revert a version

- **Copy** copies the text of the chosen version.
- **Restore this version** brings back the content of the chosen version. The file keeps its current name and folder. When the chosen version has the same content as the current one, there is nothing to restore, and the button does not show.
- **Revert this change** undoes only what the chosen version changed. Changes made after it stay.
  - If the version changed the content, the plugin undoes that change. If a later change touches the same lines, the plugin does not revert, and a notice says why. Then restore a version, or edit the file. A canvas or a base is merged as sync merges it, so it stays valid. The content of an image or another file that is not text cannot be reverted. Restore a version of it instead.
  - If the version moved the file, the plugin moves the file back. Links to the file follow it, as when you move the file yourself. If the file was moved again later, the later move stays. If another file is now at the old place, the plugin does not revert, and a notice says why.
  - You cannot revert a deletion or a restore. To bring back a deleted file, restore a version of it.

A restore is a new version, so the version that it replaces stays in the history. It reaches your other devices like any edit, and the file keeps its current name and folder. A local edit that did not sync yet meets the restored version like an edit from another device. A revert changes the file on this device, and the file then syncs like any edit.

Viewers can see the history, preview versions and copy them, but they cannot restore or revert. If the plugin cannot read your role, for example because the server cannot be reached, it shows the buttons, and the server decides.

### When another file uses the path

If another file now uses the file's path, the restore fails at first. Then:

1. Click **Restore at another path**. The field suggests a free path next to the old one, for example `plan (restored).md`.
2. Change the path if you want.
3. Click **Restore here**. The file comes back at that path, with its history.

If the path cannot be used, correct it in the field. You can also move the other file away and restore again.
