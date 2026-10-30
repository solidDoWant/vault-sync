# Troubleshooting

For: people who use the Obsidian plugin. You know where the [sync status](syncing.md#the-status) shows.

Find the status or the message that you see. In every case, your files and changes stay on your device. To see the full message, click the status bar, tap the status icon, or run **Vault Sync: Show sync status**.

## offline

"Cannot reach the server. Local changes are kept and pushed once it is reachable again."

The plugin cannot reach the server or your organization's login service, or one of them did not answer within 30 seconds. Large file transfers get more time.

Make sure that the device is online and that **Server URL** is correct. The plugin tries again on its own. If the status stays `offline` while other sites work, ask your admin.

## sign-in needed

"Your session ended. Sync is paused until you sign in again; local changes are kept and pushed afterwards."

Your organization's login ended your session, or the device's stored sign-in was cleared. Click **Sign in again** in the settings. Sync continues and pushes your waiting changes.

## signed out / no vault connected

Sync is off. Click **Sign in**, then connect a vault (see [Getting started](getting-started.md)).

## waiting for another window

Another Obsidian window has this vault open and runs an older version of Vault Sync. Close that window, or update Vault Sync there.

## error

"Sync failed. Local changes are kept and pushed by a later sync."

The plugin tries again on its own. The second line of the message gives the reason. The common ones:

| Message or reason | What to do |
|---|---|
| A file name that the server refuses | Rename or move the file to a valid name. [Syncing](syncing.md#files-that-stay-on-this-device-only) lists the rules. The conflict view lists every such file. |
| The account reached the server's device limit | On another device, remove a device that you no longer use (see [Devices](devices.md#remove-a-device)). |
| The server refuses the device name | Change **Device name** in the settings. |
| Too many requests from your account at once | Wait. This happens when many of your devices sync at the same moment. The plugin tries again. |
| The login service answers with something that is not valid | Tell your admin. The login service is set up wrong. |
| "The passphrase is wrong." | Enter the right passphrase. After 10 wrong tries in an hour, wait until the time that the dialog shows. |

If the message names the OIDC issuer or client ID, ask your admin. Usually you leave **Advanced → OIDC issuer URL** and **OIDC client ID** empty. To change them, sign out first.

## device removed

"This device was removed from your account, so it cannot sync."

Someone removed this device in the device list on another of your devices. If that was a mistake, click **Register again** in the settings. The device registers as a new device and pushes your waiting changes. See [Devices](devices.md#when-this-device-was-removed).

## no longer a member

An owner removed you from the connected vault, or you left it. Sync of the vault stops.

- To stop here, click **Disconnect** in the settings. Your files stay.
- To come back, ask an owner for a new invitation. After you join, disconnect and connect the vault again, or restart Obsidian.

## vault deleted

An owner deleted the connected vault. Sync of the vault stops. Click **Disconnect**. Your files stay. For 30 days, your admin can restore the vault. Ask an owner or your admin.

## stopped: key data doesn't verify

In an encrypted vault, the server sent key or member data that the plugin cannot trust. For example, a key or a member that no owner added. Sync of that vault stops, and the plugin never trusts the server instead. Your files stay.

1. Read the details, which say what failed.
2. Tell your admin and the vault's owners.
3. Restart Obsidian to check again.

## Conflict copies

`N conflicts` after the status means that conflict copies wait for you. Run **Vault Sync: Show conflicts** (see [Conflicts and history](conflicts-and-history.md#resolve-a-conflict-copy)).

## A file is missing on one device

The file is too large for this device, or its name does not work on this device. Run **Vault Sync: Show conflicts** and look under **files not on this device** (see [Syncing](syncing.md#files-that-are-not-on-this-device)).

## A note is read-only

You are a viewer in this vault. Ask an owner to make you an editor (see [Sharing](sharing.md#as-a-viewer)).

## "End-to-end encrypted vaults cannot be synced yet."

This version cannot sync encrypted vaults. Connect a plaintext vault.

## Encryption shows "Key changed"

The server has a different key for your account than this device has. Click **Unlock** and enter the passphrase of the key on the server (see [Encryption](encryption.md#key-changed)).
