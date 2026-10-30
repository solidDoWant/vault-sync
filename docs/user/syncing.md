# Syncing

For: people who use the Obsidian plugin. You have [signed in and connected a vault](getting-started.md).

This page says what syncs, when it syncs, what the status shows, and which files do not sync.

## What syncs

vault-sync syncs your notes, your attachments and your folders, empty folders too.

It does not sync the vault's config folder: `.obsidian`, or the name set in **Settings → Files and links → Override config folder**. So your Obsidian settings, themes and plugins stay on each device. Config-folder sync is not part of this version.

## When it syncs

While you are signed in and a vault is connected, the plugin syncs on its own:

- When sync starts, for example when Obsidian starts. The plugin also finds changes made while Obsidian was closed.
- 2 seconds after your last edit. A burst of edits becomes one version.
- At once, when another device saves a change. The server tells the plugin over a live connection, so changes usually arrive within seconds.
- Every 30 seconds. This retries anything that failed, and brings in changes when the live connection is down.
- When you run the command **Vault Sync: Sync now**.

If a sync fails, the plugin tries again after a wait that grows with each failure, from about a second up to 5 minutes.

## Offline use

You can work offline. The status shows `offline`, and your edits sync when the device is back online. Nothing that you saved is lost when sync stops: when you sign out, disable the plugin, quit, or Obsidian crashes, the next sync finds the change.

## Renames, moves and deletes

- A renamed or moved file stays the same note on every device, with its history. This is also true when only the letter case changes.
- A rename made while Obsidian is closed counts as a rename only if the content did not change and no other file has the same content.
- A file that you create where a deleted note was is a new note, with a new history.
- If you edit a note, or rename it, and another device deletes it, the note comes back, with your name for it and your edit.
- If two devices rename the same note, the name that reached the server first wins. The content of the two versions is combined.
- Folder changes sync too. A deleted folder comes back only if another device kept or edited a file in it.
- If another device puts a note at a path where this device has a file, the plugin keeps your file. If the content is the same, the file becomes that note. If not, your file gets a conflict-copy name. vault-sync renames files to make room. It never deletes them.

A delete does not erase the file's history on the server. The server keeps the record that the file was deleted, and its earlier versions for some time (see [Conflicts and history](conflicts-and-history.md#history)).

## The status

On a desktop, the status bar shows the sync status. On a phone, an icon in the ribbon shows it: a check mark when everything is synced, a cloud with an arrow while changes wait to be pushed, a warning triangle while there are conflict copies, and its own icon for each other state. For details, click the status bar, tap the icon, or run **Vault Sync: Show sync status**.

| Status | What it means |
|---|---|
| `starting` | Sync is starting. |
| `waiting for another window` | Another Obsidian window with this vault open runs an older Vault Sync. |
| `idle` | The last sync worked. |
| `syncing` | A sync runs now. |
| `offline` | The plugin cannot reach the server or the login service. |
| `error` | The last sync failed for another reason, or the server does not accept the names of some files. The details give the reason and the file. |
| `sign-in needed` | Your session ended. Sign in again. |
| `signed out` / `no vault connected` | Sync is off until you sign in and connect a vault. |
| `no longer a member` | You left the connected vault, or an owner removed you. |
| `vault deleted` | An owner deleted the connected vault. |
| `stopped: key data doesn't verify` | The server sent encryption data that the plugin cannot trust. |
| `device removed` | Another of your devices removed this device. |

After the status, `N pending` counts your changes that the server did not confirm yet. `N conflicts` counts the conflict copies this device made that still exist.

[Troubleshooting](troubleshooting.md) says what to do for each state that needs you to act.

## Files that do not sync

Some files cannot sync. The conflict view lists them, each with the reason (run **Vault Sync: Show conflicts**). The rest of the vault syncs normally.

### Files that stay on this device only

These local files are not uploaded. The view lists them under **files that are not synced**:

- **A file that is too large.** The size limit is 1 GiB on a desktop and 256 MiB on a phone or tablet. The server can have a smaller limit. A smaller version of the file syncs.
- **A file whose name the server refuses.** File names must work on every platform. A file or folder name must not:
  - contain `< > : " / \ | ? *` or a control character
  - start or end with a space, or end in a dot
  - be a Windows reserved name: `CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, with or without an extension
  - be longer than 255 bytes.

  The whole path must not be longer than 1024 bytes. A name that differs from an existing note's name only by letter case is refused too. The status shows `error` and names the file, or the first of several. The plugin does not try again until you rename the file. Rename or move it to a valid name and it syncs.

### Files that are not on this device

These files sync, but this device cannot hold them. They stay on the server and on your other devices. The view lists them under **files not on this device**:

- A file larger than this device's size limit. A smaller version, saved on another device, arrives as usual.
- A file whose path does not work on this device. For example, Windows allows 260 characters, including the vault folder, unless long paths are on. A name longer than 255 bytes also does not work.
- A file whose name ends in `.vault-sync-tmp` or `.vault-sync-new`, the names of vault-sync's own temporary files.

To get such a file onto this device, rename it on another device.

When a file joins this list, a notice names it once each time Obsidian starts.

A path longer than 200 characters gets a warning, because Windows devices can fail to store it. The file still syncs.

## Upgrades

You cannot go back to an older version of the plugin. After some upgrades, the first sync compares the whole vault with the server again. If a file is different, yours is kept as a conflict copy.

Your admin sets the server's own size limit. For the server's side, see [the server configuration](../configuration.md).
